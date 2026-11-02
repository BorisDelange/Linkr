/**
 * A cohort seen through every table of its database: which rows of each table
 * belong to the cohort, the way a derivation filters them. Mirror of the
 * server's `cohort_derive.id_columns` / `classify` — change one, change both,
 * or the Tables tab shows a subset the derivation does not copy.
 */
import { quoteIdent, quoteTableRef } from '@/lib/format-helpers'
import { buildCohortMembershipSql, type RelationNarrowing } from '@/lib/duckdb/cohort-query'
import { subquerySql } from '@/lib/duckdb/sql-layout'
import { classRelation } from '@/lib/schema-classes/relations'
import { fieldRef, specEntries } from '@/lib/schema-classes/spec'
import type { Cohort, CohortLevel, SchemaMapping } from '@/types'

/** The database's own column names (lower case) that carry each id. */
export interface NativeIdColumns {
  patient: Set<string>
  visit: Set<string>
  visitDetail: Set<string>
}

export function nativeIdColumns(mapping: SchemaMapping): NativeIdColumns {
  const out: NativeIdColumns = { patient: new Set(), visit: new Set(), visitDetail: new Set() }
  const add = (set: Set<string>, field: unknown) => {
    const column = fieldRef(field as string | undefined)?.column
    if (column) set.add(column.toLowerCase())
  }
  for (const { cls, spec } of specEntries(mapping)) {
    if (cls !== 'concept') add(out.patient, spec.fields?.patient_id)
  }
  add(out.visit, mapping.visit?.fields?.visit_id)
  add(out.visit, mapping.visitDetail?.fields?.visit_id)
  add(out.visitDetail, mapping.visitDetail?.fields?.visit_detail_id)
  return out
}

/** How a table is filtered: on the cohort's own ids, on the parent stays of its
 *  unit stays, or on its patients. */
export type TableFilterKind = 'visit_detail' | 'visit' | 'parent_visit' | 'patient'

export interface TableFilter {
  kind: TableFilterKind
  column: string
}

/**
 * The finest id at or above the cohort's level wins: at unit-stay level a table
 * with a unit-stay id keeps the cohort's unit stays, one with only a stay id
 * keeps their parent stays, one with only a patient id keeps the patients.
 * Null: the table carries no id (a vocabulary), and is not filtered.
 */
export function classifyTable(columns: string[], level: Exclude<CohortLevel, 'event'>, ids: NativeIdColumns): TableFilter | null {
  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]))
  const first = (names: Set<string>) => [...names].sort().map((n) => byLower.get(n)).find(Boolean)
  if (level === 'visit_detail') {
    const vd = first(ids.visitDetail)
    if (vd) return { kind: 'visit_detail', column: vd }
    const v = first(ids.visit)
    if (v) return { kind: 'parent_visit', column: v }
  }
  if (level === 'visit') {
    const v = first(ids.visit)
    if (v) return { kind: 'visit', column: v }
  }
  const p = first(ids.patient)
  return p ? { kind: 'patient', column: p } : null
}

/** The id columns a table carries, finest first, for the distinct counts. */
export function tableIdColumns(columns: string[], ids: NativeIdColumns): { kind: 'visit_detail' | 'visit' | 'patient'; column: string }[] {
  const out: { kind: 'visit_detail' | 'visit' | 'patient'; column: string }[] = []
  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]))
  for (const [kind, set] of [['visit_detail', ids.visitDetail], ['visit', ids.visit], ['patient', ids.patient]] as const) {
    const column = [...set].sort().map((n) => byLower.get(n)).find(Boolean)
    if (column) out.push({ kind, column })
  }
  return out
}

/** The keys a table of `kind` is matched on, from the members `m`. */
function keysSql(mapping: SchemaMapping, kind: TableFilterKind): string | null {
  if (kind === 'patient') return 'SELECT DISTINCT patient_id AS key FROM m'
  if (kind === 'parent_visit') {
    const vd = classRelation(mapping, 'visit_detail')
    if (!vd) return null
    return `SELECT DISTINCT ${vd.name}.visit_id AS key FROM ${vd.name} WHERE ${vd.name}.visit_detail_id IN (SELECT id FROM m)`
  }
  return 'SELECT DISTINCT id AS key FROM m'
}

/** `WITH` clauses naming the cohort's members (`m`) and the keys a table is
 *  matched on (`k.key`). */
function keysCte(cohort: Cohort, mapping: SchemaMapping, filter: TableFilter, narrowing?: RelationNarrowing): string | null {
  const membership = buildCohortMembershipSql(cohort, mapping, narrowing)
  const keys = keysSql(mapping, filter.kind)
  if (!membership || !keys) return null
  return `WITH m AS (\n${membership}\n),\nk AS (\n  ${keys}\n)`
}

/** The distinct-id kinds a table's counts report, `all_<kind>` and `selected_<kind>`. */
const ID_KINDS = ['visit_detail', 'visit', 'patient'] as const

