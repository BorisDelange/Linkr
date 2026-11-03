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
import { fieldColumn, fieldRef, specEntries } from '@/lib/schema-classes/spec'
import type { Cohort, CohortLevel, RelationSpec, SchemaMapping } from '@/types'

/** The database's own column names (lower case) that carry each id, and which
 *  wider sets of kept ids the mapping can list (the server's `keyed_levels`). */
export interface NativeIdColumns {
  patient: Set<string>
  visit: Set<string>
  visitDetail: Set<string>
  /** The stays' table names their id and their patient as plain columns. */
  visitsListed: boolean
  /** The unit stays' table names their id and their stay as plain columns. */
  unitStaysListed: boolean
  /** …and their patient. */
  unitStayPatient: boolean
}

export function nativeIdColumns(mapping: SchemaMapping): NativeIdColumns {
  const out: NativeIdColumns = {
    patient: new Set(), visit: new Set(), visitDetail: new Set(),
    visitsListed: false, unitStaysListed: false, unitStayPatient: false,
  }
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
  const direct = (spec: RelationSpec | undefined, field: string) => {
    const c = fieldColumn(spec, field)
    return !!c && !spec?.customSql?.trim() && c.table.alias === spec?.from?.alias
  }
  out.visitsListed = direct(mapping.visit, 'visit_id') && direct(mapping.visit, 'patient_id')
  out.unitStaysListed = direct(mapping.visitDetail, 'visit_detail_id') && direct(mapping.visitDetail, 'visit_id')
  out.unitStayPatient = out.unitStaysListed && direct(mapping.visitDetail, 'patient_id')
  return out
}

/** How a table is filtered: on the kept patients, stays or unit stays — at the
 *  unit-stay level, a stay id keeps the parent stays of its unit stays. */
export type TableFilterKind = 'visit_detail' | 'visit' | 'parent_visit' | 'patient'

export interface TableFilter {
  kind: TableFilterKind
  column: string
}

type Level = Exclude<CohortLevel, 'event'>
type IdLevel = 'patient' | 'visit' | 'visit_detail'

// Best first: the level's own id, then a finer one, then a coarser one.
const ORDER: Record<Level, IdLevel[]> = {
  patient: ['patient', 'visit', 'visit_detail'],
  visit: ['visit', 'visit_detail', 'patient'],
  visit_detail: ['visit_detail', 'visit', 'patient'],
}

/** The levels whose kept ids can be listed at `level`. */
function keyedLevels(ids: NativeIdColumns, level: Level): Set<IdLevel> {
  const out = new Set<IdLevel>(['patient'])
  const visit = level === 'patient' ? ids.visitsListed : level === 'visit' ? true : ids.unitStaysListed
  if (visit) out.add('visit')
  if (level === 'visit_detail' || (ids.unitStaysListed && (visit || (level === 'patient' && ids.unitStayPatient)))) out.add('visit_detail')
  return out
}

/**
 * The id the table carries that fits the cohort's level best: its own, then a
 * finer one (the unit stays of the cohort's stays), then a coarser one (its
 * patients). Null: the table carries no id that can be filtered on (a
 * vocabulary), and is not filtered.
 */
export function classifyTable(columns: string[], level: Level, ids: NativeIdColumns): TableFilter | null {
  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]))
  const sets: Record<IdLevel, Set<string>> = { patient: ids.patient, visit: ids.visit, visit_detail: ids.visitDetail }
  const keyed = keyedLevels(ids, level)
  for (const idLevel of ORDER[level]) {
    if (!keyed.has(idLevel)) continue
    const column = [...sets[idLevel]].sort().map((n) => byLower.get(n)).find(Boolean)
    if (column) return { kind: idLevel === 'visit' && level === 'visit_detail' ? 'parent_visit' : idLevel, column }
  }
  return null
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

/** The keys a table of `kind` is matched on, from the members `m` at `level`. */
function keysSql(mapping: SchemaMapping, kind: TableFilterKind, level: Level): string | null {
  if (kind === 'patient') return 'SELECT DISTINCT patient_id AS key FROM m'
  if (kind === level) return 'SELECT DISTINCT id AS key FROM m'
  const v = classRelation(mapping, 'visit')
  const vd = classRelation(mapping, 'visit_detail')
  if (kind === 'parent_visit') {
    return vd ? `SELECT DISTINCT ${vd.name}.visit_id AS key FROM ${vd.name} WHERE ${vd.name}.visit_detail_id IN (SELECT id FROM m)` : null
  }
  // A wider level: the stays of the cohort's patients, the unit stays of its stays.
  const visitsOfPatients = v ? `SELECT DISTINCT ${v.name}.visit_id AS key FROM ${v.name} WHERE ${v.name}.patient_id IN (SELECT patient_id FROM m)` : null
  if (kind === 'visit') return visitsOfPatients
  if (!vd) return null
  if (level === 'visit') return `SELECT DISTINCT ${vd.name}.visit_detail_id AS key FROM ${vd.name} WHERE ${vd.name}.visit_id IN (SELECT id FROM m)`
  if (nativeIdColumns(mapping).unitStayPatient) {
    return `SELECT DISTINCT ${vd.name}.visit_detail_id AS key FROM ${vd.name} WHERE ${vd.name}.patient_id IN (SELECT patient_id FROM m)`
  }
  return visitsOfPatients
    ? `SELECT DISTINCT ${vd.name}.visit_detail_id AS key FROM ${vd.name} WHERE ${vd.name}.visit_id IN (${visitsOfPatients})`
    : null
}

/** `WITH` clauses naming the cohort's members (`m`) and the keys a table is
 *  matched on (`k.key`). */
function keysCte(cohort: Cohort, mapping: SchemaMapping, filter: TableFilter, narrowing?: RelationNarrowing): string | null {
  const membership = buildCohortMembershipSql(cohort, mapping, narrowing)
  if (cohort.level === 'event') return null
  const keys = keysSql(mapping, filter.kind, cohort.level)
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
    return filter && keysSql(mapping, filter.kind, level) ? [{ ...t, filter }] : []
  })
  if (filtered.length === 0) return null
  const kinds = [...new Set(filtered.map((t) => t.filter.kind))]
  const keyName = (kind: TableFilterKind) => `k_${kind}`
  const ctes = [
    `m AS MATERIALIZED ${subquerySql(membership)}`,
    ...kinds.map((kind) => `${keyName(kind)} AS ${subquerySql(keysSql(mapping, kind, level)!)}`),
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
