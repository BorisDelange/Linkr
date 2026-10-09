/**
 * Build the `metadata_json` of a source concept by querying the clinical
 * database it comes from.
 *
 * A file-source mapping project gets this column for free — someone profiled the
 * warehouse beforehand and shipped the result in the CSV. A database-source
 * project has no such column, so the same profile has to be computed here, which
 * is what lets both kinds of project share one editor, one export and one git
 * round trip.
 *
 * The reference implementation is ehop-tools' `profile_concept()` (R), written
 * against eHOP's single flat `document_data` table. This is a port, not a copy:
 * everything it hardcoded as a column name is read from the class relations
 * instead, so the same code profiles OMOP, MIMIC or any other model the app can
 * already describe. A block whose backing column the preset does not declare is
 * skipped rather than guessed — a schema without a date column simply has no
 * temporal distribution.
 *
 * Everything here is a pure string builder: the caller executes the SQL and
 * assembles the result (see `buildConceptProfile`). That keeps the SQL testable
 * without a database, which matters because these queries scan event tables.
 *
 * The output shape is the legacy `info_json` the concept detail view already
 * renders (ConceptDetailView.tsx) — the point is to produce what the app reads,
 * not to invent a second format.
 */

import type { SchemaMapping } from '@/types/schema-mapping'
import { conceptIdentity, type ConceptIdentity } from '@/lib/schema-classes/spec'
import { classRelation, conceptRelation, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { binCentre } from '@/lib/concept-mapping/export-masking'
import { hashedConceptId } from './hashed-concept-id'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Which blocks of the profile to compute. Each maps to one key of the JSON. */
export interface ProfileSections {
  /** `record_count` / `patient_count` — how many records and patients. Absent
   *  on a run stored before it was a choice, which read as on. */
  counts?: boolean
  /** `numeric_data` — min/max/mean/median/sd/percentiles over the value column. */
  numeric: boolean
  /** `histogram` — binned value distribution. Requires `numeric`. */
  histogram: boolean
  /** `categorical_data` — top-N string values with counts and percentages. */
  categorical: boolean
  /** `unit` — the modal unit of the value. */
  unit: boolean
  /** `measurement_frequency` — median delay between two records for one patient. */
  frequency: boolean
  /** `temporal_distribution` — date range plus a per-year breakdown. */
  temporal: boolean
  /** `hospital_units` — top wards the concept is recorded in. */
  hospitalUnits: boolean
  /** `missing_rate` — share of records whose value columns are all empty. */
  missingRate: boolean
  /** `per_patient` — how many records one patient has: mean/median/min/max. */
  perPatient: boolean
}

export const DEFAULT_PROFILE_SECTIONS: ProfileSections = {
  counts: true,
  numeric: true,
  histogram: true,
  categorical: true,
  unit: true,
  frequency: true,
  temporal: true,
  hospitalUnits: true,
  missingRate: true,
  perPatient: true,
}

/** How the profile is computed. Mirrors ehop-tools' `profile_concept()` args. */
export interface ProfileOptions {
  /**
   * Profile each concept at all. Off, the extraction only copies the dictionary
   * (codes and names) and never scans the event tables. Absent reads as on.
   */
  metadata?: boolean
  sections: ProfileSections
  /**
   * How outliers are excluded before the numeric stats and the histogram.
   *
   * They are computed on the trimmed set on purpose: one mistyped weight of
   * 9999 kg stretches the histogram until every real value lands in the first
   * bin, which is exactly the chart a reviewer needs to read.
   */
  outlierMethod: 'iqr' | 'mad' | 'percentile' | 'none'
  /** Multiplier for the `iqr` and `mad` methods. 1.5 is the usual Tukey fence. */
  outlierCoef: number
  /** Histogram bins, or `'auto'` for Sturges' rule capped at 50. */
  bins: number | 'auto'
  /** Categorical values rarer than this are dropped, for confidentiality. */
  minCategoryCount: number
  /** How many categorical values and wards to keep. */
  topN: number
  /**
   * Categorical values longer than this are masked rather than emitted.
   *
   * A long "value" in a categorical column is usually free text that was never
   * meant to be one — a comment, or a whole note — and free text from a clinical
   * record is exactly what must not travel in an exported profile.
   */
  maxCategoryLength: number
  /**
   * Concepts recorded for fewer than this many patients get no profile at all.
   *
   * k-anonymity: an aggregate over two patients is not an aggregate. The caller
   * still keeps the concept and its counts — only the JSON is withheld.
   */
  minPatients: number
}

export const DEFAULT_PROFILE_OPTIONS: ProfileOptions = {
  metadata: true,
  sections: DEFAULT_PROFILE_SECTIONS,
  outlierMethod: 'iqr',
  outlierCoef: 1.5,
  bins: 'auto',
  minCategoryCount: 50,
  topN: 10,
  maxCategoryLength: 50,
  minPatients: 11,
}

// ---------------------------------------------------------------------------
// Resolving what the schema actually offers
// ---------------------------------------------------------------------------

/**
 * A dictionary and the event tables its concepts' records live in.
 *
 * A dictionary can be referenced by several event tables (OMOP's concept table
 * by measurement, drug_exposure, condition_occurrence…; MIMIC's d_items by
 * chartevents and labevents). They are never unioned — that would mix
 * incomparable value columns — so a concept is profiled in ONE of them: the
 * extraction picks, per concept, the table holding most of its records
 * (see `mergeTableCounts`) and profiles it there, through `event`.
 */
export interface ProfileSource {
  label: string
  dictionary: ConceptIdentity
  /** The event table a profile reads (`linkr_event_*`). The richest of
   *  `events` until the extraction points it at a concept's own table. */
  event: ClassRelation
  /** Every event table referencing the dictionary, richest first: the table
   *  carrying a numeric value ranks above one carrying only a code, since that
   *  is what a profile is mostly about. */
  events: ClassRelation[]
  /** The dictionary's relation (`linkr_concept_*`). */
  dict: ClassRelation
}

/** Score an event table by how much of a profile it can support. */
function sourceRichness(event: ClassRelation): number {
  return (has(event, 'value_number') ? 4 : 0)
    + (has(event, 'value_string') ? 2 : 0)
    + (has(event, 'start_datetime') ? 1 : 0)
}

export function resolveProfileSource(
  mapping: SchemaMapping,
  dictionaryKey: string,
): ProfileSource | null {
  const dictionary = conceptIdentity(mapping, dictionaryKey)
  const dict = conceptRelation(mapping, dictionaryKey)
  if (!dictionary || !dict) return null
  // A stable sort: among equally rich tables, the schema's own order decides.
  const events = eventRelations(mapping)
    .filter((e) => e.dictionary === dict.name)
    .sort((a, b) => sourceRichness(b) - sourceRichness(a))
  if (events.length === 0) return null
  return { label: events[0].key ?? '', dictionary, event: events[0], events, dict }
}

/**
 * Which sections this schema can actually produce, given what it declares.
 *
 * Asked before profiling so the UI can grey out what is unavailable rather than
 * offering a toggle that yields nothing.
 */
export function availableSections(
  mapping: SchemaMapping,
  source: ProfileSource,
): ProfileSections {
  const e = source.event
  const hasDate = has(e, 'start_datetime')
  const hasPatient = has(e, 'patient_id')
  return {
    counts: true,
    numeric: has(e, 'value_number'),
    histogram: has(e, 'value_number'),
    categorical: has(e, 'value_string'),
    unit: has(e, 'unit'),
    frequency: hasDate && hasPatient,
    temporal: hasDate,
    hospitalUnits: !!resolveWardExpr(mapping, e),
    missingRate: has(e, 'value_number') || has(e, 'value_string'),
    perPatient: hasPatient,
  }
}

/** Restrict requested sections to those the schema supports. */
export function effectiveSections(
  requested: ProfileSections,
  available: ProfileSections,
): ProfileSections {
  const out = {} as ProfileSections
  for (const key of Object.keys(requested) as (keyof ProfileSections)[]) {
    out[key] = !!(requested[key] && available[key])
  }
  out.counts = requested.counts !== false
  // The histogram is a view of the numeric values, so it cannot outlive them.
  out.histogram = out.histogram && out.numeric
  return out
}

/**
 * How to reach a human-readable ward name from an event row, or null when the
 * schema describes no ward at all.
 */
interface WardJoin {
  /** SQL expression yielding the ward name, relative to the joins below. */
  expr: string
  /** JOIN clauses to append after the event table. */
  joins: string
}

function resolveWardExpr(mapping: SchemaMapping, event: ClassRelation): WardJoin | null {
  const vd = classRelation(mapping, 'visit_detail')
  // The event table has no visit-detail FK of its own, so the link is by patient
  // and time: the ward a record belongs to is the stay that contains its date.
  // Without a date there is nothing to contain it.
  if (!vd || !has(vd, 'unit_name') || !has(event, 'patient_id') || !has(event, 'start_datetime')) return null
  return {
    expr: 'vd.unit_name',
    joins: `LEFT JOIN ${vd.name} vd
      ON vd.patient_id = e.patient_id
     AND e.start_datetime >= vd.start_datetime
     ${has(vd, 'end_datetime') ? 'AND e.start_datetime <= vd.end_datetime' : ''}`,
  }
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

/**
 * The id an event column names a concept by, as the dictionary keys it.
 *
 * A dictionary with an id of its own is referenced by that id. A code-only one
 * (MIMIC d_icd_diagnoses) is keyed on a hash of its code (conceptIdentity), and
 * its event table names the concept by that code: the column is hashed the same
 * way, or `e.concept_id = <hash>` meets no record and the profile comes back
 * empty. Shared with the extraction's counts query (buildConceptCountsQuery).
 */
export function eventConceptKey(dictionary: ConceptIdentity, column: string): string {
  return dictionary.ownId ? column : hashedConceptId(column)
}

/**
 * `conceptId` is the dictionary's key. OMOP rows can name a concept through
 * either `*_concept_id` or `*_source_concept_id`, which is why the match is a
 * disjunction rather than an equality — shared with the counts query so both
 * agree on what "this concept's records" means.
 */
function conceptMatch(source: ProfileSource, conceptId: number): string {
  const id = Math.trunc(conceptId)
  const key = (column: string) => `${eventConceptKey(source.dictionary, column)} = ${id}`
  return has(source.event, 'source_concept_id')
    ? `${key('e.concept_id')} OR ${key('e.source_concept_id')}`
    : key('e.concept_id')
}

/** The FROM + WHERE that isolates one concept's records in its event table. */
function eventScope(source: ProfileSource, conceptId: number): string {
  return `FROM ${source.event.name} e WHERE (${conceptMatch(source, conceptId)})`
}

const patientsExpr = (event: ClassRelation) => (has(event, 'patient_id') ? 'COUNT(DISTINCT e.patient_id)' : 'NULL')

/** A cell's own records and patients ride along with it: export masking needs
 *  both, since a percentage does not say over which records it was taken and
 *  a cell of many records can still be one patient's. */
function withCellCounts<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (key !== 'count' && key !== 'patients_count') out[key] = value
    else if (value != null) out[key] = Number(value)
  }
  return out as T
}

