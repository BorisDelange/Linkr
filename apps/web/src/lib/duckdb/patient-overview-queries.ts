import type { SchemaMapping } from '@/types/schema-mapping'
import { classRelation, conceptJoinOn, conceptRelations, dictionaryOf, eventRelation, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { specTables } from '@/lib/schema-classes/spec'
import { escSql } from '@/lib/format-helpers'

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
  visitId: string | null,
  stay: OverviewStayWindow | null = null,
): string | null {
  const parts = eventRelations(mapping)
    .map((event) => buildInventoryPart(mapping, event, patientId, visitId, stay))
    .filter((part): part is string => !!part)

  if (parts.length === 0) return null
  return `${parts.join('\nUNION ALL\n')}\nORDER BY table_label, event_count DESC`
}

function buildInventoryPart(
  mapping: SchemaMapping,
  event: ClassRelation,
  patientId: string,
  visitId: string | null,
  stay: OverviewStayWindow | null,
): string | null {
  if (!has(event, 'start_datetime') || !has(event, 'patient_id')) return null

  const dict = dictionaryOf(mapping, event)
  const visitFilter = buildVisitFilter(mapping, visitId) + buildStayFilter(event, stay)
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
  ${durational ? 'TRUE' : 'FALSE'} AS durational
FROM ${event.name} e${join}
WHERE e.patient_id = '${escSql(patientId)}'
  AND e.start_datetime IS NOT NULL${visitFilter}
GROUP BY e.concept_id`
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
  visitId: string | null,
  from: string,
  to: string,
  buckets: number,
  rows: OverviewDensityRow[],
  stay: OverviewStayWindow | null = null,
): string | null {
  const n = Math.max(1, Math.min(2000, Math.floor(buckets)))
  const parts: string[] = []

  for (const row of rows) {
    const event = eventRelation(mapping, row.table)
    if (!has(event, 'start_datetime') || !has(event, 'patient_id')) continue

    const visitFilter = buildVisitFilter(mapping, visitId) + buildStayFilter(event!, stay)
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
  AND e.start_datetime >= TIMESTAMP '${escSql(from)}'
  AND e.start_datetime <= TIMESTAMP '${escSql(to)}'${visitFilter}${conceptFilter}
GROUP BY 1, 2`)
  }

  if (parts.length === 0) return null
  return `${parts.join('\nUNION ALL\n')}\nORDER BY row_key, bucket`
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
  visitId: string | null,
  tableLabel: string,
  conceptIds: string[],
  from: string,
  to: string,
  limit: number,
  stay: OverviewStayWindow | null = null,
): string | null {
  const event = eventRelation(mapping, tableLabel)
  if (!event || !has(event, 'start_datetime') || !has(event, 'patient_id') || conceptIds.length === 0) return null

  const visitFilter = buildVisitFilter(mapping, visitId) + buildStayFilter(event, stay)
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
    ? `e.start_datetime <= TIMESTAMP '${escSql(to)}'
  AND COALESCE(e.end_datetime, e.start_datetime) >= TIMESTAMP '${escSql(from)}'`
    : `e.start_datetime >= TIMESTAMP '${escSql(from)}'
  AND e.start_datetime <= TIMESTAMP '${escSql(to)}'`

  return `SELECT CAST(e.concept_id AS VARCHAR) AS concept_id,
  e.start_datetime AS event_start,
  e.end_datetime AS event_end,
  e.value_number,
  CAST(e.value_string AS VARCHAR) AS value_string,
  CAST(${routeExpr} AS VARCHAR) AS route
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

/**
 * The time window of one unit stay, by its id.
 *
 * Fetched rather than passed down from the sidebar so the scope survives a
 * reload, and so the widget does not depend on which component happens to hold
 * the stay list.
 */
export function buildOverviewStayWindowQuery(
  mapping: SchemaMapping,
  visitDetailId: string,
): string | null {
  const vd = classRelation(mapping, 'visit_detail')
  if (!vd) return null
  return `SELECT start_datetime AS stay_start,
  end_datetime AS stay_end
FROM ${vd.name}
WHERE visit_detail_id = '${escSql(visitDetailId)}'
LIMIT 1`
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

/** Bucket index of a timestamp within [from, to], clamped to the last bucket. */
function bucketExpr(col: string, from: string, to: string, n: number): string {
  const span = `(EPOCH(TIMESTAMP '${escSql(to)}') - EPOCH(TIMESTAMP '${escSql(from)}'))`
  return `LEAST(${n - 1}, GREATEST(0, CAST(
    (EPOCH(${col}) - EPOCH(TIMESTAMP '${escSql(from)}')) / NULLIF(${span}, 0) * ${n} AS INTEGER)))`
}

function buildConceptFilter(conceptIds?: string[]): string {
  if (!conceptIds || conceptIds.length === 0) return ''
  // Ids are quoted rather than validated as integers: MIMIC itemids are numeric
  // but other models use string codes, and escSql keeps both safe.
  const list = conceptIds.map((id) => `'${escSql(id)}'`).join(', ')
  return `\n  AND CAST(e.concept_id AS VARCHAR) IN (${list})`
}

/** Restrict to one visit, through the event's visit id. */
function buildVisitFilter(mapping: SchemaMapping, visitId: string | null): string {
  if (!visitId || !classRelation(mapping, 'visit')) return ''
  return `\n  AND e.visit_id = '${escSql(visitId)}'`
}

/**
 * Restrict to one unit stay, by TIME rather than by foreign key.
 *
 * The FK route does not survive contact with real data: OMOP's
 * `visit_detail_id` is present on the event tables but NULL for every row on
 * the sample warehouse, and in MIMIC-IV `chartevents` has `stay_id` while
 * `labevents` has no such column at all. Filtering on it would silently empty
 * the widget on both. The stay's time window is what "during this stay" means
 * clinically anyway, and every event table has a date.
 */
function buildStayFilter(event: ClassRelation, stay: OverviewStayWindow | null): string {
  if (!stay || !has(event, 'start_datetime')) return ''
  // A block overlapping the stay counts: an infusion started before admission
  // to the unit is still running during it.
  const end = has(event, 'end_datetime') ? 'COALESCE(e.end_datetime, e.start_datetime)' : 'e.start_datetime'
  const upper = stay.end ? `\n  AND e.start_datetime <= TIMESTAMP '${escSql(stay.end)}'` : ''
  return `\n  AND ${end} >= TIMESTAMP '${escSql(stay.start)}'${upper}`
}

/** The time window of the selected unit stay, when one is selected. */
export interface OverviewStayWindow {
  start: string
  end: string | null
}
