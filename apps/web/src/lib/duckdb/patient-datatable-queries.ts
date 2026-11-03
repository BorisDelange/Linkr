/**
 * The Data table widget's SQL: one patient's chosen concepts over a time window
 * cut in equal columns, one aggregate of each concept's values per column, with
 * how many events it summarises — a flowsheet, as a patient record shows one.
 *
 * Every event table that may hold the concepts gives one branch, searched for
 * the concepts the concept count found there only (`held`), like the timeline.
 * The aggregates are computed by the database, so a column over a year of
 * monitoring costs one row, never the year's events.
 */
import type { SchemaMapping } from '@/types/schema-mapping'
import { conceptJoinOn, dictionaryOf, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { escSql, validateIntegerIds } from '@/lib/format-helpers'
import { eventScopeCondition, type PatientScope } from './patient-scope'
import { bucketExpr, timestamp } from './patient-overview-queries'
import { hang, idListSql, indent, sqlComment } from './sql-layout'

export const DATATABLE_AGGREGATES = ['mean', 'median', 'min', 'max', 'sum', 'count', 'first', 'last'] as const
export type DataTableAggregate = (typeof DATATABLE_AGGREGATES)[number]

/** The SQL of each aggregate over a column's values; first and last are read by row. */
const AGGREGATE_SQL: Record<Exclude<DataTableAggregate, 'first' | 'last'>, string> = {
  mean: 'AVG(e.value_number)',
  median: 'MEDIAN(e.value_number)',
  min: 'MIN(e.value_number)',
  max: 'MAX(e.value_number)',
  sum: 'SUM(e.value_number)',
  count: 'COUNT(*)',
}

interface Options {
  /** The window, ISO; events from `from` up to `to` excluded. */
  from: string
  to: string
  columns: number
  aggregate: DataTableAggregate
  /** Which of the concepts each event relation holds (`relationsHoldingConcepts`):
   *  a relation absent is searched for every concept. */
  held?: ReadonlyMap<string, ReadonlySet<number>>
  /** What a concept is, written after its id. */
  label?: (id: number) => string | undefined
}

/** One branch's source: the relation, its concept match, and the concept id to
 *  report a row under (the source concept's when that is what matched). */
function branchSource(mapping: SchemaMapping, event: ClassRelation, ids: number[], label?: (id: number) => string | undefined) {
  const list = idListSql(ids, label)
  const dict = dictionaryOf(mapping, event)
  // An event keyed by (terminology, code) is matched through the dictionary rows
  // of the chosen concepts — a handful — as the timeline does.
  if (dict && event.compositeConceptKey) {
    return {
      from: `${event.name} e
INNER JOIN (
  SELECT concept_terminology, concept_code, MIN(concept_id) AS concept_id
  FROM ${dict.name}
  WHERE concept_id IN ${hang(list)}
  GROUP BY concept_terminology, concept_code
) c ON ${conceptJoinOn(event, 'e', 'c')}`,
      match: null,
      conceptId: 'c.concept_id',
    }
  }
  const withSource = has(event, 'source_concept_id')
  return {
    from: `${event.name} e`,
    match: withSource ? `e.concept_id IN ${list}\nOR e.source_concept_id IN ${list}` : `e.concept_id IN ${list}`,
    conceptId: withSource ? `CASE WHEN e.concept_id IN ${hang(list, '    ')} THEN e.concept_id ELSE e.source_concept_id END` : 'e.concept_id',
  }
}

/** The event relations a concept list can be read from, and the ids to read in each. */
function branches(mapping: SchemaMapping, conceptIds: number[], held: Options['held']) {
  const out: { event: ClassRelation; ids: number[] }[] = []
  const notSearched: string[] = []
  for (const event of eventRelations(mapping)) {
    if (!has(event, 'patient_id') || !has(event, 'start_datetime')) continue
    // A table naming its concept inline holds text, not ids (see buildTimelineQuery).
    if (event.dictionary === null) continue
    const holds = held?.get(event.name)
    const ids = holds ? conceptIds.filter((id) => holds.has(id)) : conceptIds
    if (ids.length === 0) notSearched.push(event.name)
    else out.push({ event, ids })
  }
  return { out, notSearched }
}

function header(title: string, notSearched: string[]): string {
  return [
    sqlComment(title),
    ...(notSearched.length
      ? [sqlComment('Not searched, as the concept count found none of these concepts there:'), ...notSearched.map((n) => sqlComment(`  ${n}`))]
      : []),
  ].join('\n')
}

/**
 * One row per (concept, column) holding events: `concept_id`, `col` (0 to
 * columns − 1), `value` (the aggregate; for first and last the value of that
 * event, `text` its text value), `n` (the events summarised) and `unit`.
 */
export function buildDataTableQuery(
  mapping: SchemaMapping,
  conceptIds: number[],
  patientId: string,
  scope: PatientScope,
  opts: Options,
): string | null {
  if (conceptIds.length === 0 || !validateIntegerIds(conceptIds)) return null
  const columns = Math.max(1, Math.min(200, Math.floor(opts.columns)))
  const { out, notSearched } = branches(mapping, conceptIds, opts.held)
  const parts: string[] = []
  for (const { event, ids } of out) {
    const src = branchSource(mapping, event, ids, opts.label)
    const col = bucketExpr('e.start_datetime', opts.from, opts.to, columns)
    const scoped = branchWhere(mapping, event, src.match, patientId, scope, opts)
    const numeric = has(event, 'value_number')
    const unit = has(event, 'unit') ? 'e.unit' : 'NULL'
    if (opts.aggregate === 'first' || opts.aggregate === 'last') {
      const order = opts.aggregate === 'last' ? 'DESC' : 'ASC'
      parts.push(`${sqlComment(event.name)}
SELECT x.concept_id, x.col, x.value, x.text, x.n, x.unit
FROM (
  SELECT
    ${src.conceptId} AS concept_id,
    ${col} AS col,
    ${numeric ? 'e.value_number' : 'NULL'} AS value,
    ${has(event, 'value_string') ? 'CAST(e.value_string AS VARCHAR)' : 'NULL'} AS text,
    ${unit === 'NULL' ? 'NULL' : `CAST(${unit} AS VARCHAR)`} AS unit,
    COUNT(*) OVER (PARTITION BY ${src.conceptId}, ${col}) AS n,
    ROW_NUMBER() OVER (PARTITION BY ${src.conceptId}, ${col} ORDER BY e.start_datetime ${order}) AS rn
  FROM ${src.from.replace(/\n/g, '\n  ')}
  WHERE
    ${scoped.replace(/\n {2}/g, '\n    ')}
) x
WHERE x.rn = 1`)
      continue
    }
    // An aggregate of values on a table that has none: only the count says anything.
    if (!numeric && opts.aggregate !== 'count') continue
    parts.push(`${sqlComment(event.name)}
SELECT
  ${src.conceptId} AS concept_id,
  ${col} AS col,
  ${AGGREGATE_SQL[opts.aggregate]} AS value,
  NULL AS text,
  COUNT(*) AS n,
  ${unit === 'NULL' ? 'NULL' : `MAX(CAST(${unit} AS VARCHAR))`} AS unit
FROM ${src.from}
WHERE
  ${scoped}
GROUP BY 1, 2`)
  }
  if (parts.length === 0) return null
  return `${header(`The chosen concepts in ${columns} columns, the ${opts.aggregate} of each`, notSearched)}
${parts.join('\nUNION ALL\n')}`
}

/** One branch's WHERE: the patient, an optional window, the concepts, the scope. */
function branchWhere(mapping: SchemaMapping, event: ClassRelation, match: string | null, patientId: string, scope: PatientScope, window?: { from: string; to: string }): string {
  const where = [
    `e.patient_id = '${escSql(patientId)}'`,
    ...(window ? [`e.start_datetime >= ${timestamp(window.from)}`, `e.start_datetime < ${timestamp(window.to)}`] : []),
    ...(match ? [`(\n${indent(match)}\n)`] : []),
  ].join('\n  AND ')
  return `${where}${eventScopeCondition(mapping, event, scope)}`
}

/** The first and last event of the concepts for this patient (`first_event`,
 *  `last_event`): the window a table opens on. */
export function buildDataTableBoundsQuery(
  mapping: SchemaMapping,
  conceptIds: number[],
  patientId: string,
  scope: PatientScope,
  opts: Pick<Options, 'held' | 'label'> = {},
): string | null {
  if (conceptIds.length === 0 || !validateIntegerIds(conceptIds)) return null
  const { out, notSearched } = branches(mapping, conceptIds, opts.held)
  const parts = out.map(({ event, ids }) => {
    const src = branchSource(mapping, event, ids, opts.label)
    return `${sqlComment(event.name)}
SELECT
  MIN(e.start_datetime) AS first_event,
  MAX(e.start_datetime) AS last_event
FROM ${src.from}
WHERE
  ${branchWhere(mapping, event, src.match, patientId, scope)}`
  })
  if (parts.length === 0) return null
  return `${header('The first and last event of the chosen concepts', notSearched)}
SELECT
  MIN(b.first_event) AS first_event,
  MAX(b.last_event) AS last_event
FROM (
${indent(parts.join('\nUNION ALL\n'))}
) b`
}

/** How many events of the concepts fall in each of `buckets` equal slices of
 *  the window (`col`, `n`; empty slices absent): the density strip under the
 *  table, read as counts, never as the events. */
export function buildDataTableDensityQuery(
  mapping: SchemaMapping,
  conceptIds: number[],
  patientId: string,
  scope: PatientScope,
  opts: Pick<Options, 'from' | 'to' | 'held' | 'label'> & { buckets: number },
): string | null {
  if (conceptIds.length === 0 || !validateIntegerIds(conceptIds)) return null
  const buckets = Math.max(1, Math.min(1000, Math.floor(opts.buckets)))
  const { out, notSearched } = branches(mapping, conceptIds, opts.held)
  const parts = out.map(({ event, ids }) => {
    const src = branchSource(mapping, event, ids, opts.label)
    return `${sqlComment(event.name)}
SELECT
  ${bucketExpr('e.start_datetime', opts.from, opts.to, buckets)} AS col,
  COUNT(*) AS n
FROM ${src.from}
WHERE
  ${branchWhere(mapping, event, src.match, patientId, scope, opts)}
GROUP BY 1`
  })
  if (parts.length === 0) return null
  return `${header(`The chosen concepts' events in ${buckets} slices of the record`, notSearched)}
SELECT d.col, SUM(d.n) AS n
FROM (
${indent(parts.join('\nUNION ALL\n'))}
) d
GROUP BY d.col`
}