/** The "no value at all" predicate over whichever value columns the event has. */
function emptyValue(event: ClassRelation): string | null {
  const empty: string[] = []
  if (has(event, 'value_number')) empty.push('e.value_number IS NULL')
  if (has(event, 'value_string')) empty.push(`(e.value_string IS NULL OR TRIM(CAST(e.value_string AS VARCHAR)) = '')`)
  return empty.length ? empty.join(' AND ') : null
}

/** Records and distinct patients for one concept. Always computed. */
export function buildProfileBaseQuery(
  _mapping: SchemaMapping,
  source: ProfileSource,
  conceptId: number,
): string {
  return `SELECT COUNT(*) AS rows_count, ${patientsExpr(source.event)} AS patients_count
  ${eventScope(source, conceptId)}`
}

/**
 * Share of records carrying no value at all, as a percentage.
 *
 * A percentage, not a ratio: `PERCENT_KEYS` in the detail view appends a `%` to
 * this key, so a 0-1 ratio would render as "0.02%".
 */
export function buildMissingRateQuery(
  source: ProfileSource,
  conceptId: number,
): string {
  const empty = emptyValue(source.event)
  if (!empty) return ''
  return `SELECT ROUND(
    SUM(CASE WHEN ${empty} THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1
  ) AS missing_rate
  ${eventScope(source, conceptId)}`
}