/** A table's counts over the keys `k`: its rows, the cohort's, and per id column
 *  the distinct ids in all and among the cohort's rows. */
function statsSelect(table: string, columns: string[], filter: TableFilter, keys: string, ids: NativeIdColumns, every: boolean): string {
  const carried = new Map(tableIdColumns(columns, ids).map((c) => [c.kind, c.column]))
  const distinct = ID_KINDS.filter((kind) => every || carried.has(kind)).flatMap((kind) => {
    const column = carried.get(kind)
    return column
      ? [
          `COUNT(DISTINCT t.${quoteIdent(column)}) AS all_${kind}`,
          `COUNT(DISTINCT t.${quoteIdent(column)}) FILTER (WHERE k.key IS NOT NULL) AS selected_${kind}`,
        ]
      : [`CAST(NULL AS BIGINT) AS all_${kind}`, `CAST(NULL AS BIGINT) AS selected_${kind}`]
  })
  return [
    'SELECT',
    `  ${['COUNT(*) AS all_rows', 'COUNT(k.key) AS selected_rows', ...distinct].join(',\n  ')}`,
    `FROM ${quoteTableRef(table)} t`,
    `LEFT JOIN ${keys === 'k' ? 'k' : `${keys} k`} ON t.${quoteIdent(filter.column)} = k.key`,
  ].join('\n')
}

/**
 * One row for a table: its rows, the cohort's rows, and for each id column it
 * carries, how many distinct ids in all and among the cohort's rows
 * (`all_<kind>`, `selected_<kind>`). Null when the table is not filtered or the
 * cohort has no membership query.
 */
export function buildTableStatsSql(
  cohort: Cohort,
  mapping: SchemaMapping,
  table: string,
  columns: string[],
  narrowing?: RelationNarrowing,
): string | null {
  if (cohort.level === 'event') return null
  const ids = nativeIdColumns(mapping)
  const filter = classifyTable(columns, cohort.level, ids)
  if (!filter) return null
  const cte = keysCte(cohort, mapping, filter, narrowing)
  if (!cte) return null
  return [cte, statsSelect(table, columns, filter, 'k', ids, false)].join('\n')
}

/**
 * The counts of several tables in one query, the members computed once
 * (`MATERIALIZED`; a database the query is translated for decides by itself,
 * and computes a CTE read several times once): one row per table, named by
 * `block`, each with every count column (NULL for an id the table lacks). Null
 * when none of the tables is filtered.
 */
export function buildTablesStatsSql(
  cohort: Cohort,
  mapping: SchemaMapping,
  tables: readonly { name: string; columns: string[] }[],
  narrowing?: RelationNarrowing,
): string | null {
  if (cohort.level === 'event') return null
  const level = cohort.level
  const ids = nativeIdColumns(mapping)
  const membership = buildCohortMembershipSql(cohort, mapping, narrowing)
  if (!membership) return null
  const filtered = tables.flatMap((t) => {
    const filter = classifyTable(t.columns, level, ids)
    return filter && keysSql(mapping, filter.kind) ? [{ ...t, filter }] : []
  })
  if (filtered.length === 0) return null
  const kinds = [...new Set(filtered.map((t) => t.filter.kind))]
  const keyName = (kind: TableFilterKind) => `k_${kind}`
  const ctes = [
    `m AS MATERIALIZED ${subquerySql(membership)}`,
    ...kinds.map((kind) => `${keyName(kind)} AS ${subquerySql(keysSql(mapping, kind)!)}`),
  ]
  // Named one by one: an external database is sent no `*` in a result.
  const statColumns = ['all_rows', 'selected_rows', ...ID_KINDS.flatMap((kind) => [`all_${kind}`, `selected_${kind}`])]
  const blocks = filtered.map((t) => [
    `SELECT '${t.name.replace(/'/g, "''")}' AS block, ${statColumns.map((c) => `s.${c}`).join(', ')}`,
    `FROM ${subquerySql(statsSelect(t.name, t.columns, t.filter, keyName(t.filter.kind), ids, true))} s`,
  ].join('\n'))
  return [`WITH ${ctes.join(',\n')}`, blocks.join('\nUNION ALL\n')].join('\n')
}

/** The cohort's rows of a table, for browsing. */
export function buildTableRowsSql(
  cohort: Cohort,
  mapping: SchemaMapping,
  table: string,
  columns: string[],
  limit: number,
  narrowing?: RelationNarrowing,
): string | null {
  if (cohort.level === 'event') return null
  const filter = classifyTable(columns, cohort.level, nativeIdColumns(mapping))
  if (!filter) return `SELECT * FROM ${quoteTableRef(table)} LIMIT ${Math.floor(limit)}`
  const cte = keysCte(cohort, mapping, filter, narrowing)
  if (!cte) return null
  return [
    cte,
    'SELECT t.*',
    `FROM ${quoteTableRef(table)} t`,
    `WHERE t.${quoteIdent(filter.column)} IN (SELECT key FROM k)`,
    `LIMIT ${Math.floor(limit)}`,
  ].join('\n')
}
