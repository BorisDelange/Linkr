import type { SchemaMapping } from '@/types/schema-mapping'
import { classRelation, codesRelation, conceptJoinOn, conceptRelations, dictionaryOf, eventRelation, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { specTables } from '@/lib/schema-classes/spec'
import { escSql } from '@/lib/format-helpers'
import { eventScopeCondition, type PatientScope } from './patient-scope'

/**
 * Queries for the Patient overview widget: every event a patient has, grouped by
 * source table and concept, so you can see where the record has data and where
 * it has none.
 *
 * Everything here reads the class relations (`linkr_event_*`, `linkr_visit_detail`…),
 * never hard-coded table names — the same builders run against OMOP CDM
 * (measurement, drug_exposure…) and MIMIC-IV (chartevents, labevents…) because
 * both describe themselves through the mapping.
 *
 * The heavy query aggregates in SQL rather than shipping raw rows: one ICU
 * patient can hold 400k events, which is far past what the browser should hold
 * to draw a few hundred pixels of density.
 */

/** One concept present in a patient's record, with its event count. */
export interface OverviewConcept {
  table: string
  conceptId: string
  conceptName: string
  /** OMOP concept_class_id, MIMIC d_items.category — whatever the mapping names. */
  conceptClass: string | null
  unit: string | null
  eventCount: number
  firstEvent: string
  lastEvent: string
  /** True when the source table carries an end date, so events are blocks. */
  durational: boolean
}

/** A patient's stay in one unit/ward. */
export interface OverviewUnitStay {
  start: string
  end: string | null
  name: string
  category: string | null
}

/**
 * The concept inventory: one row per (table, concept) the patient has data for.
 *
 * This is the query that drives the whole figure — the row list, the counts, the
 * class grouping. It stays small (hundreds of rows) however large the record is,
 * because the events themselves are counted, not returned.
 */
export function buildOverviewInventoryQuery(
  mapping: SchemaMapping,
  patientId: string,
  scope: PatientScope,
): string | null {
  const parts = eventRelations(mapping)
    .map((event) => buildInventoryPart(mapping, event, patientId, scope))
    .filter((part): part is string => !!part)

  if (parts.length === 0) return null
  return `${parts.join('\nUNION ALL\n')}\nORDER BY table_label, event_count DESC`
}

function buildInventoryPart(
  mapping: SchemaMapping,
  event: ClassRelation,
  patientId: string,
  scope: PatientScope,
): string | null {
  if (!has(event, 'start_datetime') || !has(event, 'patient_id')) return null

  const dict = dictionaryOf(mapping, event)
  if (dict && event.compositeConceptKey && event.codeSql != null) return buildCodesInventoryPart(mapping, event, dict, patientId, scope)
  const visitFilter = eventScopeCondition(mapping, event, scope)
  const durational = has(event, 'end_datetime')
  // Unit of measure: the standardised concept when the schema maps one, with the
  // source text as fallback AND as the preferred label — "mmHg" reads better
  // than "millimeter mercury column", and "bpm"/"insp/min" both standardise to
  // "per minute", which would make heart and respiratory rate indistinguishable.
  const unitJoin = dict && has(event, 'unit_concept_id')
    ? `\nLEFT JOIN ${dict.name} uc ON uc.concept_id = e.unit_concept_id`
    : ''
  const srcUnit = has(event, 'unit') ? 'e.unit' : null
  const stdUnit = unitJoin ? 'uc.concept_name' : null
  const unitExpr =
    srcUnit && stdUnit
      ? `COALESCE(MAX(${srcUnit}), MAX(${stdUnit}))`
      : srcUnit || stdUnit ? `MAX(${srcUnit ?? stdUnit})` : 'NULL'
  // MAX() picks one unit alphabetically. That is fine when a concept is charted
  // in a single unit and actively misleading when it is not — a drug recorded in
  // both mg and mL, a weight in kg and lb. Count the distinct units so the label
  // can be withheld rather than confidently wrong.
  const unitCountArg = srcUnit && stdUnit ? `COALESCE(${srcUnit}, ${stdUnit})` : (srcUnit ?? stdUnit)
  const unitCountExpr = unitCountArg ? `COUNT(DISTINCT ${unitCountArg})` : '0'

  // Without a dictionary the concept id is all we can show — still useful, since
  // the point of the figure is where data exists, not only what it is called.
  const nameExpr = dict ? 'MAX(c.concept_name)' : 'MAX(CAST(e.concept_id AS VARCHAR))'
  const classCol = dict ? classColumn(dict) : null
  const classExpr = classCol ? `MAX(CAST(c.${classCol} AS VARCHAR))` : 'NULL'
  // The code identifies the concept outside this database — it is what you paste
  // into a vocabulary browser or another site's mapping — so it travels with the
  // name into the tooltip and the copy menu.
  const codeExpr = dict && has(dict, 'concept_code') ? 'MAX(c.concept_code)' : 'NULL'
  const join = (dict ? `\nLEFT JOIN ${dict.name} c ON ${conceptJoinOn(event, 'e', 'c')}` : '') + unitJoin

  return `SELECT '${escSql(event.key ?? '')}' AS table_label,
  CAST(e.concept_id AS VARCHAR) AS concept_id,
  ${nameExpr} AS concept_name,
  ${codeExpr} AS concept_code,
  ${classExpr} AS concept_class,
  ${unitExpr} AS unit,
  ${unitCountExpr} AS unit_count,
  COUNT(*) AS event_count,
  MIN(e.start_datetime) AS first_event,
  MAX(COALESCE(${durational ? 'e.end_datetime' : 'NULL'}, e.start_datetime)) AS last_event,
  ${durational ? 'TRUE' : 'FALSE'} AS durational,
  ${event.cls === 'drug' ? 'TRUE' : 'FALSE'} AS is_drug
FROM ${event.name} e${join}
WHERE e.patient_id = '${escSql(patientId)}'
  AND e.start_datetime IS NOT NULL${visitFilter}
GROUP BY e.concept_id`
}

/**
 * The inventory of an event keyed by (terminology, code), counted on its codes
 * before any dictionary is read. Its relation looks each row's concept_id up in
 * the whole dictionary, and a second join fetched the names: on a dictionary of
 * millions of concepts, the query of the whole figure took over a gigabyte of
 * the database's memory. Here the patient's rows are grouped first — a few
 * hundred codes — and only those are looked up, once.
 *
 * Same rows as the general form: grouped at the end by the concept_id the
 * relation would give (the smallest id of the pair, NULL for a code the
 * dictionary lacks), units counted from their own groups.
 */
function buildCodesInventoryPart(
  mapping: SchemaMapping,
  event: ClassRelation,
  dict: ClassRelation,
  patientId: string,
  scope: PatientScope,
): string {
  const visitFilter = eventScopeCondition(mapping, event, scope)
  const durational = has(event, 'end_datetime')
  const unitCols = [has(event, 'unit') ? 'unit' : null, has(event, 'unit_concept_id') ? 'unit_concept_id' : null]
    .filter((c): c is string => !!c)
  const groupCols = ['concept_terminology', 'concept_code', ...unitCols]
  const classCol = classColumn(dict)
  const hasCode = has(dict, 'concept_code')
  const unitJoin = unitCols.includes('unit_concept_id') ? `\nLEFT JOIN ${dict.name} uc ON uc.concept_id = g.unit_concept_id` : ''
  const srcUnit = unitCols.includes('unit') ? 'g.unit' : null
  const stdUnit = unitJoin ? 'g.unit_name' : null
  const unitExpr = srcUnit && stdUnit
    ? `COALESCE(MAX(${srcUnit}), MAX(${stdUnit}))`
    : srcUnit || stdUnit ? `MAX(${srcUnit ?? stdUnit})` : 'NULL'
  const unitCountArg = srcUnit && stdUnit ? `COALESCE(${srcUnit}, ${stdUnit})` : (srcUnit ?? stdUnit)

  const counted = `SELECT ${groupCols.map((c) => `e.${c}`).join(', ')},
    COUNT(*) AS n,
    MIN(e.start_datetime) AS first_event,
    MAX(COALESCE(${durational ? 'e.end_datetime' : 'NULL'}, e.start_datetime)) AS last_event
  FROM ${codesRelation(event.name)} e
  WHERE e.patient_id = '${escSql(patientId)}'
    AND e.start_datetime IS NOT NULL${visitFilter}
  GROUP BY ${groupCols.map((c) => `e.${c}`).join(', ')}`
  // One row per counted group, with what the dictionary says of its code.
  const resolved = `SELECT ${groupCols.map((c) => `g.${c}`).join(', ')}, g.n, g.first_event, g.last_event,
    MIN(c.concept_id) AS concept_id,
    MAX(c.concept_name) AS concept_name,
    ${hasCode ? 'MAX(c.concept_code)' : 'NULL'} AS dict_code,
    ${classCol ? `MAX(CAST(c.${classCol} AS VARCHAR))` : 'NULL'} AS concept_class${stdUnit ? ',\n    MAX(uc.concept_name) AS unit_name' : ''}
  FROM (
  ${counted}
  ) g
  LEFT JOIN ${dict.name} c ON ${conceptJoinOn(event, 'g', 'c')}${unitJoin}
  GROUP BY ${groupCols.map((c) => `g.${c}`).join(', ')}, g.n, g.first_event, g.last_event`

  return `SELECT '${escSql(event.key ?? '')}' AS table_label,
  CAST(g.concept_id AS VARCHAR) AS concept_id,
  MAX(g.concept_name) AS concept_name,
  MAX(g.dict_code) AS concept_code,
  MAX(g.concept_class) AS concept_class,
  ${unitExpr} AS unit,
  ${unitCountArg ? `COUNT(DISTINCT ${unitCountArg})` : '0'} AS unit_count,
  SUM(g.n) AS event_count,
  MIN(g.first_event) AS first_event,
  MAX(g.last_event) AS last_event,
  ${durational ? 'TRUE' : 'FALSE'} AS durational,
  ${event.cls === 'drug' ? 'TRUE' : 'FALSE'} AS is_drug
FROM (
${resolved}
) g
GROUP BY g.concept_id`
}

/**
 * Bucketed density for one source table: how many events fall in each of
 * `buckets` equal slices of [from, to].
 *
 * This is what the far-out view draws. Aggregating here rather than in the
 * browser is the difference between shipping 400k rows and shipping a few
 * hundred — and it is the only way the widget stays usable on a real ICU record.
 */
export function buildOverviewDensityQuery(
  mapping: SchemaMapping,
  patientId: string,
  scope: PatientScope,
  from: string,
  to: string,
  buckets: number,
  rows: OverviewDensityRow[],
): string | null {
  const n = Math.max(1, Math.min(2000, Math.floor(buckets)))
  const parts: string[] = []

  for (const row of rows) {
    const event = eventRelation(mapping, row.table)
    if (!has(event, 'start_datetime') || !has(event, 'patient_id')) continue

    const visitFilter = eventScopeCondition(mapping, event!, scope)
    const conceptFilter = buildConceptFilter(row.conceptIds)
    const bucket = bucketExpr('e.start_datetime', from, to, n)

    // Grouped by the ROW the renderer will draw, not by concept: one band needs
    // one count per bucket, and a per-concept grouping returns a row per concept
    // per bucket — over 100k rows on a dense MIMIC record, for a few hundred
    // pixels of output.
    parts.push(`SELECT '${escSql(row.key)}' AS row_key,
  ${bucket} AS bucket,
  COUNT(*) AS n
FROM ${event!.name} e
WHERE e.patient_id = '${escSql(patientId)}'
  AND e.start_datetime >= ${timestamp(from)}
  AND e.start_datetime <= ${timestamp(to)}${visitFilter}${conceptFilter}
GROUP BY 1, 2`)
  }

  if (parts.length === 0) return null
  return `${parts.join('\nUNION ALL\n')}\nORDER BY row_key, bucket`
}

/**
 * Density on ABSOLUTE buckets of `bucketMs` milliseconds, over [from, to): the
 * bucket of an event is `floor(epoch_ms(start) / bucketMs)` whatever the view,
 * so a tile read for one view serves every later view at the same zoom level
 * (see `overview-tiles.ts`). One row per (row, bucket) holding events.
 *
 * An event counts in the bucket it starts in, spans included: spreading an
 * infusion over every bucket it covers would multiply the rows grouped. Zoomed
 * in far enough to draw it, the row reads its events and shows the full span.
 */
export function buildOverviewTileDensityQuery(
  mapping: SchemaMapping,
  patientId: string,
  scope: PatientScope,
  rows: OverviewDensityRow[],
  bucketMs: number,
  from: string,
  to: string,
): string | null {
  const width = Math.max(1, Math.floor(bucketMs))
  const parts: string[] = []
  for (const row of rows) {
    const event = eventRelation(mapping, row.table)
    if (!has(event, 'start_datetime') || !has(event, 'patient_id')) continue
    parts.push(`SELECT '${escSql(row.key)}' AS row_key,
  ${floorDiv(`${EPOCH_MICROS('CAST(e.start_datetime AS TIMESTAMP)')} // 1000`, width)} AS bucket,
  COUNT(*) AS n
FROM ${event!.name} e
WHERE e.patient_id = '${escSql(patientId)}'
  AND e.start_datetime >= ${timestamp(from)}
  AND e.start_datetime < ${timestamp(to)}${eventScopeCondition(mapping, event!, scope)}${buildConceptFilter(row.conceptIds)}
GROUP BY 1, 2`)
  }
  if (parts.length === 0) return null
  return parts.join('\nUNION ALL\n')
}

/** One band the renderer wants density for: a row key and the concepts behind it. */
export interface OverviewDensityRow {
  /** Opaque key the caller uses to match results back to its row. */
  key: string
  /** Event-table label, as keyed in `mapping.eventTables`. */
  table: string
  /** Concepts folded into this row; empty means every concept of the table. */
  conceptIds: string[]
}

/**
 * The events themselves, for rows zoomed in far enough to draw each one.
 *
 * Capped: a row that would return more than `limit` events is drawn as density
 * instead, so this never ships an unbounded result set.
 */
export function buildOverviewEventsQuery(
  mapping: SchemaMapping,
  patientId: string,
  scope: PatientScope,
  tableLabel: string,
  conceptIds: string[],
  from: string,
  to: string,
  limit: number,
): string | null {
  const event = eventRelation(mapping, tableLabel)
  if (!event || !has(event, 'start_datetime') || !has(event, 'patient_id') || conceptIds.length === 0) return null

  const visitFilter = eventScopeCondition(mapping, event, scope)
  const conceptFilter = buildConceptFilter(conceptIds)
  // The route is a concept like any other, so it resolves through the same
  // dictionary — "Intravenous", not a local code. Joined separately from the
  // event's own concept, on its own alias.
  const dict = dictionaryOf(mapping, event)
  const routeJoin = dict && has(event, 'route_concept_id')
    ? `\nLEFT JOIN ${dict.name} rc ON rc.concept_id = e.route_concept_id`
    : ''
  // Source text first: it keeps distinctions the vocabulary drops (IV DRIP and
  // IV BOLUS are both `Intravenous`), and some models have no route concept.
  const srcRoute = has(event, 'route') ? 'e.route' : null
  const stdRoute = routeJoin ? 'rc.concept_name' : null
  const routeExpr = srcRoute && stdRoute ? `COALESCE(${srcRoute}, ${stdRoute})` : (srcRoute ?? stdRoute ?? 'NULL')
  // An event overlapping the window matters even if it started before it — a
  // drip running across the whole view would otherwise vanish when zoomed into.
  const overlap = has(event, 'end_datetime')
    ? `e.start_datetime <= ${timestamp(to)}
  AND COALESCE(e.end_datetime, e.start_datetime) >= ${timestamp(from)}`
    : `e.start_datetime >= ${timestamp(from)}
  AND e.start_datetime <= ${timestamp(to)}`

  return `SELECT CAST(e.concept_id AS VARCHAR) AS concept_id,
  e.start_datetime AS event_start,
  e.end_datetime AS event_end,
  e.value_number,
  ${has(event, 'value_string') ? 'CAST(e.value_string AS VARCHAR)' : 'NULL'} AS value_string,
  ${routeExpr === 'NULL' ? 'NULL' : `CAST(${routeExpr} AS VARCHAR)`} AS route,
  ${has(event, 'rate_value') ? 'e.rate_value' : 'NULL'} AS rate_value,
  ${has(event, 'rate_unit') ? 'CAST(e.rate_unit AS VARCHAR)' : 'NULL'} AS rate_unit
FROM ${event.name} e${routeJoin}
WHERE e.patient_id = '${escSql(patientId)}'
  AND ${overlap}${visitFilter}${conceptFilter}
ORDER BY e.start_datetime
LIMIT ${Math.max(1, Math.floor(limit))}`
}

/**
 * Unit stays for a patient, across every visit.
 *
 * Named from the source value when the mapping has one, since that is the actual
 * ward ("Medical Intensive Care Unit"); the looked-up name is the fallback. On
 * OMOP `care_site_id` is frequently NULL even though `visit_detail` is populated,
 * so relying on the lookup alone would show an empty lane.
 */
export function buildOverviewUnitStaysQuery(
  mapping: SchemaMapping,
  patientId: string,
  visitId: string | null,
): string | null {
  const vd = classRelation(mapping, 'visit_detail')
  if (!vd) return null
  const visitFilter = visitId ? `\n  AND visit_id = '${escSql(visitId)}'` : ''

  return `SELECT start_datetime AS stay_start,
  end_datetime AS stay_end,
  unit_name,
  unit_category
FROM ${vd.name}
WHERE patient_id = '${escSql(patientId)}'
  AND start_datetime IS NOT NULL${visitFilter}
ORDER BY start_datetime`
}

/** The patient's death timestamp, wherever this model keeps it. */
export function buildOverviewDeathQuery(
  mapping: SchemaMapping,
  patientId: string,
): string | null {
  const patient = classRelation(mapping, 'patient')
  if (!has(patient, 'death_datetime')) return null
  return `SELECT death_datetime AS death_date
FROM ${patient!.name}
WHERE patient_id = '${escSql(patientId)}'
  AND death_datetime IS NOT NULL
LIMIT 1`
}

/** The label under which this model exposes unit stays (for the lane's name). */
export function overviewUnitTableLabel(mapping: SchemaMapping): string | null {
  return specTables(mapping.visitDetail)[0]?.table ?? null
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Which dictionary column carries the concept's class.
 *
 * `subcategory` first: OMOP maps `concept_class_id` there (Lab Test, Clinical
 * Drug…), which is the useful grain, while its `category` holds `domain_id` —
 * far too coarse to group by. MIMIC has no subcategory, and its
 * `d_items.category` is exactly the right grain, so it falls through to that.
 * A model with neither simply has no class level and the option is hidden.
 */
function classColumn(dict: ClassRelation): 'subcategory' | 'category' | null {
  if (has(dict, 'subcategory')) return 'subcategory'
  return has(dict, 'category') ? 'category' : null
}

/** True when this mapping can group concepts by class at all. */
export function overviewSupportsClasses(mapping: SchemaMapping): boolean {
  return conceptRelations(mapping).some((d) => !!classColumn(d))
}

/*
 * Times become numbers through exact microsecond differences and integer
 * division only: a database computes them as DuckDB does (remote_sql), where
 * EPOCH, FLOOR or LEAST would keep the query in Linkr — reading the patient's
 * tables whole from the database.
 */

/** A time literal both engines read: `2024-03-01 10:00:00.000`, not ISO's T…Z. */
function timestamp(iso: string): string {
  return `TIMESTAMP '${escSql(iso.replace('T', ' ').replace(/Z$/, ''))}'`
}

const EPOCH_MICROS = (col: string) => `DATE_DIFF('microsecond', TIMESTAMP '1970-01-01 00:00:00', ${col})`

/** floor(x / d) for an integer x and a positive integer d — `//` truncates. */
function floorDiv(x: string, d: number): string {
  return `CASE WHEN ${x} >= 0 THEN ${x} // ${d} ELSE -((-(${x}) - 1) // ${d}) - 1 END`
}

/** Bucket index of a timestamp at or after `from` within [from, to], the last
 *  bucket holding `to` itself. */
function bucketExpr(col: string, from: string, to: string, n: number): string {
  const span = `DATE_DIFF('microsecond', ${timestamp(from)}, ${timestamp(to)})`
  const index = `DATE_DIFF('microsecond', ${timestamp(from)}, ${col}) * ${n} // ${span}`
  return `CASE WHEN ${span} <= 0 THEN 0 WHEN ${index} > ${n - 1} THEN ${n - 1} ELSE ${index} END`
}

function buildConceptFilter(conceptIds?: string[]): string {
  if (!conceptIds || conceptIds.length === 0) return ''
  // Ids are quoted rather than validated as integers: MIMIC itemids are numeric
  // but other models use string codes, and escSql keeps both safe.
  const list = conceptIds.map((id) => `'${escSql(id)}'`).join(', ')
  return `\n  AND CAST(e.concept_id AS VARCHAR) IN (${list})`
}