/**
 * Percentiles used only to derive the outlier fences.
 *
 * Separate from the stats query because the fences must be known before the
 * stats are computed — the whole point is that the stats describe the trimmed
 * distribution.
 */
export function buildPercentileQuery(
  source: ProfileSource,
  conceptId: number,
): string {
  if (!has(source.event, 'value_number')) return ''
  return `SELECT
    PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY e.value_number) AS p1,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY e.value_number) AS p25,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY e.value_number) AS median,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY e.value_number) AS p75,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY e.value_number) AS p99,
    COUNT(e.value_number) AS numeric_count
  ${eventScope(source, conceptId)} AND e.value_number IS NOT NULL`
}

/**
 * Everything about one concept that fits in a single row, in one query.
 *
 * Six blocks — counts, missing rate, percentiles, records per patient, the modal
 * unit and the measurement interval — are all aggregates over the same rows.
 * Asked one at a time they were six round trips per concept, and over a 5,600
 * concept dictionary that is tens of thousands of requests driven from one
 * browser tab: the dominant cost of a run, and the reason the tab stalled.
 *
 * The blocks that CANNOT join this are the ones that return many rows
 * (histogram, categories, temporal, wards) or that depend on this one's result
 * (the trimmed numeric stats need the fences these percentiles give).
 *
 * Sections the caller did not ask for are left out rather than computed and
 * discarded — the point is to scan less, not to scan the same and ask once.
 */
