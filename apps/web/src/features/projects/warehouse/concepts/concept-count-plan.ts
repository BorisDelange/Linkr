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
 *
 * Each unit's rows are kept server-side as one file
 * (`concept_cache_fs.write_unit`); a resume skips the units already there.
 *
 * A dictionary mapping `record_count` / `patient_count` holds its counts
 * already: its events get no unit for that count.
 */

import type { SchemaMapping } from '@/types/schema-mapping'
import { conceptRelations, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { rangeCondition } from '@/lib/duckdb/catalog-queries'
import type { SerializedRange } from '@/lib/duckdb/catalog-compute'
import { deterministicId } from '@/lib/deterministic-id'
import { escSql as esc } from '@/lib/format-helpers'

/** Bumped when the unit SQL changes, so a paused run of an older build restarts. */
export const CONCEPT_COUNT_VERSION = 1

/**
 * Event rows per patient slice of the `patients` step. A slice's time is mostly
 * its distinct-patient grouping, so it scales with this; on a billion unsorted
 * rows (8 cores, SSD) 100 M-row slices took 15–33 s — too close to a 60 s
 * proxy timeout for a slower server.
 */
export const CONCEPT_SLICE_ROWS = 50_000_000

export type ConceptCountStep = 'records' | 'patients'

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
  startedAt: string
  finishedAt?: string
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

/** Rows of one event table naming each concept, standard or source column. */
export function buildRecordUnitSql(event: ClassRelation, dict: ClassRelation, column: 'concept_id' | 'source_concept_id'): string {
  // A source column repeating the standard one would count the row twice for that concept.
  const repeat = column === 'source_concept_id' ? ' AND e.source_concept_id IS DISTINCT FROM e.concept_id' : ''
  return `SELECT ${dictKeyLit(dict)} AS dict_key, e.${column} AS concept_id, COUNT(*)::BIGINT AS record_count, NULL::BIGINT AS patient_count
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
  finishedAt: string | null
}

const NO_PROGRESS: ConceptCountProgress = {
  state: 'none',
  records: { done: 0, total: 0 },
  patients: { done: 0, total: 0 },
  finishedAt: null,
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
  const complete = !!run.manifest.finishedAt && records.done === records.total && patients.done === patients.total
  return {
    state: complete ? 'complete' : 'partial',
    records,
    patients,
    finishedAt: run.manifest.finishedAt ?? null,
  }
}
