/**
 * A query on the `linkr_*` relations, rewritten on the database's own tables:
 * what a person who knows their schema reads and edits, and what then runs,
 * with no relation in between.
 *
 * Each relation read from a FROM or a JOIN is replaced by what it stands for
 * (`inlineRelation`): a relation that is one table becomes that table, each of
 * its columns the expression it maps (`vd.visit_detail_id` → `vd.transfer_id`);
 * anything more — joins, a filter, hand-written SQL — becomes its SELECT, as a
 * subquery in the same place, which returns the same rows.
 *
 * Written for the SQL the cohort builder generates, whose every column is
 * qualified by its relation or its alias. A column is resolved the way SQL
 * does: to the nearest enclosing parenthesis group whose FROM names that alias
 * (two EXISTS may both call their event table `e`). Anything left unresolved
 * makes the whole translation null rather than half-translated.
 */
import { quoteIdent } from '@/lib/format-helpers'
import type { SchemaMapping } from '@/types/schema-mapping'
import { RELATION_PREFIX } from './contracts'
import { blankSqlLiterals, inlineRelation, type InlineRelation } from './relations'

/** A relation in a FROM or a JOIN: `linkr_x` or `linkr_x alias`. */
const FROM_ITEM = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(${RELATION_PREFIX}[A-Za-z0-9_]+)\\b(?:(\\s+)(?!(?:ON|WHERE|INNER|LEFT|RIGHT|FULL|CROSS|JOIN|GROUP|ORDER|LIMIT|UNION|USING|AS)\\b)([A-Za-z_]\\w*))?`,
  'gi',
)

/** `alias.column`, not part of a longer dotted or quoted name. */
const QUALIFIED = /(?<![\w."])([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g

const PLAIN_IDENT = /^[a-z_][a-z0-9_]*$/

/** `"hosp"."transfers"`, or `hosp.transfers` when neither part needs quotes. */
function tableRef(t: { schema?: string; table: string }): string {
  const part = (name: string) => (PLAIN_IDENT.test(name) ? name : quoteIdent(name))
  return t.schema ? `${part(t.schema)}.${part(t.table)}` : part(t.table)
}

/** `alias."col"` → `alias.col` where the quotes add nothing. */
function unquoteRefs(expr: string): string {
  return expr.replace(/([A-Za-z_]\w*)\."([a-z_][a-z0-9_]*)"/g, '$1.$2')
}

/** `expr` with its `from.` qualifiers renamed `to.`, outside string literals. */
function realias(expr: string, from: string, to: string): string {
  if (from.toLowerCase() === to.toLowerCase()) return expr
  const blanked = blankSqlLiterals(expr)
  let out = ''
  let last = 0
  for (const m of blanked.matchAll(new RegExp(`(?<![\\w."])${from}(?=\\s*\\.)`, 'gi'))) {
    out += expr.slice(last, m.index) + to
    last = m.index + m[0].length
  }
  return out + expr.slice(last)
}

/** Whether `expr` is one parenthesised block already, `(a - b)` but not `(a) - (b)`. */
function wrapped(expr: string): boolean {
  if (!expr.startsWith('(') || !expr.endsWith(')')) return false
  const blanked = blankSqlLiterals(expr)
  let depth = 0
  for (let i = 0; i < blanked.length; i++) {
    if (blanked[i] === '(') depth++
    else if (blanked[i] === ')' && --depth === 0) return i === blanked.length - 1
  }
  return false
}

interface FromItem {
  start: number
  end: number
  relation: string
  /** How the query calls it: its alias, or its own name when it has none. */
  alias: string
  explicitAlias: boolean
  /** The paren group it is declared in, `[open, close]`; the root is `[-1, length]`. */
  scope: [number, number]
}

/** Every paren group of `blanked`, as [open, close] positions. */
function parenGroups(blanked: string): [number, number][] {
  const groups: [number, number][] = []
  const stack: number[] = []
  for (let i = 0; i < blanked.length; i++) {
    if (blanked[i] === '(') stack.push(i)
    else if (blanked[i] === ')' && stack.length) groups.push([stack.pop()!, i])
  }
  return groups
}

/** The groups containing `pos`, innermost first, ending with the root. */
function enclosing(groups: [number, number][], pos: number, length: number): [number, number][] {
  return [...groups.filter(([a, b]) => a < pos && pos < b).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0])), [-1, length]]
}

