/**
 * The concept list's counts, cut into units the server runs one at a time.
 *
 * Counting a billion-row warehouse in one query outlived every HTTP timeout and
 * could not be stopped. So the work is a list of units — one query each — in
 * two steps:
 *
 * - `records`: one unit per (event table, concept column), a plain
 *   `GROUP BY concept_id`. Row counts add up across tables, and once this step
 *   is done the list is usable.
 * - `patients`: one unit per slice of the patients, every table at once —
 *   a patient seen for a concept in two tables counts once, which per-table
 *   units could not ensure. Slices hold disjoint patients, so they add up.
 * - `stats`: optional, the value statistics of the detail panel for every
 *   concept at once. A quantile does not add up across patient slices, so its
 *   units cut the concepts instead: ranges of ids holding about
 *   `STATS_UNIT_ROWS` values each, packed by the server from the row counts of
 *   the `records` step — so it comes after it, and is planned when it starts.
 *
 * Each unit's rows are kept server-side as one file
 * (`concept_cache_fs.write_unit`); a resume skips the units already there.
 *
 * A dictionary mapping `record_count` / `patient_count` holds its counts
 * already: its events get no unit for that count.
 */

import type { SchemaMapping } from '@/types/schema-mapping'
import { codesRelation, conceptRelations, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { rangeCondition } from '@/lib/duckdb/catalog-queries'
import type { SerializedRange } from '@/lib/duckdb/catalog-compute'
import { deterministicId } from '@/lib/deterministic-id'
import { escSql as esc } from '@/lib/format-helpers'

/** Bumped when the unit SQL changes, so a paused run of an older build restarts. */
export const CONCEPT_COUNT_VERSION = 3

/**
 * Event rows per patient slice of the `patients` step. A slice's time is mostly
 * its distinct-patient grouping, so it scales with this; on a billion unsorted
 * rows (8 cores, SSD) 100 M-row slices took 15–33 s — too close to a 60 s
 * proxy timeout for a slower server.
 */
export const CONCEPT_SLICE_ROWS = 50_000_000

/**
 * Values per unit of the `stats` step, packed from the row counts. Each unit
 * re-reads the value tables, filtered on its id range; its grouping holds a
 * fixed-size sketch per concept (approximate quantiles), so the bound is on its
 * time, not its memory. A concept with more values gets a unit of its own.
 */
export const STATS_UNIT_ROWS = 50_000_000

/** Bins of the precomputed histogram, as the detail panel draws them. */
const STATS_BINS = 20

/** Tags the precomputed stats (concept_cache_fs.precomputed_stats): approximate
 *  quantiles, P1–P99 histogram, every value-bearing table. */
export const PRECOMPUTED_STATS_VARIANT = 'p1p99-union-approx'

export type ConceptCountStep = 'records' | 'patients' | 'stats'

/** A unit of the `stats` step: the concepts of one dictionary whose id lies in
 *  `[lo, hi]`, either bound open when null. */
export interface StatsRange {
  dictKey: string
  lo: number | null
  hi: number | null
}

export interface ConceptCountUnit {
  key: string
  step: ConceptCountStep
  sql: string
}

/** What the server keeps of a run, to resume it and to report where it stands. */
export interface ConceptCountManifest {
  /** Names the run: every unit sends it, and the server refuses a unit of a run
   *  that was since replaced. */
  runId: string
  version: number
  signature: string
  slices: SerializedRange[]
  units: { key: string; step: ConceptCountStep }[]
  /** The `stats` step's units, once planned — not in `signature`: they derive
   *  from the counts, not from the mapping alone. */
  statsRanges?: StatsRange[]
  startedAt: string
  /** When the rows and the patients were all counted. */
  finishedAt?: string
  /** When the `stats` step finished. */
  statsFinishedAt?: string
}

const dictKeyLit = (dict: ClassRelation) => `'${esc(dict.key ?? '')}'`

/** The event relations with a dictionary, paired with it, in mapping order —
 *  those whose dictionary does not already hold `count`. */
function countedEvents(mapping: SchemaMapping, count: 'record_count' | 'patient_count'): { event: ClassRelation; dict: ClassRelation }[] {
  const dicts = conceptRelations(mapping)
  const out: { event: ClassRelation; dict: ClassRelation }[] = []
  for (const event of eventRelations(mapping)) {
    const dict = dicts.find((d) => d.name === event.dictionary)
    if (dict && !has(dict, count)) out.push({ event, dict })
  }
  return out
}

/**
 * An event keyed by (terminology, code) reads its concept_id through the whole
 * dictionary (relations.ts, resolveConceptId): every row of the table joins it
 * before anything is counted. Its record units group on the codes instead, then
 * look up the ids of the few thousand codes found — the same counts, the same id
 * per code (the smallest): 6× faster on 49 M rows (Doris). Not its patient units:
 * grouping (code, patient) first measured slower than the lookup it saves.
 */
const countsByCode = (event: ClassRelation) => !!event.compositeConceptKey && event.codeSql != null

/** The dictionary's id of each (terminology, code), as resolveConceptId reads it. */
const idByCode = (dict: ClassRelation) => `(
  SELECT concept_terminology, concept_code, MIN(concept_id) AS concept_id
  FROM ${dict.name}
  GROUP BY concept_terminology, concept_code
)`

/**
 * Of what a record unit counted: the event relation's SQL and its dictionary's.
 * The counts say which relations hold a concept (timeline-relations.ts); a
 * relation whose SQL has changed since is read as if never counted.
 */
export function countedRelationSignature(event: ClassRelation, dict: ClassRelation): string {
  return deterministicId('counted-relation', `${event.sql}\n${dict.sql}`)
}

/** Rows of one event table naming each concept, standard or source column —
 *  with the relation they come from. */
export function buildRecordUnitSql(event: ClassRelation, dict: ClassRelation, column: 'concept_id' | 'source_concept_id'): string {
  const relation = `'${esc(event.name)}' AS relation, '${countedRelationSignature(event, dict)}' AS relation_sig`
  if (column === 'concept_id' && countsByCode(event)) {
    return `SELECT ${dictKeyLit(dict)} AS dict_key, d.concept_id AS concept_id, SUM(g.n)::BIGINT AS record_count, NULL::BIGINT AS patient_count, ${relation}
FROM (
  SELECT e.concept_terminology, e.concept_code, COUNT(*) AS n
  FROM ${codesRelation(event.name)} e
  GROUP BY e.concept_terminology, e.concept_code
) g
INNER JOIN ${idByCode(dict)} d ON g.concept_terminology = d.concept_terminology AND g.concept_code = d.concept_code
WHERE d.concept_id IS NOT NULL
GROUP BY d.concept_id`
  }
  // A source column repeating the standard one would count the row twice for that concept.
  const repeat = column === 'source_concept_id' ? ' AND e.source_concept_id IS DISTINCT FROM e.concept_id' : ''
  return `SELECT ${dictKeyLit(dict)} AS dict_key, e.${column} AS concept_id, COUNT(*)::BIGINT AS record_count, NULL::BIGINT AS patient_count, ${relation}
FROM ${event.name} e
WHERE e.${column} IS NOT NULL${repeat}
GROUP BY e.${column}`
}

/** Distinct patients per concept, over every event table, for one slice of the patients. */
export function buildPatientUnitSql(mapping: SchemaMapping, range: SerializedRange): string | null {
  const inRange = rangeCondition('e.patient_id', range.lo == null && range.hi == null ? null : range)
  const and = inRange ? ` AND ${inRange}` : ''
  const parts: string[] = []
  for (const { event, dict } of countedEvents(mapping, 'patient_count')) {
    parts.push(`SELECT ${dictKeyLit(dict)} AS dict_key, e.concept_id AS cid, e.patient_id AS pid FROM ${event.name} e WHERE e.concept_id IS NOT NULL${and}`)
    if (has(event, 'source_concept_id')) {
      parts.push(`SELECT ${dictKeyLit(dict)} AS dict_key, e.source_concept_id AS cid, e.patient_id AS pid FROM ${event.name} e WHERE e.source_concept_id IS NOT NULL AND e.source_concept_id IS DISTINCT FROM e.concept_id${and}`)
    }
  }
  if (parts.length === 0) return null
  return `SELECT dict_key, cid AS concept_id, NULL::BIGINT AS record_count, COUNT(DISTINCT pid)::BIGINT AS patient_count
FROM (
  ${parts.join('\n  UNION ALL\n  ')}
) _evts
GROUP BY dict_key, cid`
}

/** Event relations of a dictionary that record a numeric value. */
function valuedEventsOf(mapping: SchemaMapping, dict: ClassRelation): ClassRelation[] {
  return eventRelations(mapping).filter((e) => e.dictionary === dict.name && has(e, 'value_number'))
}

/** The dictionaries with values to describe, each with its value-bearing event
 *  relations — what the server packs the `stats` ranges from. */
export function statsDictionaries(mapping: SchemaMapping): { dictKey: string; relations: string[] }[] {
  return conceptRelations(mapping).flatMap((dict) => {
    const relations = valuedEventsOf(mapping, dict).map((e) => e.name)
    return dict.key && relations.length ? [{ dictKey: dict.key, relations }] : []
  })
}

const idRange = (column: string, range: StatsRange) => [
  range.lo != null ? ` AND ${column} >= ${Number(range.lo)}` : '',
  range.hi != null ? ` AND ${column} <= ${Number(range.hi)}` : '',
].join('')

/**
 * The detail panel's value statistics (buildValueDistributionQuery,
 * buildValueHistogramQuery) for every concept of a range at once: one row per
 * (concept, bin) carrying the concept's figures, bin -1 holding the values
 * outside P1–P99. A row names a concept by its standard or its source column,
 * once when both are the same — as `concept_id = X OR source_concept_id = X`.
 *
 * Approximate quantiles: an exact one keeps every value of its group, which a
 * concept of a few hundred million values does not fit in.
 */
export function buildStatsUnitSql(mapping: SchemaMapping, range: StatsRange): string | null {
  const dict = conceptRelations(mapping).find((d) => d.key === range.dictKey)
  const events = dict ? valuedEventsOf(mapping, dict) : []
  const parts: string[] = []
  for (const e of events) {
    const value = `CAST(e.value_number AS DOUBLE) AS v FROM ${e.name} e WHERE e.value_number IS NOT NULL`
    if (dict && countsByCode(e)) {
      // Joined to the ids of the range alone, not through the whole dictionary
      // as the relation itself would (countsByCode).
      const ids = `(SELECT concept_terminology, concept_code, concept_id FROM ${idByCode(dict)} _ids WHERE concept_id IS NOT NULL${idRange('concept_id', range)})`
      parts.push(`SELECT d.concept_id AS cid, CAST(e.value_number AS DOUBLE) AS v FROM ${codesRelation(e.name)} e INNER JOIN ${ids} d ON e.concept_terminology = d.concept_terminology AND e.concept_code = d.concept_code WHERE e.value_number IS NOT NULL`)
    } else {
      parts.push(`SELECT e.concept_id AS cid, ${value} AND e.concept_id IS NOT NULL${idRange('e.concept_id', range)}`)
    }
    if (has(e, 'source_concept_id')) {
      parts.push(`SELECT e.source_concept_id AS cid, ${value} AND e.source_concept_id IS NOT NULL AND e.source_concept_id IS DISTINCT FROM e.concept_id${idRange('e.source_concept_id', range)}`)
    }
  }
  if (!dict || parts.length === 0) return null
  const q = (p: number) => `APPROX_QUANTILE(v, ${p})`
  return `WITH vals AS (
  ${parts.join('\n  UNION ALL\n  ')}
), agg AS (
  SELECT cid, COUNT(*) AS value_count, MIN(v) AS min_val, MAX(v) AS max_val, AVG(v) AS mean_val, STDDEV_SAMP(v) AS std_val,
    ${q(0.01)} AS p01, ${q(0.25)} AS q1_val, ${q(0.5)} AS median_val, ${q(0.75)} AS q3_val, ${q(0.99)} AS p99
  FROM vals
  GROUP BY cid
), binned AS (
  SELECT vals.cid AS cid,
    CASE WHEN vals.v < agg.p01 OR vals.v > agg.p99 THEN -1
      ELSE CAST(FLOOR((vals.v - agg.p01) / NULLIF((agg.p99 - agg.p01) / ${STATS_BINS}.0, 0)) AS BIGINT) END AS bin
  FROM vals
  INNER JOIN agg ON vals.cid = agg.cid
), hist AS (
  SELECT cid, bin, COUNT(*) AS bin_count
  FROM binned
  GROUP BY cid, bin
)
SELECT ${dictKeyLit(dict)} AS dict_key, agg.cid AS concept_id, hist.bin AS bin, hist.bin_count AS bin_count,
  agg.value_count AS value_count, agg.min_val AS min_val, agg.max_val AS max_val, agg.mean_val AS mean_val,
  agg.std_val AS std_val, agg.p01 AS p01, agg.q1_val AS q1_val, agg.median_val AS median_val, agg.q3_val AS q3_val,
  agg.p99 AS p99
FROM agg
INNER JOIN hist ON agg.cid = hist.cid`
}

/** The `stats` step's units over the ranges the server packed. */
export function planStatsUnits(mapping: SchemaMapping, ranges: readonly StatsRange[]): ConceptCountUnit[] {
  return ranges.flatMap((range, i) => {
    const sql = buildStatsUnitSql(mapping, range)
    return sql ? [{ key: `stats-${i + 1}-of-${ranges.length}`, step: 'stats' as const, sql }] : []
  })
}

/** The steps a run has units for: rows and patients unless every dictionary
 *  holds that count, statistics when some event records a value. */
export function countableSteps(mapping: SchemaMapping | undefined): Record<ConceptCountStep, boolean> {
  if (!mapping) return { records: false, patients: false, stats: false }
  return {
    records: countedEvents(mapping, 'record_count').length > 0,
    patients: countedEvents(mapping, 'patient_count').length > 0,
    stats: statsDictionaries(mapping).length > 0,
  }
}

/** Every unit of a run over these patient slices, records first. */
export function planConceptCountUnits(mapping: SchemaMapping, slices: readonly SerializedRange[]): ConceptCountUnit[] {
  const units: ConceptCountUnit[] = []
  countedEvents(mapping, 'record_count').forEach(({ event, dict }, i) => {
    units.push({ key: `records-${i}-std`, step: 'records', sql: buildRecordUnitSql(event, dict, 'concept_id') })
    if (has(event, 'source_concept_id')) {
      units.push({ key: `records-${i}-src`, step: 'records', sql: buildRecordUnitSql(event, dict, 'source_concept_id') })
    }
  })
  const ranges = slices.length ? slices : [{}]
  ranges.forEach((range, i) => {
    const sql = buildPatientUnitSql(mapping, range)
    if (sql) units.push({ key: `patients-${i + 1}-of-${ranges.length}`, step: 'patients', sql })
  })
  return units
}

/** The counted event relations, each once, with their dictionary. */
function typeCheckedPairs(mapping: SchemaMapping): { event: ClassRelation; dict: ClassRelation }[] {
  const seen = new Set<string>()
  return [...countedEvents(mapping, 'record_count'), ...countedEvents(mapping, 'patient_count')].filter(({ event }) => {
    // Keyed by (terminology, code): its concept_id is the dictionary's own,
    // looked up through the whole dictionary — nothing to compare, and far from
    // the one-row read the check means to be.
    if (event.compositeConceptKey) return false
    if (seen.has(event.name)) return false
    seen.add(event.name)
    return true
  })
}

/**
 * The type of `concept_id` in each counted event relation and in its
 * dictionary, from one non-NULL row of each — cheap, it stops at the first row.
 */
export function buildConceptIdTypesSql(mapping: SchemaMapping): string | null {
  const firstType = (relation: string) => `(SELECT typeof(concept_id) FROM ${relation} WHERE concept_id IS NOT NULL LIMIT 1)`
  const parts = typeCheckedPairs(mapping).map(({ event, dict }) =>
    `SELECT '${esc(event.key ?? event.name)}' AS event, '${esc(event.name)}' AS relation, ${firstType(event.name)} AS event_type, ${firstType(dict.name)} AS dictionary_type`,
  )
  return parts.length ? parts.join('\nUNION ALL\n') : null
}

export interface ConceptIdTypeConflict {
  event: string
  /** The event relation: what rows are matched on, `event` being a display label
   *  two relations can share. */
  relation: string
  eventType: string
  dictionaryType: string
  /** The relation of the text side, the one whose ids DuckDB casts in the join. */
  textRelation: string
}

const isTextType = (type: string) => /^(VARCHAR|TEXT|STRING|CHAR|BPCHAR)/i.test(type)

/** The rows of `buildConceptIdTypesSql` pairing a text id with a numeric one. */
export function conceptIdTypeConflicts(mapping: SchemaMapping, rows: readonly Record<string, unknown>[]): ConceptIdTypeConflict[] {
  const pairs = new Map(typeCheckedPairs(mapping).map((p) => [p.event.name, p]))
  return rows.flatMap((r) => {
    const pair = pairs.get(String(r.relation))
    const eventType = r.event_type == null ? null : String(r.event_type)
    const dictionaryType = r.dictionary_type == null ? null : String(r.dictionary_type)
    if (!pair || !eventType || !dictionaryType || isTextType(eventType) === isTextType(dictionaryType)) return []
    const textRelation = isTextType(eventType) ? pair.event.name : pair.dict.name
    return [{ event: String(r.event), relation: pair.event.name, eventType, dictionaryType, textRelation }]
  })
}

/**
 * The first id of each conflict's text side that is not a whole number. DuckDB
 * joins text digits to a number fine, but fails on the first text code that is
 * not one (`'Y831'`). This scans the whole relation when every id is a number,
 * so it runs only for the pairs whose types differ.
 */
export function buildNonNumericIdSql(conflicts: readonly ConceptIdTypeConflict[]): string | null {
  const parts = conflicts.map((c) =>
    `SELECT '${esc(c.relation)}' AS relation, (SELECT CAST(concept_id AS VARCHAR) FROM ${c.textRelation} WHERE concept_id IS NOT NULL AND TRY_CAST(concept_id AS BIGINT) IS NULL LIMIT 1) AS code`,
  )
  return parts.length ? parts.join('\nUNION ALL\n') : null
}

export interface ConceptIdTypeMismatch {
  event: string
  eventType: string
  dictionaryType: string
  /** The first id of the text side that is not a number. */
  code: string
}

/** The conflicts whose text side holds an id that is not a number, from the
 *  rows of `buildNonNumericIdSql`. */
export function conceptIdTypeMismatches(
  conflicts: readonly ConceptIdTypeConflict[],
  codeRows: readonly Record<string, unknown>[],
): ConceptIdTypeMismatch[] {
  const codes = new Map(codeRows.map((r) => [String(r.relation), r.code]))
  return conflicts.flatMap(({ event, relation, eventType, dictionaryType }) => {
    const code = codes.get(relation)
    return code == null ? [] : [{ event, eventType, dictionaryType, code: String(code) }]
  })
}

/**
 * The counted events whose ids cannot be joined to their dictionary's. Types
 * first, from one row of each side; the full scan for a non-numeric id only on
 * the text side of a pair whose types differ.
 */
export async function findConceptIdTypeMismatches(
  mapping: SchemaMapping,
  query: (sql: string) => Promise<Record<string, unknown>[]>,
): Promise<ConceptIdTypeMismatch[]> {
  const typesSql = buildConceptIdTypesSql(mapping)
  if (!typesSql) return []
  const conflicts = conceptIdTypeConflicts(mapping, await query(typesSql))
  const codesSql = buildNonNumericIdSql(conflicts)
  if (!codesSql) return []
  return conceptIdTypeMismatches(conflicts, await query(codesSql))
}

/**
 * Identifies what a run counts: each unit's SQL as the server runs it, with the
 * relations it reads — emptied or without a join where the database lacks their
 * table (`tables`). A paused run resumes only when re-planning it over its own
 * slices gives the same signature — a changed mapping, a build whose SQL
 * changed, or a table that has since appeared starts over instead of mixing counts.
 */
export function conceptCountSignature(units: readonly ConceptCountUnit[], mapping: SchemaMapping, tables?: readonly string[] | null): string {
  const body = units.map((u) => `${u.key}\n${withClassRelations(u.sql, mapping, tables)}`).join('\n\n')
  return deterministicId(`concept-counts-v${CONCEPT_COUNT_VERSION}`, body)
}

export interface ConceptCountStepProgress {
  done: number
  total: number
}

export type ConceptCountState = 'none' | 'partial' | 'complete'

export interface ConceptCountProgress {
  state: ConceptCountState
  records: ConceptCountStepProgress
  patients: ConceptCountStepProgress
  /** `total` 0 until the step is planned. */
  stats: ConceptCountStepProgress
  finishedAt: string | null
  statsFinishedAt: string | null
}

const NO_PROGRESS: ConceptCountProgress = {
  state: 'none',
  records: { done: 0, total: 0 },
  patients: { done: 0, total: 0 },
  stats: { done: 0, total: 0 },
  finishedAt: null,
  statsFinishedAt: null,
}

/** Where a stored run stands, from its manifest and the units the server has. */
export function conceptCountProgress(
  run: { manifest: Partial<ConceptCountManifest>; doneUnits: readonly string[] } | null | undefined,
): ConceptCountProgress {
  const units = run?.manifest.units
  if (!run || !Array.isArray(units)) return NO_PROGRESS
  const done = new Set(run.doneUnits)
  const step = (s: ConceptCountStep): ConceptCountStepProgress => {
    const of = units.filter((u) => u.step === s)
    return { done: of.filter((u) => done.has(u.key)).length, total: of.length }
  }
  const records = step('records')
  const patients = step('patients')
  const stats = step('stats')
  // The rows and the patients: the statistics are an extra, never awaited.
  const complete = !!run.manifest.finishedAt && records.done === records.total && patients.done === patients.total
  return {
    state: complete ? 'complete' : 'partial',
    records,
    patients,
    stats,
    finishedAt: run.manifest.finishedAt ?? null,
    statsFinishedAt: stats.total > 0 && stats.done === stats.total ? run.manifest.statsFinishedAt ?? null : null,
  }
}

/** Assemblies of the list while patients are counted, besides the one at the end. */
const ASSEMBLIES_PER_STEP = 10
/** Key of an assembly in a step's job: the server runs it as such (query_jobs.ASSEMBLE_KEY_PREFIX). */
export const ASSEMBLE_PREFIX = 'assemble-'

/**
 * A step's job: its units in order, with an assembly of the list after the last
 * and, for the patients, after every tenth or so of them — never beside a unit.
 * `assembleSql(final)` is the list as it stands after the step's last unit or before.
 */
export function stepJobItems(
  step: ConceptCountStep,
  units: readonly { key: string; sql: string }[],
  assembleSql: (final: boolean) => string,
): { key: string; sql: string }[] {
  const items: { key: string; sql: string }[] = []
  const n = units.length
  units.forEach((u, j) => {
    items.push({ key: u.key, sql: u.sql })
    const last = j === n - 1
    const mark = step === 'patients' && Math.floor((ASSEMBLIES_PER_STEP * (j + 1)) / n) > Math.floor((ASSEMBLIES_PER_STEP * j) / n)
    if (last || mark) items.push({ key: `${ASSEMBLE_PREFIX}${j}`, sql: assembleSql(last) })
  })
  return items
}
