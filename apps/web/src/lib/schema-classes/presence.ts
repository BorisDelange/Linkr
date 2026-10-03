import type { RelationSpec, RelationTable, SchemaMapping } from '@/types/schema-mapping'
import { tableListHas } from '@/lib/schema-helpers'
import { CLASS_CONTRACTS, type ColumnKind } from './contracts'
import { classRelations, type ClassRelation } from './relations'
import { specEntries } from './spec'

/**
 * A mapping's relations as they can run on a database that lacks some of the
 * tables they read. A schema names every table of its model, but a database
 * rarely has them all — an OMOP export without `device_exposure`, say — and SQL
 * cannot name a table that does not exist, even in a branch that would read
 * nothing. So, per relation, against the tables the database does have:
 *
 * - a LEFT JOIN on a missing table is dropped, and the fields it fed read NULL;
 * - a missing grain table (`from`), an INNER JOIN on a missing table, or a
 *   filter naming a dropped alias makes the relation EMPTY: the same columns,
 *   no rows. Its name stays, so every query built from the mapping still binds
 *   and simply reads nothing from it.
 *
 * Relations written in SQL name no table the app can see and are left as they are.
 */

export interface AbsentRelation {
  specKey: string
  /** Missing tables, as `schema.table` or `table`. */
  tables: string[]
  /** Nothing left to read: the relation is empty, not just missing a join. */
  empty: boolean
}

interface Presence {
  relations: ClassRelation[]
  absent: AbsentRelation[]
}

const cache = new WeakMap<SchemaMapping, Map<string, Presence>>()

const tableName = (t: RelationTable) => (t.schema ? `${t.schema}.${t.table}` : t.table)

function aliasIn(sql: string | undefined, alias: string): boolean {
  if (!sql?.trim()) return false
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w"])"?${escaped}"?\\s*\\.`, 'i').test(sql)
}

function presence(mapping: SchemaMapping, tables: readonly string[]): Presence {
  let byTables = cache.get(mapping)
  if (!byTables) {
    byTables = new Map()
    cache.set(mapping, byTables)
  }
  const key = [...tables].map((t) => t.toLowerCase()).sort().join('\n')
  const hit = byTables.get(key)
  if (hit) return hit

  const absent: AbsentRelation[] = []
  const pruned = new Map<RelationSpec, RelationSpec>()
  for (const { specKey, spec } of specEntries(mapping)) {
    if (spec.customSql?.trim() || !spec.from?.table) continue
    const missingFrom = !tableListHas(tables, spec.from)
    const missingJoins = (spec.joins ?? []).filter((j) => j.table && !tableListHas(tables, j))
    if (!missingFrom && missingJoins.length === 0) continue
    const empty = missingFrom
      || missingJoins.some((j) => j.type === 'inner' || aliasIn(spec.where, j.alias))
    absent.push({ specKey, tables: [...(missingFrom ? [spec.from] : []), ...missingJoins].map(tableName), empty })
    if (!empty) pruned.set(spec, { ...spec, joins: (spec.joins ?? []).filter((j) => !missingJoins.includes(j)) })
  }

  let relations = classRelations(mapping)
  if (absent.length > 0) {
    const empty = new Set(absent.filter((a) => a.empty).map((a) => a.specKey))
    // Same specs in the same order: the relation names come out the same.
    const source = pruned.size ? withSpecs(mapping, pruned) : mapping
    relations = classRelations(source).map((r) => (empty.has(r.specKey) ? { ...r, sql: emptyRelationSql(r) } : r))
  }
  const out = { relations, absent }
  byTables.set(key, out)
  return out
}

function withSpecs(mapping: SchemaMapping, replace: ReadonlyMap<RelationSpec, RelationSpec>): SchemaMapping {
  const swap = <T extends RelationSpec>(s: T | undefined): T | undefined => (s && (replace.get(s) as T | undefined)) ?? s
  return {
    ...mapping,
    patient: swap(mapping.patient),
    visit: swap(mapping.visit),
    visitDetail: swap(mapping.visitDetail),
    note: swap(mapping.note),
    concepts: mapping.concepts?.map((s) => swap(s)!),
    events: mapping.events?.map((s) => swap(s)!),
    drugs: mapping.drugs?.map((s) => swap(s)!),
  }
}

const SQL_TYPES: Record<ColumnKind, string> = {
  id: 'BIGINT',
  datetime: 'TIMESTAMP',
  date: 'DATE',
  number: 'DOUBLE',
  text: 'VARCHAR',
  boolean: 'BOOLEAN',
}

/** The relation's columns, typed, with no row. */
export function emptyRelationSql(rel: ClassRelation): string {
  const cols = CLASS_CONTRACTS[rel.cls].map((c) => `CAST(NULL AS ${SQL_TYPES[c.kind]}) AS ${c.name}`)
  for (const extra of Object.values(rel.extras ?? {})) cols.push(`CAST(NULL AS VARCHAR) AS ${extra}`)
  return `SELECT\n${cols.join(',\n')}\nWHERE false`
}

/** Every relation of the mapping, as it runs on a database holding `tables`. */
export function relationsPresentIn(mapping: SchemaMapping, tables: readonly string[]): ClassRelation[] {
  return presence(mapping, tables).relations
}

/** The relations reading a table the database does not have. */
export function absentRelations(mapping: SchemaMapping, tables: readonly string[]): AbsentRelation[] {
  return presence(mapping, tables).absent
}
