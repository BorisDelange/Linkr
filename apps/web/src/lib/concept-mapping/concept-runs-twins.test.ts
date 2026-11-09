/**
 * Golden twin fixture for the pure half of a concept run, which the server runs
 * in Python (apps/api/app/services/concept_runs/profiles.py, checked against the
 * same file by apps/api/tests/test_concept_runs_profiles.py): ranking, batch
 * packing, the profiles read from a batch query's rows, the profile store's
 * merge and filter, the extracted CSV rows.
 *
 * The expected outputs are this TypeScript's. The batch rows of the `duckdb:`
 * cases come from `buildBatchProfileQuery` run on DuckDB, shaped as the server
 * hands them (`_row_to_json`: a DATE as its ISO text).
 *
 * To regenerate after an intentional change of one of these functions:
 *   GOLDEN_UPDATE=1 npx vitest run src/lib/concept-mapping/concept-runs-twins.test.ts
 * then run the Python twin, which fails until the change is ported.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import {
  DEFAULT_PROFILE_OPTIONS,
  availableSections,
  buildBatchProfileQuery,
  effectiveSections,
  emptyScalar,
  frequencyLabel,
  localizedPresetLabel,
  packProfileBatches,
  readBatchProfiles,
  resolveProfileSource,
  type ConceptToProfile,
  type ProfileOptions,
  type ProfileOutcome,
  type ProfileSections,
} from './concept-profile'
import {
  dictionaryWalkIds,
  extractedRows,
  extractionCsvHeader,
  extractionCsvRows,
  mergeTableCounts,
  planConceptWalk,
  rankConceptIds,
  sortNeedsCounts,
  type ConceptCounts,
  type ExtractionSort,
} from './source-extraction'
import {
  exactOptions,
  filterProfile,
  mergeProfile,
  missingSections,
  sectionSet,
  sectionsOf,
  variantOf,
  type ProfileVariant,
  type SectionKey,
  type StoredProfile,
} from '@/lib/concept-profiles/profile-store'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', '__fixtures__', 'concept-runs', 'profiles.json')
const UPDATE = process.env.GOLDEN_UPDATE === '1'

type Row = Record<string, unknown>
type Case = Row & { name: string }
type Fixture = Record<string, Case[]>

// ---------------------------------------------------------------------------
// What each section runs
// ---------------------------------------------------------------------------

const COMPUTE: Record<string, (c: Case) => unknown> = {
  sortNeedsCounts: (c) => sortNeedsCounts(c.sort as ExtractionSort),
  dictionaryWalkIds: (c) => dictionaryWalkIds(c.rows as Row[]),
  mergeTableCounts: (c) => {
    const { counts, homes } = mergeTableCounts(c.perTable as ConceptCounts[][])
    return { counts, homes: [...homes] }
  },
  rankConceptIds: (c) => rankConceptIds(c.counts as ConceptCounts[], c.sort as ExtractionSort, (c.allIds ?? undefined) as number[] | undefined),
  planConceptWalk: (c) =>
    planConceptWalk(c.counts as ConceptCounts[], c.sort as ExtractionSort, c.dictionaryIds as number[], c.onlyWithRecords as boolean),
  packProfileBatches: (c) => {
    const rows = new Map(c.rows as [number, number | null][])
    return packProfileBatches(c.conceptIds as number[], (id) => rows.get(id) ?? undefined, c.maxRows as number | undefined, c.maxConcepts as number | undefined)
  },
  frequencyLabel: (c) => frequencyLabel(c.medianHours as number | null),
  batchProfiles: (c) => [
    ...readBatchProfiles(
      c.rows as Row[],
      c.concepts as ConceptToProfile[],
      c.sections as ProfileSections,
      c.options as ProfileOptions,
      c.emptyScalar as Row,
      c.dataSource as string | undefined,
    ),
  ],
  sectionsOf: (c) => sectionsOf(c.sections as ProfileSections),
  sectionSet: (c) => sectionSet(c.keys as SectionKey[]),
  variantOf: (c) => variantOf(c.options as ProfileOptions),
  exactOptions: (c) => exactOptions(c.options as ProfileOptions, (c.sections ?? undefined) as ProfileSections | undefined),
  missingSections: (c) =>
    missingSections((c.stored ?? undefined) as StoredProfile | undefined, c.wanted as ProfileSections, c.variant as ProfileVariant, c.fingerprint as string),
  mergeProfile: (c) =>
    mergeProfile(
      (c.stored ?? undefined) as StoredProfile | undefined,
      c.fresh as ProfileOutcome,
      c.computed as SectionKey[],
      c.identity as { dictKey: string; conceptId: number },
      c.variant as ProfileVariant,
      c.fingerprint as string,
      c.computedAt as string,
    ),
  filterProfile: (c) => filterProfile(c.stored as StoredProfile, (c.options ?? undefined) as ProfileOptions | undefined),
  extractedRows: (c) => {
    const rows = extractedRows(c.page as Row[], new Map(c.profiles as [number, ProfileOutcome][]), {
      metadata: c.metadata as boolean,
      counts: c.counts as boolean,
      recordTotals: c.recordTotals ? new Map(c.recordTotals as [number, number][]) : undefined,
    })
    return { rows, csv: extractionCsvRows(rows) }
  },
  extractionCsvHeader: () => extractionCsvHeader(),
  numberToString: (c) => String(c.value),
  jsonStringify: (c) => JSON.stringify(c.entries ? Object.fromEntries(c.entries as [string, unknown][]) : c.value),
}

describe('concept run twins (golden fixture shared with the Python port)', () => {
  if (UPDATE) {
    it('regenerates the fixture', async () => {
      const fixture: Fixture = {}
      for (const [section, cases] of Object.entries(await buildCases())) {
        fixture[section] = cases.map((c) => ({ ...c, expected: COMPUTE[section](c) }))
      }
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, `${pretty(fixture)}\n`)
    }, 120_000)
  }

  for (const section of Object.keys(COMPUTE)) {
    it(section, () => {
      const cases = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture)[section]
      expect(cases?.length, `fixture section ${section}`).toBeGreaterThan(0)
      for (const c of cases) {
        expect(JSON.stringify(COMPUTE[section](c)), `${section}: ${c.name}`).toBe(JSON.stringify(c.expected))
      }
    })
  }
})

/** One line per record of scalars, so a row of the batch reads as one line. */
function pretty(value: unknown, indent = ''): string {
  const flat = JSON.stringify(value) ?? 'null'
  const leaf = (v: unknown) => v === null || typeof v !== 'object'
  if (leaf(value) || flat.length + indent.length <= 100) return flat
  if (Array.isArray(value) ? value.every(leaf) : Object.values(value as Row).every(leaf)) return flat
  const inner = `${indent}  `
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + pretty(v, inner)).join(',\n')}\n${indent}]`
  const entries = Object.entries(value as Row).filter(([, v]) => v !== undefined)
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pretty(v, inner)}`).join(',\n')}\n${indent}}`
}

// ---------------------------------------------------------------------------
// The cases (read only when regenerating)
// ---------------------------------------------------------------------------

async function buildCases(): Promise<Fixture> {
  return {
    sortNeedsCounts: (['id', 'code', 'name', 'records', 'patients'] as const).map((key) => ({
      name: key, sort: { key, direction: 'desc' },
    })),
    dictionaryWalkIds: WALK_IDS,
    mergeTableCounts: MERGE_COUNTS,
    rankConceptIds: RANKINGS,
    planConceptWalk: WALKS,
    packProfileBatches: PACKINGS,
    frequencyLabel: [null, 0, -1, 0.5, 0.999, 1, 1.5, 1.999, 2, 2.4999, 2.5, 3.5, 11.49, 11.5, 11.99, 12, 35.99, 36, 167.9, 168, 1000, '5']
      .map((medianHours) => ({ name: String(medianHours), medianHours })),
    batchProfiles: [...await duckdbBatches(), ...HAND_BATCHES],
    sectionsOf: [
      { name: 'counts absent reads as on', sections: { numeric: true, histogram: false, categorical: true, unit: false, frequency: false, temporal: false, hospitalUnits: false, missingRate: false, perPatient: false } },
      { name: 'counts off', sections: { ...DEFAULT_PROFILE_OPTIONS.sections, counts: false, unit: false } },
      { name: 'defaults', sections: DEFAULT_PROFILE_OPTIONS.sections },
    ],
    sectionSet: [
      { name: 'some', keys: ['numeric', 'counts', 'temporal'] },
      { name: 'none', keys: [] },
    ],
    variantOf: [
      { name: 'defaults', options: DEFAULT_PROFILE_OPTIONS },
      { name: 'mad', options: { ...DEFAULT_PROFILE_OPTIONS, outlierMethod: 'mad', outlierCoef: 3, bins: 12 } },
    ],
    exactOptions: [
      { name: 'reader sections', options: { ...DEFAULT_PROFILE_OPTIONS, topN: 5, minPatients: 20 } },
      { name: 'given sections', options: DEFAULT_PROFILE_OPTIONS, sections: sectionSet(['numeric', 'histogram']) },
    ],
    missingSections: MISSING,
    mergeProfile: MERGES,
    filterProfile: FILTERS,
    extractedRows: EXTRACTIONS,
    extractionCsvHeader: [{ name: 'header' }],
    numberToString: NUMBERS.map((value) => ({ name: String(value), value })),
    jsonStringify: JSON_VALUES,
  }
}

// ---- The walk ---------------------------------------------------------------

const WALK_IDS: Case[] = [
  {
    name: 'by ord, numerically, dropping 0 and non-numbers',
    rows: [
      { concept_id: 5, ord: 3 }, { concept_id: 7, ord: 1 }, { concept_id: 0, ord: 2 },
      { concept_id: 9, ord: '10' }, { concept_id: 'x', ord: 4 }, { concept_id: 11, ord: '9' },
    ],
  },
  { name: 'arrival order without ord', rows: [{ concept_id: 3 }, { concept_id: '1' }, { concept_id: 2 }] },
  { name: 'a null ord sorts as 0', rows: [{ concept_id: 1, ord: 2 }, { concept_id: 2, ord: null }, { concept_id: 3, ord: 1 }] },
]

const MERGE_COUNTS: Case[] = [
  {
    name: 'records add up, the richest table is home, a tie stays with the earlier table',
    perTable: [
      [
        { concept_id: 1, record_count: 100, patient_count: 10 }, { concept_id: 2, record_count: 5, patient_count: 2 },
        { concept_id: 0, record_count: 999, patient_count: 1 }, { concept_id: 'abc', record_count: 1, patient_count: 1 },
      ],
      [
        { concept_id: 1, record_count: 100, patient_count: 50 }, { concept_id: 2, record_count: 30, patient_count: 9 },
        { concept_id: '3', record_count: null, patient_count: null },
      ],
      [{ concept_id: 2, record_count: '40', patient_count: 12 }, { concept_id: 4, record_count: 7, patient_count: null }],
    ],
  },
  { name: 'no table', perTable: [] },
]

const COUNTS = [
  { concept_id: 10, record_count: 5, patient_count: 2 },
  { concept_id: 11, record_count: 50, patient_count: 1 },
  { concept_id: 12, record_count: 5, patient_count: null },
  { concept_id: 13, record_count: '20', patient_count: 20 },
  { concept_id: 14, record_count: null, patient_count: 3 },
]
const ALL_IDS = [14, 13, 12, 11, 10, 20, 15]

const RANKINGS: Case[] = [
  { name: 'records desc, ties by id, uncounted last', counts: COUNTS, sort: { key: 'records', direction: 'desc' }, allIds: ALL_IDS },
  { name: 'records asc', counts: COUNTS, sort: { key: 'records', direction: 'asc' }, allIds: ALL_IDS },
  { name: 'patients desc, null as 0', counts: COUNTS, sort: { key: 'patients', direction: 'desc' }, allIds: ALL_IDS },
  { name: 'patients asc, the counted ids only', counts: COUNTS, sort: { key: 'patients', direction: 'asc' } },
]

const WALK_COUNTS = [
  { concept_id: 1, record_count: 10, patient_count: 3 },
  { concept_id: 2, record_count: 0, patient_count: 0 },
  { concept_id: 3, record_count: 5, patient_count: 4 },
  { concept_id: 4, record_count: null, patient_count: null },
]
const DICTIONARY_IDS = [4, 0, 3, 2, 1, 5]

const WALKS: Case[] = [
  { name: 'code order kept', counts: WALK_COUNTS, sort: { key: 'code', direction: 'asc' }, dictionaryIds: DICTIONARY_IDS, onlyWithRecords: false },
  { name: 'code order, only with records', counts: WALK_COUNTS, sort: { key: 'code', direction: 'asc' }, dictionaryIds: DICTIONARY_IDS, onlyWithRecords: true },
  { name: 'records desc, only with records', counts: WALK_COUNTS, sort: { key: 'records', direction: 'desc' }, dictionaryIds: DICTIONARY_IDS, onlyWithRecords: true },
  { name: 'patients asc, all', counts: WALK_COUNTS, sort: { key: 'patients', direction: 'asc' }, dictionaryIds: DICTIONARY_IDS, onlyWithRecords: false },
]

const PACKINGS: Case[] = [
  { name: 'row cap', conceptIds: [1, 2, 3, 4, 5, 6], rows: [1, 2, 3, 4, 5, 6].map((id) => [id, 2]), maxRows: 5, maxConcepts: 100 },
  { name: 'exact fit then over', conceptIds: [1, 2, 3], rows: [[1, 5], [2, 5], [3, 1]], maxRows: 10, maxConcepts: 100 },
  { name: 'concept cap', conceptIds: [1, 2, 3, 4, 5, 6, 7], rows: [], maxRows: 1000, maxConcepts: 3 },
  { name: 'oversize concept alone', conceptIds: [1, 2, 3, 4], rows: [[1, 2], [2, 50], [3, 2], [4, 2]], maxRows: 10, maxConcepts: 100 },
  { name: 'oversize first', conceptIds: [1, 2], rows: [[1, 50], [2, 1]], maxRows: 10, maxConcepts: 100 },
  { name: 'unknown counts weigh nothing', conceptIds: [1, 2, 3, 4, 5], rows: [[2, null]], maxRows: 0, maxConcepts: 2 },
  { name: 'defaults', conceptIds: Array.from({ length: 250 }, (_, i) => i + 1), rows: [[7, 4_999_990], [8, 20]] },
  { name: 'empty', conceptIds: [], rows: [] },
]

// ---- Batches on DuckDB --------------------------------------------------------

const OMOP_V1: SchemaMappingV1 = {
  presetId: 'omop-5.4',
  presetLabel: { en: 'OMOP' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitDetailTable: {
    table: 'visit_detail',
    idColumn: 'visit_detail_id',
    visitIdColumn: 'visit_occurrence_id',
    patientIdColumn: 'person_id',
    startDateColumn: 'vds',
    endDateColumn: 'vde',
    unitColumn: 'care_site_id',
    unitNameTable: 'care_site',
    unitNameIdColumn: 'care_site_id',
    unitNameColumn: 'care_site_name',
  },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    Measurements: {
      table: 'measurement',
      conceptIdColumn: 'mc',
      sourceConceptIdColumn: 'msc',
      valueColumn: 'v',
      valueStringColumn: 'vs',
      valueUnitColumn: 'u',
      patientIdColumn: 'person_id',
      dateColumn: 'dt',
    },
  },
}

// Concepts: 1 mixed, 2 categories that repeat its numbers, 3 text codes
// only, 4 five patients, 5 often empty, 7 named only as a source concept, 8
// absent, 99 the source concept of every kind of row.
const SETUP = `
CREATE TABLE m AS
WITH r AS (
  SELECT i,
    hash(i * 7 + 1) % 1000 AS h1, hash(i * 7 + 2) % 1000 AS h2, hash(i * 7 + 3) % 1000 AS h3,
    hash(i * 7 + 4) % 1000 AS h4, hash(i * 7 + 5) % 1000 AS h5, hash(i * 7 + 6) % 1000 AS h6,
    hash(i * 7 + 7) % 1000 AS h7
  FROM range(6000) t(i)
), c AS (
  SELECT *, CASE WHEN h1 < 60 THEN NULL ELSE CAST(h1 % 7 + 1 AS INTEGER) END AS cid FROM r
)
SELECT
  CASE WHEN cid = 7 THEN 0 ELSE cid END AS concept_id,
  CASE WHEN cid = 7 THEN 7 WHEN h2 % 4 = 0 THEN NULL WHEN h2 % 4 = 1 THEN cid ELSE 99 END AS source_concept_id,
  CAST(CASE WHEN cid = 4 THEN h3 % 5 + 1 ELSE h3 % 200 + 1 END AS INTEGER) AS patient_id,
  CASE WHEN cid = 3 THEN NULL
       WHEN cid = 2 THEN CAST(h5 % 20 AS DOUBLE)
       WHEN cid = 5 AND h4 < 300 THEN NULL
       WHEN h4 < 100 THEN NULL
       ELSE ROUND(((h5 + h6 + h7) / 15.0) * (CASE WHEN h4 > 990 THEN 10 ELSE 1 END), 3) END AS value_number,
  CASE WHEN cid = 2 THEN CAST(CAST(h5 % 20 AS INTEGER) AS VARCHAR)
       WHEN cid = 3 THEN CASE h6 % 3 WHEN 0 THEN '0' WHEN 1 THEN ' 1' ELSE NULL END
       WHEN cid = 5 AND h4 < 300 THEN NULL
       ELSE CASE h6 % 8 WHEN 0 THEN NULL WHEN 1 THEN '' WHEN 2 THEN ' ' WHEN 3 THEN 'Négatif, "trace"' WHEN 4 THEN 'B'
            WHEN 5 THEN 'C' WHEN 6 THEN repeat('long', 20) ELSE CAST(h5 % 4 AS VARCHAR) END END AS value_string,
  CASE h7 % 4 WHEN 0 THEN NULL WHEN 1 THEN 'mg/dL' WHEN 2 THEN 'µmol/L' ELSE '' END AS unit,
  CASE WHEN h7 < 50 THEN NULL
       ELSE TIMESTAMP '2019-06-01 08:00:00' + to_days(CAST(h5 AS INTEGER)) + to_hours(CAST(h3 % 14 AS INTEGER)) END AS start_datetime
