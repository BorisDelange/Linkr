import type { SchemaMapping, EventTable, ConceptDictionary } from '@/types/schema-mapping'
import { getDictionaryForEvent, buildConceptJoinCondition } from '@/lib/schema-helpers'
import { escSql } from '@/lib/format-helpers'

/**
 * Queries for the Patient overview widget: every event a patient has, grouped by
 * source table and concept, so you can see where the record has data and where
 * it has none.
 *
 * Everything here is driven by `SchemaMapping`, never by hard-coded table names —
 * the same builders run against OMOP CDM (measurement, drug_exposure…) and
 * MIMIC-IV (chartevents, labevents…) because both describe themselves through
 * the mapping. A model that names its tables differently needs no code change,
 * only a mapping.
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
  const parts: string[] = []

  for (const [label, et] of Object.entries(mapping.eventTables ?? {})) {
    const part = buildInventoryPart(mapping, label, et, patientId, visitId, stay)
    if (part) parts.push(part)
  }

  if (parts.length === 0) return null
  return `${parts.join('\nUNION ALL\n')}\nORDER BY table_label, event_count DESC`
}

function buildInventoryPart(
  mapping: SchemaMapping,
  label: string,
  et: EventTable,
  patientId: string,
  visitId: string | null,
  stay: OverviewStayWindow | null,
): string | null {
  if (!et.dateColumn) return null
  const patientIdCol = et.patientIdColumn ?? mapping.patientTable?.idColumn
  if (!patientIdCol) return null

  const dict = getDictionaryForEvent(mapping, et)
  const visitFilter = buildVisitFilter(mapping, visitId, 'e') + buildStayFilter(et, stay)
  const endExpr = et.endDateColumn ? `e."${et.endDateColumn}"` : 'NULL'
  // Unit of measure: the standardised concept when the schema maps one, with the
  // source text as fallback AND as the preferred label — "mmHg" reads better
  // than "millimeter mercury column", and "bpm"/"insp/min" both standardise to
  // "per minute", which would make heart and respiratory rate indistinguishable.
  const srcUnitCol = pickUnitColumn(et)
  const unitJoin =
    et.valueUnitConceptIdColumn && dict
      ? `\nLEFT JOIN "${dict.table}" uc ON uc."${dict.idColumn}" = e."${et.valueUnitConceptIdColumn}"`
      : ''
  const srcUnitExpr = srcUnitCol ? `MAX(e."${srcUnitCol}")` : null
  const stdUnitExpr = unitJoin ? `MAX(uc."${dict!.nameColumn}")` : null
  const unitExpr =
    srcUnitExpr && stdUnitExpr
      ? `COALESCE(${srcUnitExpr}, ${stdUnitExpr})`
      : (srcUnitExpr ?? stdUnitExpr ?? 'NULL')
  // MAX() picks one unit alphabetically. That is fine when a concept is charted
  // in a single unit and actively misleading when it is not — a drug recorded in
  // both mg and mL, a weight in kg and lb. Count the distinct units so the label
  // can be withheld rather than confidently wrong.
  const unitCountSrc = srcUnitCol ? `e."${srcUnitCol}"` : null
  const unitCountStd = unitJoin ? `uc."${dict!.nameColumn}"` : null
  const unitCountArg =
    unitCountSrc && unitCountStd
      ? `COALESCE(${unitCountSrc}, ${unitCountStd})`
      : (unitCountSrc ?? unitCountStd)
  const unitCountExpr = unitCountArg ? `COUNT(DISTINCT ${unitCountArg})` : '0'

  // Without a dictionary the concept id is all we can show — still useful, since
  // the point of the figure is where data exists, not only what it is called.
  const nameExpr = dict
    ? `MAX(c."${dict.nameColumn}")`
    : `MAX(CAST(e."${et.conceptIdColumn}" AS VARCHAR))`
  const classExpr = dict ? classColumnExpr(dict) : 'NULL'
  // The code identifies the concept outside this database — it is what you paste
  // into a vocabulary browser or another site's mapping — so it travels with the
  // name into the tooltip and the copy menu.
  const codeExpr = dict?.codeColumn ? `MAX(c."${dict.codeColumn}")` : 'NULL'
  const join =
    (dict
      ? `\nLEFT JOIN "${dict.table}" c ON ${buildConceptJoinCondition('e', 'c', et, dict)}`
      : '') + unitJoin

  return `SELECT '${escSql(label)}' AS table_label,
  CAST(e."${et.conceptIdColumn}" AS VARCHAR) AS concept_id,
  ${nameExpr} AS concept_name,
  ${codeExpr} AS concept_code,
  ${classExpr} AS concept_class,
  ${unitExpr} AS unit,
  ${unitCountExpr} AS unit_count,
  COUNT(*) AS event_count,
  MIN(e."${et.dateColumn}") AS first_event,
  MAX(COALESCE(${endExpr}, e."${et.dateColumn}")) AS last_event,
  ${et.endDateColumn ? 'TRUE' : 'FALSE'} AS durational
FROM "${et.table}" e${join}
WHERE e."${patientIdCol}" = '${escSql(patientId)}'
  AND e."${et.dateColumn}" IS NOT NULL${visitFilter}
GROUP BY e."${et.conceptIdColumn}"`
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
    const et = mapping.eventTables?.[row.table]
    if (!et?.dateColumn) continue
    const patientIdCol = et.patientIdColumn ?? mapping.patientTable?.idColumn
    if (!patientIdCol) continue

    const visitFilter = buildVisitFilter(mapping, visitId, 'e') + buildStayFilter(et, stay)
    const conceptFilter = buildConceptFilter(et, row.conceptIds)
    const bucket = bucketExpr(`e."${et.dateColumn}"`, from, to, n)

    // Grouped by the ROW the renderer will draw, not by concept: one band needs
    // one count per bucket, and a per-concept grouping returns a row per concept
    // per bucket — over 100k rows on a dense MIMIC record, for a few hundred
    // pixels of output.
    parts.push(`SELECT '${escSql(row.key)}' AS row_key,
  ${bucket} AS bucket,
  COUNT(*) AS n
FROM "${et.table}" e
WHERE e."${patientIdCol}" = '${escSql(patientId)}'
  AND e."${et.dateColumn}" >= TIMESTAMP '${escSql(from)}'
  AND e."${et.dateColumn}" <= TIMESTAMP '${escSql(to)}'${visitFilter}${conceptFilter}
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
  /**
   * Drop the free-text value column. A mapping saved before a preset was fixed
   * can name a column the table does not have — `measurement.value_as_string`
   * exists in CDM 5.4 on `observation` only — and the whole query then fails.
   * The text is a tooltip nicety; the timestamps are the figure, so the caller
   * retries without it rather than losing the row entirely.
   */
  omitValueString = false,
): string | null {
  const et = mapping.eventTables?.[tableLabel]
  if (!et || !et.dateColumn || conceptIds.length === 0) return null
  const patientIdCol = et.patientIdColumn ?? mapping.patientTable?.idColumn
  if (!patientIdCol) return null

  const visitFilter = buildVisitFilter(mapping, visitId, 'e') + buildStayFilter(et, stay)
  const conceptFilter = buildConceptFilter(et, conceptIds)
  const endExpr = et.endDateColumn ? `e."${et.endDateColumn}"` : 'NULL'
  const valExpr = et.valueColumn ? `e."${et.valueColumn}"` : 'NULL'
  const strExpr =
    et.valueStringColumn && !omitValueString ? `e."${et.valueStringColumn}"` : 'NULL'
  // The route is a concept like any other, so it resolves through the same
  // dictionary — "Intravenous", not a local code. Joined separately from the
  // event's own concept, on its own alias.
  const dict = getDictionaryForEvent(mapping, et)
  const routeJoin =
    et.routeConceptIdColumn && dict
      ? `\nLEFT JOIN "${dict.table}" rc ON rc."${dict.idColumn}" = e."${et.routeConceptIdColumn}"`
      : ''
  // Source text first: it keeps distinctions the vocabulary drops (IV DRIP and
  // IV BOLUS are both `Intravenous`), and some models have no route concept.
  const srcRouteExpr = et.routeColumn ? `e."${et.routeColumn}"` : null
  const stdRouteExpr = routeJoin ? `rc."${dict!.nameColumn}"` : null
  const routeExpr =
    srcRouteExpr && stdRouteExpr
      ? `COALESCE(${srcRouteExpr}, ${stdRouteExpr})`
      : (srcRouteExpr ?? stdRouteExpr ?? 'NULL')
  // An event overlapping the window matters even if it started before it — a
  // drip running across the whole view would otherwise vanish when zoomed into.
  const overlap = et.endDateColumn
    ? `e."${et.dateColumn}" <= TIMESTAMP '${escSql(to)}'
  AND COALESCE(e."${et.endDateColumn}", e."${et.dateColumn}") >= TIMESTAMP '${escSql(from)}'`
    : `e."${et.dateColumn}" >= TIMESTAMP '${escSql(from)}'
  AND e."${et.dateColumn}" <= TIMESTAMP '${escSql(to)}'`

  return `SELECT CAST(e."${et.conceptIdColumn}" AS VARCHAR) AS concept_id,
  e."${et.dateColumn}" AS event_start,
  ${endExpr} AS event_end,
  ${valExpr} AS value_number,
  CAST(${strExpr} AS VARCHAR) AS value_string,
  CAST(${routeExpr} AS VARCHAR) AS route
FROM "${et.table}" e${routeJoin}
WHERE e."${patientIdCol}" = '${escSql(patientId)}'
  AND ${overlap}${visitFilter}${conceptFilter}
ORDER BY e."${et.dateColumn}"
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
  const vdt = mapping.visitDetailTable
  if (!vdt) return null

  const hasLookup = !!(vdt.unitColumn && vdt.unitNameTable && vdt.unitNameIdColumn && vdt.unitNameColumn)
  const join = hasLookup
    ? `\nLEFT JOIN "${vdt.unitNameTable}" un ON vd."${vdt.unitColumn}" = un."${vdt.unitNameIdColumn}"`
    : ''
  const endCol = vdt.endDateColumn ? `vd."${vdt.endDateColumn}"` : 'NULL'
  const visitFilter = visitId
    ? `\n  AND vd."${vdt.visitIdColumn}" = '${escSql(visitId)}'`
    : ''

  // Name, in order of clinical usefulness: the verbatim source value (the actual
  // ward), then the looked-up care-site name, then the raw column — which on
  // MIMIC already holds a name, and on OMOP is an id that may not resolve.
  const candidates = [
    vdt.unitSourceValueColumn ? `vd."${vdt.unitSourceValueColumn}"` : null,
    hasLookup ? `un."${vdt.unitNameColumn}"` : null,
    vdt.unitColumn ? `vd."${vdt.unitColumn}"` : null,
  ].filter(Boolean) as string[]
  const nameExpr = candidates.length
    ? `COALESCE(${candidates.map((c) => `NULLIF(CAST(${c} AS VARCHAR), '')`).join(', ')})`
    : 'NULL'
  // The looked-up/standard name is the category: it groups wards of the same
  // kind, which is what the lane colours by.
  const categoryExpr = hasLookup
    ? `CAST(un."${vdt.unitNameColumn}" AS VARCHAR)`
    : vdt.unitColumn
      ? `CAST(vd."${vdt.unitColumn}" AS VARCHAR)`
      : 'NULL'

  return `SELECT vd."${vdt.startDateColumn}" AS stay_start,
  ${endCol} AS stay_end,
  ${nameExpr} AS unit_name,
  ${categoryExpr} AS unit_category
FROM "${vdt.table}" vd${join}
WHERE vd."${vdt.patientIdColumn}" = '${escSql(patientId)}'
  AND vd."${vdt.startDateColumn}" IS NOT NULL${visitFilter}
ORDER BY vd."${vdt.startDateColumn}"`
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
  const vdt = mapping.visitDetailTable
  if (!vdt) return null
  const endCol = vdt.endDateColumn ? `vd."${vdt.endDateColumn}"` : 'NULL'
  return `SELECT vd."${vdt.startDateColumn}" AS stay_start,
  ${endCol} AS stay_end
FROM "${vdt.table}" vd
WHERE vd."${vdt.idColumn}" = '${escSql(visitDetailId)}'
LIMIT 1`
}

/** The patient's death timestamp, wherever this model keeps it. */
export function buildOverviewDeathQuery(
  mapping: SchemaMapping,
  patientId: string,
): string | null {
  const pt = mapping.patientTable
  // A column on the patient table wins over a separate table, matching the rule
  // the rest of the patient-data queries already follow.
  if (pt?.deathDateColumn) {
    return `SELECT "${pt.deathDateColumn}" AS death_date
FROM "${pt.table}"
WHERE "${pt.idColumn}" = '${escSql(patientId)}'
  AND "${pt.deathDateColumn}" IS NOT NULL
LIMIT 1`
  }
  const dt = mapping.deathTable
  if (!dt) return null
  return `SELECT "${dt.dateColumn}" AS death_date
FROM "${dt.table}"
WHERE "${dt.patientIdColumn}" = '${escSql(patientId)}'
  AND "${dt.dateColumn}" IS NOT NULL
LIMIT 1`
}

/** The label under which this model exposes unit stays (for the lane's name). */
export function overviewUnitTableLabel(mapping: SchemaMapping): string | null {
  return mapping.visitDetailTable?.table ?? null
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Which dictionary column carries the concept's class.
 *
 * `subcategoryColumn` first: OMOP maps `concept_class_id` there (Lab Test,
 * Clinical Drug…), which is the useful grain, while its `categoryColumn` holds
 * `domain_id` — far too coarse to group by. MIMIC has no subcategory, and its
 * `d_items.category` is exactly the right grain, so it falls through to that.
 * A model with neither simply has no class level and the option is hidden.
 */
function classColumn(dict: ConceptDictionary): string | undefined {
  return dict.subcategoryColumn ?? dict.categoryColumn
}

function classColumnExpr(dict: ConceptDictionary): string {
  const col = classColumn(dict)
  return col ? `MAX(CAST(c."${col}" AS VARCHAR))` : 'NULL'
}

/** True when this mapping can group concepts by class at all. */
export function overviewSupportsClasses(mapping: SchemaMapping): boolean {
  return (mapping.conceptTables ?? []).some((d) => !!classColumn(d))
}

/** A unit-of-measure column on the event table, when the model has one. */
function pickUnitColumn(et: EventTable): string | undefined {
  // `unitColumn` on an event table is a legacy spelling; on visitDetailTable the
  // same name means a hospital ward, which is why the unit of measure needed one
  // of its own.
  const extra = et as EventTable & { unitColumn?: string }
  return et.valueUnitColumn ?? extra.unitColumn
}

/** Bucket index of a timestamp within [from, to], clamped to the last bucket. */
function bucketExpr(col: string, from: string, to: string, n: number): string {
  const span = `(EPOCH(TIMESTAMP '${escSql(to)}') - EPOCH(TIMESTAMP '${escSql(from)}'))`
  return `LEAST(${n - 1}, GREATEST(0, CAST(
    (EPOCH(${col}) - EPOCH(TIMESTAMP '${escSql(from)}')) / NULLIF(${span}, 0) * ${n} AS INTEGER)))`
}

function buildConceptFilter(et: EventTable, conceptIds?: string[]): string {
  if (!conceptIds || conceptIds.length === 0) return ''
  // Ids are quoted rather than validated as integers: MIMIC itemids are numeric
  // but other models use string codes, and escSql keeps both safe.
  const list = conceptIds.map((id) => `'${escSql(id)}'`).join(', ')
  return `\n  AND CAST(e."${et.conceptIdColumn}" AS VARCHAR) IN (${list})`
}

/**
 * Restrict to one visit. The event table is assumed to carry the visit id under
 * the same name the visit table uses for its PK — the convention the rest of the
 * patient-data queries already rely on.
 */
function buildVisitFilter(
  mapping: SchemaMapping,
  visitId: string | null,
  alias: string,
): string {
  if (!visitId || !mapping.visitTable) return ''
  return `\n  AND ${alias}."${mapping.visitTable.idColumn}" = '${escSql(visitId)}'`
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
function buildStayFilter(
  et: EventTable,
  stay: OverviewStayWindow | null,
): string {
  if (!stay || !et.dateColumn) return ''
  const start = `e."${et.dateColumn}"`
  // A block overlapping the stay counts: an infusion started before admission
  // to the unit is still running during it.
  const end = et.endDateColumn ? `COALESCE(e."${et.endDateColumn}", ${start})` : start
  const upper = stay.end
    ? `\n  AND ${start} <= TIMESTAMP '${escSql(stay.end)}'`
    : ''
  return `\n  AND ${end} >= TIMESTAMP '${escSql(stay.start)}'${upper}`
}

/** The time window of the selected unit stay, when one is selected. */
export interface OverviewStayWindow {
  start: string
  end: string | null
}