export function buildCombinedScalarQuery(
  _mapping: SchemaMapping,
  source: ProfileSource,
  conceptId: number,
  sections: ProfileSections,
): string {
  const event = source.event
  const hasPatient = has(event, 'patient_id')
  const parts: string[] = ['COUNT(*) AS rows_count', `${patientsExpr(event)} AS patients_count`]

  const empty = sections.missingRate ? emptyValue(event) : null
  if (empty) {
    parts.push(`ROUND(SUM(CASE WHEN ${empty} THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS missing_rate`)
  }

  if (sections.numeric && has(event, 'value_number')) {
    const v = 'e.value_number'
    // FILTER, not a WHERE: the other aggregates here count all rows, and
    // restricting the scan would silently change what they report.
    const within = `FILTER (WHERE ${v} IS NOT NULL)`
    parts.push(
      `PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY ${v}) AS p1`,
      `PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ${v}) AS p25`,
      `PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${v}) AS median`,
      `PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ${v}) AS p75`,
      `PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${v}) AS p99`,
      `COUNT(${v}) ${within} AS numeric_count`,
    )
  }

  if (sections.unit && has(event, 'unit')) {
    const u = 'CAST(e.unit AS VARCHAR)'
    // The most frequent unit. mode() reads the same rows the aggregates above
    // already visit, where the standalone query needed its own GROUP BY pass.
    parts.push(`mode(${u}) FILTER (WHERE ${u} IS NOT NULL AND TRIM(${u}) <> '') AS unit`)
  }

  const scope = eventScope(source, conceptId)

  // Per-patient counts and inter-record delays are aggregates over GROUPS, so
  // they cannot sit beside the row-level ones — they ride as scalar subqueries
  // over the same scope, which still costs one round trip rather than three.
  const subqueries: string[] = []
  if (sections.perPatient && hasPatient) {
    subqueries.push(`(SELECT ROUND(AVG(n), 1) FROM (SELECT COUNT(*) AS n ${scope} GROUP BY e.patient_id)) AS per_patient_mean`)
    subqueries.push(`(SELECT MEDIAN(n) FROM (SELECT COUNT(*) AS n ${scope} GROUP BY e.patient_id)) AS per_patient_median`)
    subqueries.push(`(SELECT MIN(n) FROM (SELECT COUNT(*) AS n ${scope} GROUP BY e.patient_id)) AS per_patient_min`)
    subqueries.push(`(SELECT MAX(n) FROM (SELECT COUNT(*) AS n ${scope} GROUP BY e.patient_id)) AS per_patient_max`)
  }
  if (sections.frequency && has(event, 'start_datetime') && hasPatient) {
    subqueries.push(`(SELECT MEDIAN(hours) FROM (
      SELECT EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (PARTITION BY patient_id ORDER BY ts))) / 3600.0 AS hours
      FROM (SELECT e.patient_id AS patient_id, CAST(e.start_datetime AS TIMESTAMP) AS ts
            ${scope} AND e.start_datetime IS NOT NULL)
    ) WHERE hours > 0) AS median_hours`)
  }

  return `SELECT ${[...parts, ...subqueries].join(',\n    ')}
  ${scope}`
}

/** The percentiles the fences are derived from. */
export interface PercentileRow {
  p1: number | null
  p25: number | null
  median: number | null
  p75: number | null
  p99: number | null
  numeric_count: number
}

/** Lower/upper cut-offs, or null when nothing is excluded. */
export interface OutlierBounds {
  lower: number
  upper: number
}

/**
 * Fences from the percentiles, by the configured method.
 *
 * `mad` is derived from the IQR rather than from a true median absolute
 * deviation — the same approximation ehop-tools makes, kept so both produce the
 * same numbers. Note the two 1.4826 factors cancel: the method differs from
 * `iqr` only in being centred on the median rather than spanning the quartiles.
 */
export function outlierBounds(
  row: PercentileRow,
  method: ProfileOptions['outlierMethod'],
  coef: number,
): OutlierBounds | null {
  if (method === 'none') return null
  if (row.numeric_count <= 0) return null
  if (row.p25 == null || row.p75 == null) return null
  if (method === 'percentile') {
    return row.p1 == null || row.p99 == null ? null : { lower: row.p1, upper: row.p99 }
  }
  const iqr = row.p75 - row.p25
  if (method === 'mad') {
    if (row.median == null) return null
    const mad = iqr / 1.4826
    return { lower: row.median - coef * mad * 1.4826, upper: row.median + coef * mad * 1.4826 }
  }
  return { lower: row.p25 - coef * iqr, upper: row.p75 + coef * iqr }
}

/** Append the outlier filter on the value to a scope that already has a WHERE. */
function withinBounds(bounds: OutlierBounds | null): string {
  if (!bounds) return ''
  // A non-finite bound would emit `>= NaN`, which DuckDB refuses to parse — and
  // `run` swallows that, so the concept would silently lose its numeric block and
  // histogram. `num()` yields NaN for any value the driver hands back unparsed,
  // and NaN != null passes every guard above, so check here.
  if (!Number.isFinite(bounds.lower) || !Number.isFinite(bounds.upper)) return ''
  return ` AND e.value_number >= ${bounds.lower} AND e.value_number <= ${bounds.upper}`
}

/**
 * Descriptive statistics, over the trimmed values.
 *
 * Rounded to one decimal like the reference implementation: these are read by a
 * human deciding whether a mapping is plausible, and full float precision only
 * makes the JSON bigger and the diff noisier.
 */