const sameScope = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1]

/** Whether `sql` still names a relation, outside literals and comments: a
 *  reference the translation could not follow. */
export function namesRelation(sql: string): boolean {
  return new RegExp(`(?<![\\w."])${RELATION_PREFIX}`, 'i').test(blankSqlLiterals(sql))
}

export function toNativeSql(sql: string, mapping: SchemaMapping): string | null {
  const blanked = blankSqlLiterals(sql)
  const groups = parenGroups(blanked)

  const items: FromItem[] = []
  for (const m of blanked.matchAll(FROM_ITEM)) {
    const relation = m[1].toLowerCase()
    const relStart = m.index + m[0].indexOf(m[1])
    items.push({
      start: relStart,
      end: m.index + m[0].length,
      relation,
      alias: m[3] ?? m[1],
      explicitAlias: !!m[3],
      scope: enclosing(groups, relStart, sql.length)[0],
    })
  }

  // Every qualified column, resolved to the FROM item it reads — the nearest
  // enclosing group whose FROM calls something by that name.
  const refs: { start: number; end: number; item: FromItem; column: string }[] = []
  for (const m of blanked.matchAll(QUALIFIED)) {
    const [whole, qualifier, column] = m
    const pos = m.index
    if (items.some((i) => pos >= i.start && pos < i.end)) continue
    let item: FromItem | undefined
    for (const scope of enclosing(groups, pos, sql.length)) {
      item = items.find((i) => sameScope(i.scope, scope) && i.alias.toLowerCase() === qualifier.toLowerCase())
      if (item) break
    }
    if (item) refs.push({ start: pos, end: pos + whole.length, item, column: column.toLowerCase() })
    else if (qualifier.toLowerCase().startsWith(RELATION_PREFIX)) return null
  }

  const used = new Map<string, Set<string>>()
  for (const { item, column } of refs) {
    if (!used.has(item.relation)) used.set(item.relation, new Set())
    used.get(item.relation)!.add(column)
  }
  const inlines = new Map<string, InlineRelation>()
  for (const { relation } of items) {
    if (inlines.has(relation)) continue
    const inline = inlineRelation(mapping, relation, used.get(relation) ?? new Set())
    if (!inline) return null
    inlines.set(relation, inline)
  }

  // A relation read under its own name gets a short alias: its table's alias in
  // the mapping (`vd`), unless the query already uses that name.
  const taken = new Set(items.filter((i) => i.explicitAlias).map((i) => i.alias.toLowerCase()))
  const bareAlias = new Map<string, string>()
  for (const item of items) {
    if (item.explicitAlias || bareAlias.has(item.relation)) continue
    const inline = inlines.get(item.relation)!
    const base = inline.kind === 'table' ? inline.table.alias : item.relation.slice(RELATION_PREFIX.length)
    let alias = base
    for (let n = 2; taken.has(alias.toLowerCase()); n++) alias = `${base}${n}`
    taken.add(alias.toLowerCase())
    bareAlias.set(item.relation, alias)
  }
  const newAlias = (item: FromItem) => (item.explicitAlias ? item.alias : bareAlias.get(item.relation)!)

  const edits: { start: number; end: number; text: string }[] = []
  for (const item of items) {
    const inline = inlines.get(item.relation)!
    const source = inline.kind === 'table'
      ? tableRef(inline.table)
      // As written: indenting it would change a multi-line string literal.
      : `(\n${inline.sql}\n)`
    edits.push({ start: item.start, end: item.end, text: `${source} ${newAlias(item)}` })
  }
  for (const { start, end, item, column } of refs) {
    const inline = inlines.get(item.relation)!
    const alias = newAlias(item)
    let text: string
    if (inline.kind === 'subquery') text = `${alias}.${column}`
    else {
      if (!(column in inline.columns)) return null
      const expr = inline.columns[column]
      if (!expr) text = 'NULL'
      else {
        const moved = unquoteRefs(realias(expr, inline.table.alias, alias))
        text = /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(moved) || wrapped(moved) ? moved : `(${moved})`
      }
    }
    edits.push({ start, end, text })
  }

  let out = sql
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return namesRelation(out) ? null : out
}