FROM c;
CREATE VIEW linkr_event_measurements AS SELECT * FROM m;
CREATE TABLE linkr_visit_detail AS
  SELECT p AS patient_id,
         TIMESTAMP '2019-06-01' + to_days(CAST(i * 250 AS INTEGER)) AS start_datetime,
         TIMESTAMP '2019-06-01' + to_days(CAST(i * 250 + 200 AS INTEGER)) AS end_datetime,
         'Ward ' || chr(CAST(65 + (p + i) % 6 AS INTEGER)) AS unit_name
  FROM range(1, 201) t(p), range(0, 4) r(i);
`

const DATE_COLUMNS = ['start_date', 'end_date']

async function duckdbBatches(): Promise<Case[]> {
  const duckdb = await import('@duckdb/duckdb-wasm/blocking')
  const dist = dirname(createRequire(import.meta.url).resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm'))
  const db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: join(dist, 'duckdb-node-mvp.worker.cjs') },
      eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: join(dist, 'duckdb-node-eh.worker.cjs') },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  )
  await db.instantiate()
  db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } })
  const conn = db.connect()
  for (const stmt of SETUP.split(';').map((s) => s.trim()).filter(Boolean)) conn.query(stmt)

  const mapping = mappingV1ToV2(OMOP_V1)
  const source = resolveProfileSource(mapping, 'concept')
  if (!source) throw new Error('no profile source')
  const batch = (name: string, ids: number[], options: ProfileOptions, reverse = false): Case => {
    const sections = effectiveSections(options.sections, availableSections(mapping, source))
    const rows = conn.query(buildBatchProfileQuery(mapping, source, ids, sections, options)).toArray()
      .map((r) => {
        const row = r.toJSON() as Row
        for (const c of DATE_COLUMNS) if (typeof row[c] === 'number') row[c] = new Date(row[c] as number).toISOString().slice(0, 10)
        return row
      })
    return {
      name: `duckdb: ${name}`,
      rows: reverse ? rows.reverse() : rows,
      concepts: ids.map((conceptId) => ({ conceptId, conceptName: `c${conceptId}` })),
      sections,
      options,
      emptyScalar: emptyScalar(source.event, sections),
      dataSource: localizedPresetLabel(mapping),
    }
  }
  const only = (keys: SectionKey[]) => sectionSet(['counts', ...keys])
  const cases = [
    batch('default thresholds, every section', [1, 2, 3, 4, 7, 8, 99], { ...DEFAULT_PROFILE_OPTIONS, minCategoryCount: 5 }),
    batch(
      'exact options, no fences, rows arriving reversed',
      [1, 2, 3, 4, 8],
      exactOptions({ ...DEFAULT_PROFILE_OPTIONS, outlierMethod: 'none', bins: 8 }, only(['numeric', 'histogram', 'categorical', 'unit'])),
      true,
    ),
    batch(
      'percentile fences, context sections',
      [1, 4, 7, 99],
      { ...DEFAULT_PROFILE_OPTIONS, outlierMethod: 'percentile', sections: only(['temporal', 'hospitalUnits', 'perPatient', 'frequency', 'missingRate']) },
    ),
    batch(
      'mad fences, short categories',
      [1, 3, 5],
      { ...DEFAULT_PROFILE_OPTIONS, outlierMethod: 'mad', outlierCoef: 2, minCategoryCount: 5, maxCategoryLength: 12, sections: only(['numeric', 'histogram', 'categorical']) },
    ),
  ]
  conn.close()
  return cases
}

// ---- Hand-written batches: what DuckDB would not give -------------------------

const scalar = (k: unknown, fields: Row): Row => ({
  block: 'scalar', k, ord: 0, ...Object.fromEntries(Object.entries(fields).map(([c, v]) => [`s_${c}`, v])),
})
const block = (name: string, k: unknown, ord: unknown, fields: Row): Row => ({ block: name, k, ord, ...fields })
const named = (ids: number[], prefix = 'c') => ids.map((conceptId) => ({ conceptId, conceptName: `${prefix}${conceptId}` }))

const SCALAR_SECTIONS: ProfileSections = {
  counts: true, numeric: false, histogram: false, categorical: false, unit: true,
  frequency: true, temporal: false, hospitalUnits: false, missingRate: true, perPatient: true,
}
const MEDIAN_HOURS = [0.5, 1, 1.999, 2, 2.5, 3.5, 11.49, 11.5, 12, 35.99, 36, 167.99, 168, 5000, 0, -3, null]
const NUMERIC_SECTIONS = { ...sectionSet(['counts', 'numeric', 'histogram']) }
const CATEGORY_SECTIONS = { ...sectionSet(['counts', 'numeric', 'categorical']) }
const CONTEXT_SECTIONS = { ...sectionSet(['counts', 'temporal', 'hospitalUnits']) }
const HAND_OPTIONS: ProfileOptions = { ...DEFAULT_PROFILE_OPTIONS, minPatients: 0 }

const categories = (k: number, values: string[]) =>
  values.map((category, i) => block('categorical', k, i + 1, { category, count: 100 - i, patients_count: i % 2 ? null : 10 + i, percentage: 12.5 }))
const numericRows = (k: number) => [
  scalar(k, { rows_count: 200, patients_count: 40, numeric_count: 150 }),
  block('numeric', k, 0, { min: 1, max: 9, mean: 5.1, median: 5, sd: 1.2, p5: 1.5, p25: 3, p75: 7, p95: 8.5, numeric_count: 150, numeric_patients_count: 40 }),
]

const HAND_BATCHES: Case[] = [
  {
    name: 'scalar sections: frequency labels, units, missing rate, records per patient',
    rows: [
      ...MEDIAN_HOURS.map((median_hours, i) => scalar(i + 1, {
        rows_count: 100 + i, patients_count: 20, missing_rate: [12.5, null, 0, 100][i % 4],
        unit: ['mg', '', null, 'µg/L'][i % 4],
        per_patient_mean: i === 3 ? '3.25' : i === 2 ? null : 2.5, per_patient_median: i === 2 ? null : 2,
        per_patient_min: i === 2 ? null : 1, per_patient_max: i === 3 ? 'x' : i === 2 ? null : 40,
        median_hours,
      })),
      scalar(30, { rows_count: 7, patients_count: 2, unit: 'g' }),
    ],
    concepts: named([...MEDIAN_HOURS.map((_, i) => i + 1), 30, 99], 'f'),
    sections: SCALAR_SECTIONS,
    options: HAND_OPTIONS,
    emptyScalar: {
      rows_count: 0, patients_count: 0, missing_rate: null, unit: null,
      per_patient_mean: null, per_patient_median: null, per_patient_min: null, per_patient_max: null, median_hours: null,
    },
    dataSource: 'Hand',
  },
  {
    name: 'numbers as text, null cells, histogram grids, unsorted bins',
    rows: [
      scalar(1, { rows_count: '1200', patients_count: '15', p1: 1, p25: 3, median: 4, p75: 6, p99: 9, numeric_count: '40' }),
      block('numeric', 1, 0, { min: '1.5', max: 9.5, mean: 4.25, median: 4, sd: 1.1, p5: 1.5, p25: 3, p75: 5.5, p95: 9, numeric_count: '40', numeric_patients_count: null }),
      ...[[2, 16, 4], [-3, 3, null], [0, '4', null], [-1, 7, 2], [1, 10, '3'], [-2, null, 1]].map(([i, count, patients]) =>
        block('histogram', 1, i, { bin_idx: i, step_m: 5, step_e: -2, count, patients_count: patients })),
      scalar('2', { rows_count: 50, patients_count: 12, numeric_count: 30 }),
      block('numeric', '2', 0, { min: null, max: null, mean: null, median: null, sd: null, p5: null, p25: null, p75: null, p95: null, numeric_count: 0, numeric_patients_count: 0 }),
      ...[0, 1].map((i) => block('histogram', '2', i, { bin_idx: i, step_m: 2, step_e: 3, count: 15, patients_count: 6 })),
      scalar(3, { rows_count: 20, patients_count: 12, numeric_count: 0 }),
      block('numeric', 3, 0, { min: 0, max: 0, mean: 0, median: 0, sd: null, p5: 0, p25: 0, p75: 0, p95: 0, numeric_count: 20, numeric_patients_count: 12 }),
      block('histogram', 3, 0, { bin_idx: 0, step_m: 1, step_e: 0, count: 20, patients_count: 12 }),
      scalar(4, { rows_count: 9, patients_count: 12 }),
      block('numeric', 4, 0, { min: 2, max: 3, mean: 2.5, median: 2.5, sd: 0.5, p5: 2, p25: 2, p75: 3, p95: 3, numeric_count: 9, numeric_patients_count: 12 }),
      scalar(5, { rows_count: null, patients_count: null, numeric_count: 12 }),
      block('numeric', 5, 0, { min: 10.2, max: 11.9, mean: 0.1, median: 1e-7, sd: 1e21, p5: 123456.789, p25: 10.5, p75: 11.5, p95: 11.8, numeric_count: 12, numeric_patients_count: null }),
      ...[[11, 2, 0], [10, 1, 0], [3, 1, -1], [4, 2, 1]].map(([i, m, e]) =>
        block('histogram', 5, i, { bin_idx: i, step_m: m, step_e: e, count: 3, patients_count: null })),
    ],
    concepts: named([1, 2, 3, 4, 5]),
    sections: NUMERIC_SECTIONS,
    options: { ...DEFAULT_PROFILE_OPTIONS, minPatients: 11 },
    emptyScalar: { rows_count: 0, patients_count: 0, p1: null, p25: null, median: null, p75: null, p99: null, numeric_count: 0 },
    dataSource: 'Hand',
  },
  {
    name: 'categories: masked by length in UTF-16 units, numbers written as text',
    rows: [
      ...numericRows(1), ...categories(1, [' 12 ', '0x1F', '1e3', '.5', '+3', '-0', '5.']),
      ...numericRows(2), ...categories(2, [' 12 ', '1_0']),
      ...numericRows(3), ...categories(3, ['Infinity']),
      ...numericRows(4), ...categories(4, ['\ufeff7', '\u00a08\u3000']),
      ...numericRows(5), ...categories(5, ['\u001c7']),
      scalar(6, { rows_count: 30, patients_count: 20, numeric_count: 0 }), ...categories(6, ['0', '1']),
      scalar(7, { rows_count: 30, patients_count: 20, numeric_count: 0 }), ...categories(7, ['abc😀😀😀', 'ab😀😀😀', 'é"\n,x']),
      scalar(8, { rows_count: 30, patients_count: 20, numeric_count: 0 }), ...categories(8, ['too long here']),
    ],
    concepts: named([1, 2, 3, 4, 5, 6, 7, 8]),
    sections: CATEGORY_SECTIONS,
    options: { ...HAND_OPTIONS, maxCategoryLength: 8 },
    emptyScalar: { rows_count: 0, patients_count: 0, p1: null, p25: null, median: null, p75: null, p99: null, numeric_count: 0 },
    dataSource: 'Hand',
  },
  {
    name: 'temporal and wards of a table without patients',
    rows: [
      scalar(1, { rows_count: 100, patients_count: null }),
      block('temporal', 1, 2021, { year: 2021, count: 30, patients_count: null, percentage: 30, start_date: '2019-06-03', end_date: '2021-12-30' }),
      block('temporal', 1, 2019, { year: 2019, count: '20', patients_count: null, percentage: 20, start_date: '2019-06-03', end_date: '2021-12-30' }),
      block('temporal', 1, 2020, { year: 2020, count: 50, patients_count: null, percentage: 50, start_date: '2019-06-03', end_date: '2021-12-30' }),
      block('hospitalUnits', 1, 2, { unit: 'Cardiologie, "B"', count: 8, patients_count: 2, percentage: 40 }),
      block('hospitalUnits', 1, 1, { unit: 'ICU', count: '12', patients_count: null, percentage: 60 }),
      scalar(2, { rows_count: 4, patients_count: null }),
      block('temporal', 2, 2020, { year: 2020, count: 4, percentage: 100, end_date: '2020-02-01' }),
    ],
    concepts: [...named([1, 2]), { conceptId: 3, conceptName: '' }],
    sections: CONTEXT_SECTIONS,
    options: { ...DEFAULT_PROFILE_OPTIONS, minPatients: 11 },
    emptyScalar: { rows_count: 0, patients_count: null },
  },
  {
    name: 'withheld under the patient threshold, absent concepts',
    rows: [
      ...numericRows(1).map((r) => (r.block === 'scalar' ? { ...r, s_patients_count: 10, s_rows_count: 300 } : r)),
      ...categories(1, ['A']),
      scalar(3, { rows_count: 5, patients_count: null, numeric_count: 0 }),
      ...numericRows(4).map((r) => (r.block === 'scalar' ? { ...r, s_patients_count: 11 } : r)),
    ],
    concepts: [...named([1, 2]), { conceptId: 3 }, ...named([4])],
    sections: CATEGORY_SECTIONS,
    options: { ...DEFAULT_PROFILE_OPTIONS, minCategoryCount: 5 },
    emptyScalar: { rows_count: 0, patients_count: 0, p1: null, p25: null, median: null, p75: null, p99: null, numeric_count: 0 },
  },
]

// ---- The profile store ---------------------------------------------------------

const IQR: ProfileVariant = { outlierMethod: 'iqr', outlierCoef: 1.5, bins: 'auto' }
const STORED_JSON = {
  full_name: 'Glucose',
  data_source: 'OMOP',
  data_types: 'numeric',
  unit: 'mg/dL',
  numeric_data: { min: 0.1, p5: 1, median: 5.5, max: 30, numeric_count: 90 },
  histogram: [{ x: 2.5, count: 40, patients_count: 12 }, { x: 7.5, count: 50, patients_count: 14 }],
  missing_rate: 3.2,
}
const STORED: StoredProfile = {
  dictKey: 'concept', conceptId: 1, rowsCount: 100, patientsCount: 20, json: STORED_JSON,
  sections: ['counts', 'numeric', 'histogram', 'unit', 'missingRate'], variant: IQR, fingerprint: 'fp1', computedAt: '2026-11-01T00:00:00.000Z',
}
const FRESH: ProfileOutcome = {
  json: {
    full_name: 'Glucose (fasting)', data_source: 'OMOP', data_types: ['numeric', 'categorical'], unit: 'g/L',
    numeric_data: { min: 0.2, max: 31 }, categorical_data: [{ category: 'high', count: 12, percentage: 10 }],
    temporal_distribution: { start_date: '2020-01-01', end_date: '2021-01-01', by_year: [{ year: 2020, percentage: 100, count: 120 }] },
  },
  rowsCount: 120, patientsCount: 25,
}
const MERGE_BASE = { identity: { dictKey: 'concept', conceptId: 1 }, fingerprint: 'fp1', computedAt: '2026-11-08T00:00:00.000Z' }

const MISSING: Case[] = [
  { name: 'nothing stored: every asked section', stored: null, wanted: DEFAULT_PROFILE_OPTIONS.sections, variant: IQR, fingerprint: 'fp1' },
  { name: 'other data: every asked section', stored: STORED, wanted: sectionSet(['counts', 'numeric']), variant: IQR, fingerprint: 'fp2' },
  { name: 'partial store', stored: STORED, wanted: sectionSet(['counts', 'numeric', 'histogram', 'unit', 'categorical', 'temporal']), variant: IQR, fingerprint: 'fp1' },
  { name: 'other coefficient', stored: STORED, wanted: sectionSet(['counts', 'numeric', 'histogram', 'unit']), variant: { ...IQR, outlierCoef: 3 }, fingerprint: 'fp1' },
  { name: 'other bins', stored: STORED, wanted: sectionSet(['numeric', 'missingRate']), variant: { ...IQR, bins: 10 }, fingerprint: 'fp1' },
  { name: 'all answered', stored: STORED, wanted: sectionSet(['counts', 'numeric', 'missingRate']), variant: IQR, fingerprint: 'fp1' },
]

const MERGES: Case[] = [
  { name: 'nothing stored', stored: null, fresh: FRESH, computed: sectionsOf(DEFAULT_PROFILE_OPTIONS.sections), variant: IQR, ...MERGE_BASE },
  { name: 'adds sections, keeps the others', stored: STORED, fresh: FRESH, computed: ['categorical', 'temporal'], variant: IQR, ...MERGE_BASE },
  { name: 'other data drops what was kept', stored: { ...STORED, fingerprint: 'fp0' }, fresh: FRESH, computed: ['categorical'], variant: IQR, ...MERGE_BASE },
  { name: 'other variant drops the numeric sections kept', stored: STORED, fresh: FRESH, computed: ['categorical'], variant: { ...IQR, outlierMethod: 'mad' }, ...MERGE_BASE },
  { name: 'other variant, numeric recomputed', stored: STORED, fresh: FRESH, computed: ['numeric', 'histogram'], variant: { ...IQR, bins: 20 }, ...MERGE_BASE },
  { name: 'withheld fresh profile', stored: STORED, fresh: { json: null, rowsCount: 3, patientsCount: 2 }, computed: ['unit'], variant: IQR, ...MERGE_BASE },
  { name: 'stored without its JSON', stored: { ...STORED, json: null }, fresh: FRESH, computed: ['unit'], variant: IQR, ...MERGE_BASE },
]

const RICH_JSON = {
  missing_rate: 1.5,
  full_name: 'Sodium',
  data_types: 'stale',
  data_source: 'OMOP',
  unit: 'mmol/L',
  numeric_data: { min: 120, max: 160, mean: 140.2, numeric_count: 500 },
  histogram: [{ x: 125, count: 100 }, { x: 135, count: 400 }],
  categorical_data: [
    { category: 'A', count: 120, patients_count: 30, percentage: 40 },
    { category: 'B', count: 49, patients_count: 20, percentage: 16.3 },
    { category: 'ab😀😀😀', count: 60, percentage: 20 },
    { category: 'abc😀😀😀', count: 60, percentage: 20 },
    { category: 'C', percentage: 3.7 },
  ],
  measurement_frequency: { typical_interval: 'daily' },
  records_per_patient: { mean: 2.5, median: 2, min: 1, max: 9 },
  temporal_distribution: { start_date: '2020-01-01', end_date: '2020-12-31', by_year: [{ year: 2020, percentage: 100, count: 500 }] },
  hospital_units: ['ICU', 'ER', 'Cardio', 'Neuro'].map((unit, i) => ({ unit, count: 100 - i, percentage: 25 })),
}
const RICH: StoredProfile = { ...STORED, json: RICH_JSON, patientsCount: 20 }
const NUMBERS_AS_TEXT = [{ category: '1', count: 80 }, { category: ' 2.5 ', count: 70 }, { category: '0x10', count: 60 }]

const FILTERS: Case[] = [
  { name: 'default options', stored: RICH },
  { name: 'under the patient threshold', stored: { ...RICH, patientsCount: 5 }, options: DEFAULT_PROFILE_OPTIONS },
  { name: 'no patient count', stored: { ...RICH, patientsCount: null }, options: { ...DEFAULT_PROFILE_OPTIONS, minPatients: 1000 } },
  {
    name: 'sections, topN, minimum count and length',
    stored: RICH,
    options: { ...DEFAULT_PROFILE_OPTIONS, sections: sectionSet(['categorical', 'hospitalUnits']), topN: 2, minCategoryCount: 0, maxCategoryLength: 8 },
  },
  {
    name: 'categories repeating the numbers',
    stored: { ...RICH, json: { ...RICH_JSON, categorical_data: NUMBERS_AS_TEXT } },
    options: { ...DEFAULT_PROFILE_OPTIONS, minCategoryCount: 0 },
  },
  {
    name: 'empty numeric block',
    stored: { ...RICH, json: { ...RICH_JSON, numeric_data: {}, categorical_data: NUMBERS_AS_TEXT } },
    options: { ...DEFAULT_PROFILE_OPTIONS, minCategoryCount: 0 },
  },
]

// ---- The extracted CSV ----------------------------------------------------------

const PAGE: Row[] = [
  { concept_id: 1, concept_code: 'A-1', concept_name: 'Glucose, "fasting"', vocabulary_id: 'LOINC', category: 'Lab' },
  { concept_id: 1, concept_code: 'A-1b', concept_name: 'duplicate', vocabulary_id: 'LOINC', category: 'Lab' },
  { concept_id: 2, concept_code: 2002, concept_name: 'Créatinine\nsérique', vocabulary_id: null, category: null },
  { concept_id: '3', concept_code: null, concept_name: null, vocabulary_id: 'SNOMED', category: 'Cond' },
  { concept_id: 4, concept_code: '4', concept_name: 'withheld', vocabulary_id: 'X', category: '' },
  { concept_id: 5, concept_code: '5', concept_name: 'empty profile', vocabulary_id: 'X', category: 'Y' },
  { concept_id: 2 ** 53, concept_code: 'big', concept_name: 'hashed id', vocabulary_id: 'd_items', category: null },
]
const PROFILES: [number, ProfileOutcome][] = [
  [1, {
    json: {
      full_name: 'Glucose, "fasting"', data_source: 'OMOP', data_types: 'numeric', unit: 'mg/dL',
      numeric_data: { min: 0.1, p5: 1e-7, p25: 1, median: 12.5, mean: 123456789.123, p75: 1e21, p95: 2.5e-7, max: 9007199254740992, sd: 0.30000000000000004, numeric_count: 1200, numeric_patients_count: 300 },
      histogram: [{ x: 0.35, count: 3 }, { x: -1.5e-9, count: 4, patients_count: 2 }],
      missing_rate: 0,
      records_per_patient: { mean: 4, median: 3, min: 1, max: 40 },
    },
    rowsCount: 1200, patientsCount: 300,
  }],
  [2, {
    json: {
      full_name: 'Créatinine\nsérique', data_types: 'categorical',
      categorical_data: [{ category: 'Négatif, "trace"', count: 12, percentage: 33.3 }, { category: 'tab\there\\', count: 24, percentage: 66.7 }],
      temporal_distribution: { start_date: '2019-06-01', end_date: '2021-12-31', by_year: [{ year: 2019, percentage: 0.1, count: 1 }] },
    },
    rowsCount: 50, patientsCount: null,
  }],
  [3, { json: { full_name: '', hospital_units: [{ unit: 'Ward <A> & "B"', count: 3, percentage: 100 }] }, rowsCount: 3, patientsCount: 3 }],
  [4, { json: null, rowsCount: 5, patientsCount: 3 }],
  [5, { json: {}, rowsCount: 0, patientsCount: 0 }],
  [2 ** 53, { json: { data_types: 'numeric' }, rowsCount: 1, patientsCount: 1 }],
]

const EXTRACTIONS: Case[] = [
  { name: 'metadata and counts, record totals', page: PAGE, profiles: PROFILES, metadata: true, counts: true, recordTotals: [[1, 1500], [3, null], [5, 0]] },
  {
    name: 'metadata stops at the first concept without a profile',
    page: [PAGE[0], { ...PAGE[2], concept_id: 77 }, PAGE[3]], profiles: PROFILES, metadata: true, counts: true, recordTotals: null,
  },
  { name: 'metadata off', page: PAGE, profiles: [], metadata: false, counts: false, recordTotals: null },
  { name: 'counts off', page: PAGE, profiles: PROFILES, metadata: true, counts: false, recordTotals: [[1, 1500]] },
]

// ---- JavaScript's own formatting ----------------------------------------------------

const NUMBERS = [
  0, 0.1, 1e-7, 1e21, 1e-6, 1.234e-6, 123456789012345680000, 1.5e16, 9007199254740992, -3.25e-10, 5e-324,
  1.7976931348623157e308, 100, 12.5, 1e300, -0.5, 2.5e-7, 0.30000000000000004, 1e20, 999999999999999900000, 4.35,
]

const JSON_VALUES: Case[] = [
  ...NUMBERS.map((value) => ({ name: `number ${value}`, value })),
  { name: 'escapes', value: 'a"b\\c line\nbreak\ttab\r\b\f \u0001\u001f\u007f' },
  { name: 'non-ASCII kept', value: 'é😀 \u2028\u2029 </script>' },
  { name: 'lone surrogates', value: ['\ud800 lone', 'x\udc00'] },
  { name: 'nested', value: { a: [1, null, 'x', [true, false]], b: { c: {}, d: [] } } },
  {
    name: 'array-index keys first',
    entries: [['b', 1], ['2', 2], ['a', 3], ['1', 4], ['01', 5], ['4294967295', 6], ['4294967294', 7], ['-1', 8]],
  },
]