export function buildNumericStatsQuery(
  source: ProfileSource,
  conceptId: number,
  bounds: OutlierBounds | null,
): string {
  if (!has(source.event, 'value_number')) return ''
  const v = 'e.value_number'
  return `SELECT
    MIN(${v}) AS min,
    MAX(${v}) AS max,
    ROUND(AVG(${v}), 1) AS mean,
    ROUND(MEDIAN(${v}), 1) AS median,
    ROUND(STDDEV(${v}), 1) AS sd,
    ROUND(PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY ${v}), 1) AS p5,
    ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ${v}), 1) AS p25,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ${v}), 1) AS p75,
    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${v}), 1) AS p95,
    COUNT(${v}) AS numeric_count
  ${eventScope(source, conceptId)} AND ${v} IS NOT NULL${withinBounds(bounds)}`
}

/**
 * Bin count: Sturges' rule, capped.
 *
 * The cap is what keeps the JSON small for a concept with millions of records —
 * Sturges grows with log2(n), so an uncapped rule stays modest anyway, but a
 * caller passing an explicit count is held to the same ceiling.
 */
export function histogramBins(count: number, bins: number | 'auto'): number {
  if (bins === 'auto') return Math.min(50, Math.max(1, Math.ceil(1 + Math.log2(Math.max(1, count)))))
  return Math.min(50, Math.max(1, Math.trunc(bins)))
}

/**
 * Binned distribution of the trimmed values, as bin index + width per row.
 *
 * The width is a round m × 10^e near (max − min) / bins, and the edges are its
 * multiples: bins anchored on the minimum would give the minimum and maximum
 * back through their centres, and those are one patient's values each. Each bin
 * also counts its distinct patients, for export masking.
 */
export function buildHistogramQuery(
  source: ProfileSource,
  conceptId: number,
  bounds: OutlierBounds | null,
  bins: number,
): string {
  if (!has(source.event, 'value_number')) return ''
  const withPatient = has(source.event, 'patient_id')
  return `WITH filtered AS (
    SELECT e.value_number AS value${withPatient ? ', e.patient_id AS patient_id' : ''}
    ${eventScope(source, conceptId)} AND e.value_number IS NOT NULL${withinBounds(bounds)}
  ),
  spread AS (
    SELECT (MAX(value) - MIN(value)) / ${bins} AS width FROM filtered
  ),
  magnitude AS (
    SELECT width / POW(10, FLOOR(LOG10(width))) AS mantissa, CAST(FLOOR(LOG10(width)) AS INTEGER) AS step_e
    FROM spread WHERE width > 0
  ),
  step AS (
    SELECT CASE WHEN mantissa <= 1 THEN 1 WHEN mantissa <= 2 THEN 2 WHEN mantissa <= 5 THEN 5 ELSE 10 END AS step_m, step_e
    FROM magnitude
  )
  SELECT CAST(FLOOR(CASE WHEN s.step_e < 0 THEN f.value * POW(10, -s.step_e) / s.step_m
                         ELSE f.value / (s.step_m * POW(10, s.step_e)) END) AS INTEGER) AS bin_idx,
         s.step_m, s.step_e, COUNT(*) AS count,
         ${withPatient ? 'COUNT(DISTINCT f.patient_id)' : 'NULL'} AS patients_count
  FROM filtered f, step s GROUP BY ALL ORDER BY bin_idx`
}

/** The histogram query's rows as {x: bin centre, count, patients_count}. */
export function histogramFromRows(rows: Record<string, unknown>[]): { x: number; count: number; patients_count?: number }[] {
  return rows.map((row) => ({
    x: binCentre(Number(row.bin_idx), Number(row.step_m), Number(row.step_e)),
    count: Number(row.count),
    ...(row.patients_count != null ? { patients_count: Number(row.patients_count) } : {}),
  }))
}

/**
 * Top string values with their share of the total.
 *
 * The percentage is over ALL records, not only the kept ones, so a concept whose
 * values are mostly rare reads as such instead of showing a handful of
 * categories summing to 100%.
 */
export function buildCategoricalQuery(
  source: ProfileSource,
  conceptId: number,
  options: Pick<ProfileOptions, 'minCategoryCount' | 'topN'>,
): string {
  if (!has(source.event, 'value_string')) return ''
  const v = 'CAST(e.value_string AS VARCHAR)'
  return `SELECT category, count, patients_count, ROUND(count * 100.0 / SUM(count) OVER (), 1) AS percentage FROM (
    SELECT ${v} AS category, COUNT(*) AS count, ${patientsExpr(source.event)} AS patients_count
    ${eventScope(source, conceptId)} AND ${v} IS NOT NULL AND TRIM(${v}) <> ''
    GROUP BY ${v}
    HAVING COUNT(*) >= ${Math.trunc(options.minCategoryCount)}
  ) ORDER BY count DESC, category ASC LIMIT ${Math.trunc(options.topN)}`
}

