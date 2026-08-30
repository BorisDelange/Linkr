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
 * everything it hardcoded as a column name is read from the SchemaMapping
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

import type { SchemaMapping, ConceptDictionary, EventTable } from '@/types/schema-mapping'
import { buildConceptMatchCondition, getEventTablesForDictionary } from '@/lib/schema-helpers'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Which blocks of the profile to compute. Each maps to one key of the JSON. */
export interface ProfileSections {
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
}

export const DEFAULT_PROFILE_SECTIONS: ProfileSections = {
  numeric: true,
  histogram: true,
  categorical: true,
  unit: true,
  frequency: true,
  temporal: true,
  hospitalUnits: true,
  missingRate: true,
}

/** How the profile is computed. Mirrors ehop-tools' `profile_concept()` args. */
export interface ProfileOptions {
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
 * The one event table a concept's records live in, and the columns it exposes.
 *
 * A dictionary can be referenced by several event tables (OMOP splits values
 * across measurement/observation, MIMIC across chartevents/labevents). Rather
 * than union them — which would mix incomparable value columns — the richest
 * one is picked: the table that actually carries a numeric value ranks above one
 * that carries only a code, since that is what a profile is mostly about.
 */
export interface ProfileSource {
  label: string
  eventTable: EventTable
  dictionary: ConceptDictionary
}

/** Score an event table by how much of a profile it can support. */
function sourceRichness(et: EventTable): number {
  return (et.valueColumn ? 4 : 0)
    + (et.valueStringColumn ? 2 : 0)
    + (et.dateColumn ? 1 : 0)
}

export function resolveProfileSource(
  mapping: SchemaMapping,
  dictionaryKey: string,
): ProfileSource | null {
  const dictionary = (mapping.conceptTables ?? []).find((d) => d.key === dictionaryKey)
  if (!dictionary) return null
  const candidates = getEventTablesForDictionary(mapping, dictionaryKey)
  if (candidates.length === 0) return null
  const best = candidates.reduce((a, b) =>
    sourceRichness(b.eventTable) > sourceRichness(a.eventTable) ? b : a)
  return { label: best.label, eventTable: best.eventTable, dictionary }
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
  const et = source.eventTable
  const hasDate = !!et.dateColumn
  return {
    numeric: !!et.valueColumn,
    histogram: !!et.valueColumn,
    categorical: !!et.valueStringColumn,
    unit: !!et.valueUnitColumn,
    frequency: hasDate && !!resolvePatientColumn(mapping, et),
    temporal: hasDate,
    hospitalUnits: !!resolveWardExpr(mapping, et),
    missingRate: !!(et.valueColumn || et.valueStringColumn),
  }
}

/** Restrict requested sections to those the schema supports. */
export function effectiveSections(
  requested: ProfileSections,
  available: ProfileSections,
): ProfileSections {
  const out = {} as ProfileSections
  for (const key of Object.keys(requested) as (keyof ProfileSections)[]) {
    out[key] = requested[key] && available[key]
  }
  // The histogram is a view of the numeric values, so it cannot outlive them.
  out.histogram = out.histogram && out.numeric
  return out
}

/** The event table's patient column, falling back to the patient table's key. */
function resolvePatientColumn(mapping: SchemaMapping, et: EventTable): string | null {
  return et.patientIdColumn ?? mapping.patientTable?.idColumn ?? null
}

/**
 * How to reach a human-readable ward name from an event row, or null when the
 * schema describes no ward at all.
 *
 * Three shapes, in the order of preference the visit-detail mapping documents:
 * the verbatim source value (the actual unit, where the standard concept is far
 * coarser), then a lookup join, then a bare column that already holds names.
 */
interface WardJoin {
  /** SQL expression yielding the ward name, relative to the joins below. */
  expr: string
  /** JOIN clauses to append after the event table. */
  joins: string
}

function resolveWardExpr(mapping: SchemaMapping, et: EventTable): WardJoin | null {
  const vd = mapping.visitDetailTable
  const patientCol = resolvePatientColumn(mapping, et)
  if (!vd || !patientCol) return null

  // The event table has no visit-detail FK of its own, so the link is by patient
  // and time: the ward a record belongs to is the stay that contains its date.
  // Without a date there is nothing to contain it.
  if (!et.dateColumn) return null

  const stayJoin = `LEFT JOIN "${vd.table}" vd
      ON vd."${vd.patientIdColumn}" = e."${patientCol}"
     AND e."${et.dateColumn}" >= vd."${vd.startDateColumn}"
     ${vd.endDateColumn ? `AND e."${et.dateColumn}" <= vd."${vd.endDateColumn}"` : ''}`

  if (vd.unitSourceValueColumn) {
    return { expr: `vd."${vd.unitSourceValueColumn}"`, joins: stayJoin }
  }
  if (vd.unitColumn && vd.unitNameTable && vd.unitNameIdColumn && vd.unitNameColumn) {
    return {
      expr: `cs."${vd.unitNameColumn}"`,
      joins: `${stayJoin}
    LEFT JOIN "${vd.unitNameTable}" cs ON cs."${vd.unitNameIdColumn}" = vd."${vd.unitColumn}"`,
    }
  }
  if (vd.unitColumn) {
    return { expr: `vd."${vd.unitColumn}"`, joins: stayJoin }
  }
  return null
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

/**
 * The FROM + WHERE that isolates one concept's records in its event table.
 *
 * `conceptId` is the dictionary's own key. OMOP rows can name a concept through
 * either `*_concept_id` or `*_source_concept_id`, which is why the match is a
 * disjunction rather than an equality — `buildConceptMatchCondition` owns that
 * rule, shared with the counts query so both agree on what "this concept's
 * records" means.
 */
function eventScope(et: EventTable, conceptId: number): string {
  const match = buildConceptMatchCondition('e', et, String(Math.trunc(conceptId)))
  return `FROM "${et.table}" e WHERE (${match})`
}

/** Records and distinct patients for one concept. Always computed. */
export function buildProfileBaseQuery(
  mapping: SchemaMapping,
  source: ProfileSource,
  conceptId: number,
): string {
  const patientCol = resolvePatientColumn(mapping, source.eventTable)
  const patients = patientCol
    ? `COUNT(DISTINCT e."${patientCol}")`
    : 'NULL'
  return `SELECT COUNT(*) AS rows_count, ${patients} AS patients_count
  ${eventScope(source.eventTable, conceptId)}`
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
  const et = source.eventTable
  const empty: string[] = []
  if (et.valueColumn) empty.push(`e."${et.valueColumn}" IS NULL`)
  if (et.valueStringColumn) {
    empty.push(`(e."${et.valueStringColumn}" IS NULL OR TRIM(CAST(e."${et.valueStringColumn}" AS VARCHAR)) = '')`)
  }
  if (empty.length === 0) return ''
  return `SELECT ROUND(
    SUM(CASE WHEN ${empty.join(' AND ')} THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1
  ) AS missing_rate
  ${eventScope(et, conceptId)}`
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
  const et = source.eventTable
  if (!et.valueColumn) return ''
  return `SELECT
    PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY e."${et.valueColumn}") AS p1,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY e."${et.valueColumn}") AS p25,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY e."${et.valueColumn}") AS median,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY e."${et.valueColumn}") AS p75,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY e."${et.valueColumn}") AS p99,
    COUNT(e."${et.valueColumn}") AS numeric_count
  ${eventScope(et, conceptId)} AND e."${et.valueColumn}" IS NOT NULL`
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

/** Append the outlier filter to a scope that already has a WHERE. */
function withinBounds(column: string, bounds: OutlierBounds | null): string {
  if (!bounds) return ''
  return ` AND e."${column}" >= ${bounds.lower} AND e."${column}" <= ${bounds.upper}`
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
  const et = source.eventTable
  if (!et.valueColumn) return ''
  const v = `e."${et.valueColumn}"`
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
  ${eventScope(et, conceptId)} AND ${v} IS NOT NULL${withinBounds(et.valueColumn, bounds)}`
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
 * Binned distribution of the trimmed values.
 *
 * `x` is the bin CENTRE, not its edge — the detail view plots these on a linear
 * axis, so a left edge would shift every bar half a bin left of the values it
 * counts.
 */
export function buildHistogramQuery(
  source: ProfileSource,
  conceptId: number,
  bounds: OutlierBounds | null,
  bins: number,
): string {
  const et = source.eventTable
  if (!et.valueColumn) return ''
  const v = `e."${et.valueColumn}"`
  return `WITH filtered AS (
    SELECT ${v} AS value
    ${eventScope(et, conceptId)} AND ${v} IS NOT NULL${withinBounds(et.valueColumn, bounds)}
  ),
  bounds AS (
    SELECT MIN(value) AS min_val, (MAX(value) - MIN(value)) / ${bins} AS bin_width FROM filtered
  ),
  binned AS (
    SELECT FLOOR((f.value - b.min_val) / NULLIF(b.bin_width, 0)) AS bin_idx, b.min_val, b.bin_width
    FROM filtered f, bounds b
  )
  SELECT ROUND(min_val + (bin_idx * bin_width) + (bin_width / 2), 1) AS x, COUNT(*) AS count
  FROM binned GROUP BY bin_idx, min_val, bin_width ORDER BY bin_idx`
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
  const et = source.eventTable
  if (!et.valueStringColumn) return ''
  const v = `CAST(e."${et.valueStringColumn}" AS VARCHAR)`
  return `SELECT category, count, ROUND(count * 100.0 / SUM(count) OVER (), 1) AS percentage FROM (
    SELECT ${v} AS category, COUNT(*) AS count
    ${eventScope(et, conceptId)} AND ${v} IS NOT NULL AND TRIM(${v}) <> ''
    GROUP BY ${v}
    HAVING COUNT(*) >= ${Math.trunc(options.minCategoryCount)}
  ) ORDER BY count DESC, category ASC LIMIT ${Math.trunc(options.topN)}`
}

/** The most frequent unit recorded for this concept. */
export function buildUnitQuery(source: ProfileSource, conceptId: number): string {
  const et = source.eventTable
  if (!et.valueUnitColumn) return ''
  const u = `CAST(e."${et.valueUnitColumn}" AS VARCHAR)`
  return `SELECT ${u} AS unit, COUNT(*) AS count
  ${eventScope(et, conceptId)} AND ${u} IS NOT NULL AND TRIM(${u}) <> ''
  GROUP BY ${u} ORDER BY count DESC, unit ASC LIMIT 1`
}

/**
 * Median delay in hours between two consecutive records for the same patient.
 *
 * Zero and negative intervals are dropped: same-timestamp duplicates would drag
 * the median to zero and report a per-minute frequency for a daily lab.
 */
export function buildFrequencyQuery(
  mapping: SchemaMapping,
  source: ProfileSource,
  conceptId: number,
): string {
  const et = source.eventTable
  const patientCol = resolvePatientColumn(mapping, et)
  if (!et.dateColumn || !patientCol) return ''
  return `WITH times AS (
    SELECT e."${patientCol}" AS patient_id, CAST(e."${et.dateColumn}" AS TIMESTAMP) AS ts
    ${eventScope(et, conceptId)} AND e."${et.dateColumn}" IS NOT NULL
  ),
  intervals AS (
    SELECT EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (PARTITION BY patient_id ORDER BY ts))) / 3600.0 AS hours
    FROM times
  )
  SELECT MEDIAN(hours) AS median_hours FROM intervals WHERE hours > 0`
}

/** Date range plus the per-year share of records. */
export function buildTemporalQuery(source: ProfileSource, conceptId: number): string {
  const et = source.eventTable
  if (!et.dateColumn) return ''
  return `WITH times AS (
    SELECT CAST(e."${et.dateColumn}" AS TIMESTAMP) AS ts
    ${eventScope(et, conceptId)} AND e."${et.dateColumn}" IS NOT NULL
  )
  SELECT EXTRACT(YEAR FROM ts) AS year, COUNT(*) AS count,
         ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS percentage,
         MIN(MIN(ts)) OVER ()::DATE AS start_date,
         MAX(MAX(ts)) OVER ()::DATE AS end_date
  FROM times GROUP BY EXTRACT(YEAR FROM ts) ORDER BY year`
}

/** Top wards the concept is recorded in, as a share of records. */
export function buildHospitalUnitsQuery(
  mapping: SchemaMapping,
  source: ProfileSource,
  conceptId: number,
  topN: number,
): string {
  const et = source.eventTable
  const ward = resolveWardExpr(mapping, et)
  if (!ward) return ''
  const match = buildConceptMatchCondition('e', et, String(Math.trunc(conceptId)))
  return `SELECT unit, ROUND(count * 100.0 / SUM(count) OVER (), 1) AS percentage FROM (
    SELECT ${ward.expr} AS unit, COUNT(*) AS count
    FROM "${et.table}" e
    ${ward.joins}
    WHERE (${match}) AND ${ward.expr} IS NOT NULL
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
  histogram?: { x: number; count: number }[]
  categorical?: { category: string; count: number; percentage: number }[]
  unit?: { unit: string }
  frequency?: { median_hours: number | null }
  temporal?: { year: number; percentage: number; start_date: string; end_date: string }[]
  hospitalUnits?: { unit: string; percentage: number }[]
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
  const categorical = (results.categorical ?? [])
    .map((row) => ({ ...row, category: maskLongValue(row.category, options.maxCategoryLength) }))
    .filter((row): row is typeof row & { category: string } => row.category !== null)
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
  if (results.histogram?.length) out.histogram = results.histogram
  if (hasCategorical) out.categorical_data = categorical

  const interval = frequencyLabel(results.frequency?.median_hours)
  if (interval) out.measurement_frequency = { typical_interval: interval }

  if (results.missingRate?.missing_rate != null) out.missing_rate = results.missingRate.missing_rate

  const temporal = results.temporal ?? []
  if (temporal.length > 0) {
    out.temporal_distribution = {
      start_date: temporal[0].start_date,
      end_date: temporal[0].end_date,
      by_year: temporal.map((row) => ({ year: row.year, percentage: row.percentage })),
    }
  }

  if (results.hospitalUnits?.length) out.hospital_units = results.hospitalUnits

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

  const baseRows = await run(buildProfileBaseQuery(mapping, source, concept.conceptId))
  const base = {
    rows_count: Number(baseRows[0]?.rows_count ?? 0),
    patients_count: baseRows[0]?.patients_count == null ? null : Number(baseRows[0].patients_count),
  }
  const results: ProfileQueryResults = { base }

  // Below the threshold nothing else is computed: the JSON would be withheld
  // anyway, and these are the expensive queries.
  if (base.patients_count != null && base.patients_count < options.minPatients) {
    return { json: null, rowsCount: base.rows_count, patientsCount: base.patients_count }
  }

  if (sections.missingRate) {
    const rows = await run(buildMissingRateQuery(source, concept.conceptId))
    if (rows[0]) results.missingRate = { missing_rate: rows[0].missing_rate as number | null }
  }

  let bounds: OutlierBounds | null = null
  let numericCount = 0
  if (sections.numeric) {
    const pct = await run(buildPercentileQuery(source, concept.conceptId))
    if (pct[0]) {
      const row = pct[0] as unknown as PercentileRow
      numericCount = Number(row.numeric_count ?? 0)
      bounds = outlierBounds({ ...row, numeric_count: numericCount }, options.outlierMethod, options.outlierCoef)
    }
    const stats = await run(buildNumericStatsQuery(source, concept.conceptId, bounds))
    if (stats[0]) results.numeric = stats[0] as Record<string, number | null>
  }

  if (sections.histogram && numericCount > 0) {
    const bins = histogramBins(numericCount, options.bins)
    const rows = await run(buildHistogramQuery(source, concept.conceptId, bounds, bins))
    if (rows.length) results.histogram = rows as unknown as { x: number; count: number }[]
  }

  if (sections.categorical) {
    const rows = await run(buildCategoricalQuery(source, concept.conceptId, options))
    if (rows.length) results.categorical = rows as unknown as ProfileQueryResults['categorical']
  }

  if (sections.unit) {
    const rows = await run(buildUnitQuery(source, concept.conceptId))
    if (rows[0]) results.unit = { unit: String(rows[0].unit) }
  }

  if (sections.frequency) {
    const rows = await run(buildFrequencyQuery(mapping, source, concept.conceptId))
    if (rows[0]) results.frequency = { median_hours: rows[0].median_hours as number | null }
  }

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
