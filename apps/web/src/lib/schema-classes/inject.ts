import type { SchemaMapping } from '@/types/schema-mapping'
import { isProtected, protectedRegions, splitSqlStatements } from '@/lib/duckdb/sql-tokenizer'
import { RELATION_PREFIX } from './contracts'
import { classRelations, type ClassRelation } from './relations'
import { relationsPresentIn } from './presence'

// Matches a relation name used as an identifier: `linkr_visit`, `linkr_event_lab_events`.
const RELATION_REF = new RegExp(`(?<![\\w.])${RELATION_PREFIX}[a-z0-9_]+(?!\\w)`, 'gi')

const QUOTED_RELATION = new RegExp(`^"(${RELATION_PREFIX}[a-z0-9_]+)"$`, 'i')

/** Relation names a statement references, bare or as a quoted identifier — never
 *  inside a string literal or a comment. */
export function referencedRelations(sql: string): Set<string> {
  const regions = protectedRegions(sql)
  const names = new Set<string>()
  for (const m of sql.matchAll(RELATION_REF)) {
    if (!isProtected(regions, m.index)) names.add(m[0].toLowerCase())
  }
  for (const r of regions) {
    const quoted = QUOTED_RELATION.exec(sql.slice(r.start, r.end))
    if (quoted) names.add(quoted[1].toLowerCase())
  }
  return names
}

// Matches a relation already defined as a CTE: `linkr_visit AS [NOT MATERIALIZED] (`.
const RELATION_DEFINITION = new RegExp(`(?<![\\w.])(${RELATION_PREFIX}[a-z0-9_]+)\\s+AS\\s+(?:NOT\\s+MATERIALIZED\\s+)?\\(`, 'gi')

/** Relation names the statement defines itself — already injected, or the user's own CTE. */
function definedRelations(sql: string): Set<string> {
  const regions = protectedRegions(sql)
  const names = new Set<string>()
  for (const m of sql.matchAll(RELATION_DEFINITION)) {
    if (!isProtected(regions, m.index)) names.add(m[1].toLowerCase())
  }
  return names
}

/** Index of the first character that is neither whitespace nor inside a comment. */
function firstTokenIndex(sql: string): number {
  const regions = protectedRegions(sql)
  for (let i = 0; i < sql.length; i++) {
    if (/\s/.test(sql[i])) continue
    const region = regions.find((r) => r.start <= i && i < r.end)
    if (!region) return i
    // A quoted identifier or literal is structure, not a comment: stop there.
    if (!sql.startsWith('--', region.start) && !sql.startsWith('/*', region.start)) return i
    i = region.end - 1
  }
  return sql.length
}

/**
 * The wanted relations and every relation their SQL reads in turn (a custom
 * relation may read `linkr_patient`), each after the ones it reads: a CTE can
 * only name the CTEs before it. `defined` are the statement's own, never added.
 */
function relationsInDependencyOrder(all: ClassRelation[], wanted: Set<string>, defined: Set<string>): ClassRelation[] {
  const byName = new Map(all.map((r) => [r.name, r]))
  const ordered: ClassRelation[] = []
  const done = new Set<string>()
  const path: string[] = []
  const visit = (name: string) => {
    if (done.has(name) || defined.has(name)) return
    const rel = byName.get(name)
    if (!rel) return
    if (path.includes(name)) {
      throw new Error(`Class relations read each other in a cycle: ${[...path.slice(path.indexOf(name)), name].join(' → ')}`)
    }
    path.push(name)
    for (const dep of referencedRelations(rel.sql)) visit(dep)
    path.pop()
    done.add(name)
    ordered.push(rel)
  }
  for (const rel of all) if (wanted.has(rel.name)) visit(rel.name)
  return ordered
}

/**
 * Prepend the class relations a single statement references, as non-materialised
 * CTEs. `NOT MATERIALIZED` is required, not a hint: DuckDB materialises a CTE
 * referenced twice, which stops a per-patient filter from being pushed into it
 * (measured, plan §6).
 *
 * Only a query statement (SELECT / WITH / VALUES / parenthesised) is rewritten;
 * anything else is returned untouched and fails on the unknown name. Idempotent:
 * a relation the statement already defines is not added twice.
 *
 * `tables`: the tables the database has, when known — a relation reading one it
 * lacks is injected empty or without that join (`presence.ts`).
 */
export function withClassRelations(sql: string, mapping: SchemaMapping | undefined | null, tables?: readonly string[] | null): string {
  if (!mapping || !sql.toLowerCase().includes(RELATION_PREFIX)) return sql
  const wanted = referencedRelations(sql)
  for (const name of definedRelations(sql)) wanted.delete(name)
  if (wanted.size === 0) return sql
  const relations = tables ? relationsPresentIn(mapping, tables) : classRelations(mapping)
  const ctes = relationsInDependencyOrder(relations, wanted, definedRelations(sql))
    .map((r) => `${r.name} AS NOT MATERIALIZED (\n${r.sql}\n)`)
  if (ctes.length === 0) return sql

  const start = firstTokenIndex(sql)
  const head = sql.slice(start)
  const withMatch = /^with(\s+recursive)?\s/i.exec(head)
  if (withMatch) {
    const at = start + withMatch[0].length
    return `${sql.slice(0, at)}${ctes.join(',\n')},\n${sql.slice(at)}`
  }
  if (!/^(select|values|from|\()/i.test(head)) return sql
  return `${sql.slice(0, start)}WITH ${ctes.join(',\n')}\n${head}`
}

/** Same, for a script of several statements. */
export function injectClassRelations(script: string, mapping: SchemaMapping | undefined | null, tables?: readonly string[] | null): string {
  if (!mapping || !script.toLowerCase().includes(RELATION_PREFIX)) return script
  const statements = splitSqlStatements(script)
  if (statements.length <= 1) return withClassRelations(script, mapping, tables)
  const rewritten = statements.map((s) => withClassRelations(s, mapping, tables))
  return rewritten.every((s, i) => s === statements[i]) ? script : rewritten.join(';\n')
}