/** The most frequent unit recorded for this concept. */
export function buildUnitQuery(source: ProfileSource, conceptId: number): string {
  if (!has(source.event, 'unit')) return ''
  const u = 'CAST(e.unit AS VARCHAR)'
  return `SELECT ${u} AS unit, COUNT(*) AS count
  ${eventScope(source, conceptId)} AND ${u} IS NOT NULL AND TRIM(${u}) <> ''
  GROUP BY ${u} ORDER BY count DESC, unit ASC LIMIT 1`
}

/**
 * Median delay in hours between two consecutive records for the same patient.
 *
 * Zero and negative intervals are dropped: same-timestamp duplicates would drag
 * the median to zero and report a per-minute frequency for a daily lab.
 */
export function buildFrequencyQuery(
  _mapping: SchemaMapping,
  source: ProfileSource,
  conceptId: number,
): string {
  const event = source.event
  if (!has(event, 'start_datetime') || !has(event, 'patient_id')) return ''
  return `WITH times AS (
    SELECT e.patient_id AS patient_id, CAST(e.start_datetime AS TIMESTAMP) AS ts
    ${eventScope(source, conceptId)} AND e.start_datetime IS NOT NULL
  ),
  intervals AS (
    SELECT EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (PARTITION BY patient_id ORDER BY ts))) / 3600.0 AS hours
    FROM times
  )
  SELECT MEDIAN(hours) AS median_hours FROM intervals WHERE hours > 0`
}

/**
 * How many records one patient has for this concept.
 *
 * Tells apart a concept measured once per stay from one sampled every minute,
 * which the record and patient totals alone cannot: 10 000 records over 100
 * patients is a different variable depending on whether every patient has 100 or
 * one patient has 9 901.
 */
export function buildPerPatientQuery(
  _mapping: SchemaMapping,
  source: ProfileSource,
  conceptId: number,
): string {
  if (!has(source.event, 'patient_id')) return ''
  return `WITH per_patient AS (
    SELECT COUNT(*) AS n
    ${eventScope(source, conceptId)}
    GROUP BY e.patient_id
  )
  SELECT ROUND(AVG(n), 1) AS mean, MEDIAN(n) AS median, MIN(n) AS min, MAX(n) AS max
  FROM per_patient`
}

/** Date range plus the per-year share of records, with each year's records and patients. */
export function buildTemporalQuery(source: ProfileSource, conceptId: number): string {
  if (!has(source.event, 'start_datetime')) return ''
  const withPatient = has(source.event, 'patient_id')
  return `WITH times AS (
    SELECT CAST(e.start_datetime AS TIMESTAMP) AS ts${withPatient ? ', e.patient_id AS patient_id' : ''}
    ${eventScope(source, conceptId)} AND e.start_datetime IS NOT NULL
  )
  SELECT EXTRACT(YEAR FROM ts) AS year, COUNT(*) AS count,
         ${withPatient ? 'COUNT(DISTINCT patient_id)' : 'NULL'} AS patients_count,
         ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS percentage,
         MIN(MIN(ts)) OVER ()::DATE AS start_date,
         MAX(MAX(ts)) OVER ()::DATE AS end_date
  FROM times GROUP BY EXTRACT(YEAR FROM ts) ORDER BY year`
}

/** Top wards the concept is recorded in, as a share of the records that have a ward, with their records and patients. */
export function buildHospitalUnitsQuery(
  mapping: SchemaMapping,
  source: ProfileSource,
  conceptId: number,
  topN: number,
): string {
  const ward = resolveWardExpr(mapping, source.event)
  if (!ward) return ''
  return `SELECT unit, count, patients_count, ROUND(count * 100.0 / SUM(count) OVER (), 1) AS percentage FROM (
    SELECT ${ward.expr} AS unit, COUNT(*) AS count, COUNT(DISTINCT e.patient_id) AS patients_count
    FROM ${source.event.name} e
    ${ward.joins}
    WHERE (${conceptMatch(source, conceptId)}) AND ${ward.expr} IS NOT NULL
    GROUP BY ${ward.expr}
  ) ORDER BY count DESC, unit ASC LIMIT ${Math.trunc(topN)}`
}

// ---------------------------------------------------------------------------
// Assembling the JSON
// ---------------------------------------------------------------------------

/** Rows each block's query returns, as the assembler expects them. */
export interface ProfileQueryResults {
  base: { rows_count: number; patients_count: number | null }
  missingRate?: { missing_rate: number | null }
  numeric?: Record<string, number | null>
  histogram?: { x: number; count: number; patients_count?: number | null }[]
  categorical?: { category: string; count: number; patients_count?: number | null; percentage: number }[]
  unit?: { unit: string }
  frequency?: { median_hours: number | null }
  temporal?: { year: number; percentage: number; count?: number | null; patients_count?: number | null; start_date: string; end_date: string }[]
  hospitalUnits?: { unit: string; percentage: number; count?: number | null; patients_count?: number | null }[]
  perPatient?: { mean: number | null; median: number | null; min: number | null; max: number | null }
}

/** Identity of the concept being profiled, for the descriptive keys. */
export interface ProfileConcept {
  fullName?: string
  dataSource?: string
}

/**
 * Bucket a median interval into the label the detail view shows.
 *
 * Deliberately coarse: the useful question is "is this a continuous monitor or a
 * daily lab", and an exact median of 5.7 hours answers it worse than "every 6
 * hours" does.
 */
export function frequencyLabel(medianHours: number | null | undefined): string | null {
  if (medianHours == null || !Number.isFinite(medianHours) || medianHours <= 0) return null
  if (medianHours < 1) return 'per minute'
  if (medianHours < 2) return 'hourly'
  if (medianHours < 12) return `every ${Math.round(medianHours)} hours`
  if (medianHours < 36) return 'daily'
  if (medianHours < 168) return 'weekly'
  return 'monthly or less'
}

/** Mask a categorical value that is too long to be one. */
function maskLongValue(value: string, maxLength: number): string | null {
  return value.length > maxLength ? null : value
}

/**
 * Whether the "categories" are just the numeric values written as text.
 *
 * Some schemas keep a measurement twice in one row — MIMIC's chartevents has
 * both `valuenum` and `value`, the latter being the former as a string. Profiled
 * naively, a heart rate then reports a numeric distribution AND a category list
 * of "80", "81", "82", which is the same data shown twice and reads as a bug.
 *
 * Only claimed when the concept has numeric data too: a genuinely categorical
 * concept whose codes happen to be numbers ("0"/"1") keeps its categories, since
 * without a numeric block there is nothing for them to duplicate.
 */
function categoriesMirrorNumbers(
  categories: { category: string }[],
  hasNumeric: boolean,
): boolean {
  if (!hasNumeric || categories.length === 0) return false
  return categories.every((row) => {
    const trimmed = row.category.trim()
    return trimmed !== '' && Number.isFinite(Number(trimmed))
  })
}

/**
 * Assemble the profile JSON from the executed queries.
 *
 * Absent keys are omitted rather than emitted as null: the detail view renders
 * any top-level scalar it does not recognise as a text row, so a null would show
 * up as an empty line in the UI.
 *
 * Returns null when the concept is below the k-anonymity threshold — the caller
 * keeps the concept and its counts, but publishes no aggregate about it.
 */
export function assembleProfileJson(
  results: ProfileQueryResults,
  concept: ProfileConcept,
  options: ProfileOptions,
): Record<string, unknown> | null {
  const patients = results.base.patients_count
  if (patients != null && patients < options.minPatients) return null

  const out: Record<string, unknown> = {}
  if (concept.fullName) out.full_name = concept.fullName
  if (concept.dataSource) out.data_source = concept.dataSource

  const hasNumeric = !!results.numeric && results.numeric.min != null
  const masked = (results.categorical ?? [])
    .map((row) => withCellCounts({ ...row, category: maskLongValue(row.category, options.maxCategoryLength) }))
    .filter((row): row is typeof row & { category: string } => row.category !== null)
  const categorical = categoriesMirrorNumbers(masked, hasNumeric) ? [] : masked
  const hasCategorical = categorical.length > 0

  // `data_types` drives nothing in the renderer but tells a reviewer at a glance
  // what kind of concept this is, which is why it survives the port.
  const types = [hasNumeric && 'numeric', hasCategorical && 'categorical'].filter(Boolean)
  if (types.length === 1) out.data_types = types[0]
  else if (types.length > 1) out.data_types = types

  if (results.unit?.unit) out.unit = results.unit.unit

  if (hasNumeric && results.numeric) {
    const n = results.numeric
    // Fixed key order: this is what the detail view's stats row renders in.
    out.numeric_data = pickDefined(n, ['min', 'p5', 'p25', 'median', 'mean', 'p75', 'p95', 'max', 'sd'])
  }
  if (results.histogram?.length) out.histogram = results.histogram.map(withCellCounts)
  if (hasCategorical) out.categorical_data = categorical

  const interval = frequencyLabel(results.frequency?.median_hours)
  if (interval) out.measurement_frequency = { typical_interval: interval }

  if (results.missingRate?.missing_rate != null) out.missing_rate = results.missingRate.missing_rate

  if (results.perPatient) {
    const perPatient = pickDefined(results.perPatient, ['mean', 'median', 'min', 'max'])
    if (Object.keys(perPatient).length > 0) out.records_per_patient = perPatient
  }

  const temporal = results.temporal ?? []
  if (temporal.length > 0) {
    out.temporal_distribution = {
      start_date: temporal[0].start_date,
      end_date: temporal[0].end_date,
      by_year: temporal.map((row) => withCellCounts({ year: row.year, percentage: row.percentage, count: row.count, patients_count: row.patients_count })),
    }
  }

  if (results.hospitalUnits?.length) out.hospital_units = results.hospitalUnits.map(withCellCounts)

  return out
}

/** Keep the listed keys, in that order, dropping the ones with no value. */
function pickDefined(
  row: Record<string, number | null>,
  keys: string[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of keys) {
    const value = row[key]
    if (value != null && Number.isFinite(value)) out[key] = value
  }
  return out
}

/** A concept's identity as the profiler needs it. */
export interface ConceptToProfile {
  conceptId: number
  conceptName?: string
  category?: string
}

/**
 * Run one concept's profile end to end.
 *
 * `query` executes SQL against the source database; the caller owns mounting and
 * routing (WASM or server). Blocks run in sequence rather than in parallel: they
 * scan the same event table, and a warehouse answers one big scan faster than
 * eight competing ones.
 *
 * A block that fails is skipped, not fatal — a profile missing its wards is
 * still worth having, and one malformed date column should not cost the whole
 * extraction.
 */
export async function buildConceptProfile(
  mapping: SchemaMapping,
  source: ProfileSource,
  concept: ConceptToProfile,
  options: ProfileOptions,
  query: (sql: string) => Promise<Record<string, unknown>[]>,
): Promise<{ json: Record<string, unknown> | null; rowsCount: number; patientsCount: number | null }> {
  const sections = effectiveSections(options.sections, availableSections(mapping, source))
  const run = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (!sql) return []
    try {
      return await query(sql)
    } catch {
      return []
    }
  }

  // One query for every block that fits in a single row. See
  // buildCombinedScalarQuery: this is what took a concept from six round trips
  // to one, and a whole run from tens of thousands of requests to a few.
  const scalarRows = await run(buildCombinedScalarQuery(mapping, source, concept.conceptId, sections))
  const scalar = (scalarRows[0] ?? {}) as Record<string, unknown>
  const num = (key: string): number | null =>
    scalar[key] == null ? null : Number(scalar[key])

  const base = {
    rows_count: Number(scalar.rows_count ?? 0),
    patients_count: num('patients_count'),
  }
  const results: ProfileQueryResults = { base }

  // Below the threshold nothing else is computed: the JSON would be withheld
  // anyway, and everything still to come is the expensive part.
  if (base.patients_count != null && base.patients_count < options.minPatients) {
    return { json: null, rowsCount: base.rows_count, patientsCount: base.patients_count }
  }

  if (sections.missingRate && 'missing_rate' in scalar) {
    results.missingRate = { missing_rate: num('missing_rate') }
  }
  if (sections.unit && scalar.unit != null) {
    results.unit = { unit: String(scalar.unit) }
  }
  if (sections.frequency && 'median_hours' in scalar) {
    results.frequency = { median_hours: num('median_hours') }
  }
  if (sections.perPatient && 'per_patient_mean' in scalar) {
    results.perPatient = {
      mean: num('per_patient_mean'),
      median: num('per_patient_median'),
      min: num('per_patient_min'),
      max: num('per_patient_max'),
    }
  }

  let bounds: OutlierBounds | null = null
  let numericCount = 0
  if (sections.numeric && 'numeric_count' in scalar) {
    numericCount = Number(scalar.numeric_count ?? 0)
    bounds = outlierBounds(
      {
        p1: num('p1'), p25: num('p25'), median: num('median'),
        p75: num('p75'), p99: num('p99'), numeric_count: numericCount,
      },
      options.outlierMethod,
      options.outlierCoef,
    )
    // Still its own query: these describe the TRIMMED distribution, so they
    // cannot be computed before the fences above are known.
    const stats = await run(buildNumericStatsQuery(source, concept.conceptId, bounds))
    if (stats[0]) results.numeric = stats[0] as Record<string, number | null>
  }

  if (sections.histogram && numericCount > 0) {
    const bins = histogramBins(numericCount, options.bins)
    const rows = await run(buildHistogramQuery(source, concept.conceptId, bounds, bins))
    if (rows.length) results.histogram = histogramFromRows(rows)
  }

  if (sections.categorical) {
    const rows = await run(buildCategoricalQuery(source, concept.conceptId, options))
    if (rows.length) results.categorical = rows as unknown as ProfileQueryResults['categorical']
  }

  // unit, frequency, missing rate and per-patient came from the combined query
  // above — they are single-row aggregates over the same scope.

  if (sections.temporal) {
    const rows = await run(buildTemporalQuery(source, concept.conceptId))
    if (rows.length) results.temporal = rows as unknown as ProfileQueryResults['temporal']
  }

  if (sections.hospitalUnits) {
    const rows = await run(buildHospitalUnitsQuery(mapping, source, concept.conceptId, options.topN))
    if (rows.length) results.hospitalUnits = rows as unknown as ProfileQueryResults['hospitalUnits']
  }

  const json = assembleProfileJson(
    results,
    { fullName: concept.conceptName, dataSource: localizedPresetLabel(mapping) },
    options,
  )
  return { json, rowsCount: base.rows_count, patientsCount: base.patients_count }
}

/** The schema's own name, recorded as the profile's `data_source`. */
function localizedPresetLabel(mapping: SchemaMapping): string | undefined {
  const label = mapping.presetLabel
  if (!label) return undefined
  return label.en ?? label.fr ?? Object.values(label)[0]
}
