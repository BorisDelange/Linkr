import { describe, expect, it } from 'vitest'

import { DEFAULT_PROFILE_OPTIONS, resolveProfileSource, type ProfileSource } from './concept-profile'
import {
  EXTRACTION_COLUMNS,
  EXTRACTION_COLUMN_MAPPING,
  buildDictionaryPageQuery,
  extractBatch,
  extractionCsvHeader,
  extractionCsvRows,
  type ExtractedConcept,
} from './source-extraction'
import type { SchemaMapping } from '@/types/schema-mapping'

const OMOP: SchemaMapping = {
  presetId: 'omop-5.4',
  presetLabel: { en: 'OMOP CDM 5.4' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  conceptTables: [{
    key: 'concept',
    table: 'concept',
    idColumn: 'concept_id',
    nameColumn: 'concept_name',
    codeColumn: 'concept_code',
    terminologyIdColumn: 'vocabulary_id',
  }],
  eventTables: {
    Measurements: {
      table: 'measurement',
      conceptIdColumn: 'measurement_concept_id',
      valueColumn: 'value_as_number',
      patientIdColumn: 'person_id',
      dateColumn: 'measurement_datetime',
    },
  },
}

function source(mapping: SchemaMapping = OMOP, key = 'concept'): ProfileSource {
  const resolved = resolveProfileSource(mapping, key)
  if (!resolved) throw new Error('no source')
  return resolved
}

/** An engine answering each query by matching a fragment of its SQL. */
function engine(answers: { match: string; rows: Record<string, unknown>[] }[]) {
  const seen: string[] = []
  const query = async (sql: string) => {
    seen.push(sql)
    return answers.find((a) => sql.includes(a.match))?.rows ?? []
  }
  return { query, seen }
}

/** A dictionary page of n concepts, ids 1..n offset by `from`. */
function page(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    concept_id: from + i + 1,
    concept_code: `C${from + i + 1}`,
    concept_name: `Concept ${from + i + 1}`,
    vocabulary_id: 'LOINC',
    category: 'Labs',
  }))
}

describe('the CSV contract', () => {
  // These names are what restoreFileSourceDataFromCsv recognises on re-import;
  // renaming one silently breaks the git round trip of every extracted project.
  it('names its columns the way the importer expects to find them', () => {
    expect(extractionCsvHeader()).toBe(
      'terminology,concept_code,concept_id,concept_name,category,record_count,patient_count,info_json',
    )
  })

  it('maps every column it writes, and writes every column it maps', () => {
    const mapped = Object.entries(EXTRACTION_COLUMN_MAPPING)
      .filter(([k]) => k !== 'extraColumns')
      .map(([, v]) => v)
    expect([...mapped].sort()).toEqual([...EXTRACTION_COLUMNS].sort())
  })

  it('escapes a value that would otherwise break the row', () => {
    const row: ExtractedConcept = {
      terminology: 'LOINC',
      concept_code: 'C1',
      concept_id: 1,
      concept_name: 'Sodium, serum',
      category: '',
      record_count: 10,
      patient_count: 5,
      info_json: '{"unit":"mmol/L"}',
    }
    const line = extractionCsvRows([row])
    expect(line).toContain('"Sodium, serum"')
    expect(line).toContain('"{""unit"":""mmol/L""}"')
  })

  it('writes an empty cell for a withheld profile, not the word null', () => {
    const row = {
      terminology: 'LOINC', concept_code: 'C1', concept_id: 1, concept_name: 'X',
      category: '', record_count: 3, patient_count: null, info_json: '',
    } as ExtractedConcept
    expect(extractionCsvRows([row])).toBe('LOINC,C1,1,X,,3,,')
  })
})

describe('buildDictionaryPageQuery', () => {
  it('pages on the key so the window is stable', () => {
    // LIMIT/OFFSET is only a stable window over a total order. Ordering by name
    // would let two concepts sharing one swap between pages — one extracted
    // twice, another never.
    const sql = buildDictionaryPageQuery(source(), 100, 200)
    expect(sql).toContain('ORDER BY d."concept_id"')
    expect(sql).toContain('LIMIT 100 OFFSET 200')
  })

  it('derives an id when the dictionary has no key column', () => {
    // Code-only dictionaries (MIMIC d_icd_diagnoses) still need one id per
    // concept, and it must be the same one the source view derives.
    const codeOnly: SchemaMapping = {
      ...OMOP,
      conceptTables: [{ key: 'd', table: 'd_icd', nameColumn: 'long_title', codeColumn: 'icd_code' }],
    }
    const sql = buildDictionaryPageQuery(source(codeOnly, 'd'), 10, 0)
    expect(sql).toContain('hash(d."icd_code")')
  })

  it('falls back to the table name when the dictionary names no vocabulary', () => {
    const noVocab: SchemaMapping = {
      ...OMOP,
      conceptTables: [{ key: 'd', table: 'items', nameColumn: 'label', codeColumn: 'code' }],
    }
    expect(buildDictionaryPageQuery(source(noVocab, 'd'), 10, 0)).toContain("'items' AS vocabulary_id")
  })
})

describe('extractBatch', () => {
  const opts = { ...DEFAULT_PROFILE_OPTIONS, minPatients: 0 }

  it('turns a dictionary page into rows carrying their profile', async () => {
    const { query } = engine([
      { match: 'LIMIT 10 OFFSET 0', rows: page(2) },
      { match: 'COUNT(*) AS rows_count', rows: [{ rows_count: 500, patients_count: 42 }] },
      { match: 'PERCENTILE_CONT(0.01)', rows: [{ p1: 1, p25: 10, median: 20, p75: 30, p99: 99, numeric_count: 100 }] },
      { match: 'STDDEV', rows: [{ min: 1, max: 60, mean: 20, median: 20, sd: 5 }] },
    ])
    const result = await extractBatch(OMOP, source(), opts, 0, 10, 2, query)

    expect(result.rows).toHaveLength(2)
    expect(result.done).toBe(true)
    expect(result.nextOffset).toBe(2)
    expect(result.rows[0]).toMatchObject({
      terminology: 'LOINC', concept_code: 'C1', concept_id: 1,
      concept_name: 'Concept 1', category: 'Labs',
      record_count: 500, patient_count: 42,
    })
    expect(JSON.parse(result.rows[0].info_json)).toMatchObject({ numeric_data: { min: 1, max: 60 } })
  })

  it('reports the offset the next batch resumes from', async () => {
    // The whole reason this is batched: a run stopped at 3000 of 40000 must
    // start again at 3000, not from the beginning.
    const { query } = engine([
      { match: 'ORDER BY d.', rows: page(10, 3000) },
      { match: 'COUNT(*) AS rows_count', rows: [{ rows_count: 1, patients_count: 1 }] },
    ])
    const result = await extractBatch(OMOP, source(), opts, 3000, 10, 40000, query)
    expect(result.nextOffset).toBe(3010)
    expect(result.done).toBe(false)
  })

  it('is done only when the page came back short', async () => {
    const { query } = engine([
      { match: 'ORDER BY d.', rows: page(4) },
      { match: 'COUNT(*) AS rows_count', rows: [{ rows_count: 1, patients_count: 1 }] },
    ])
    expect((await extractBatch(OMOP, source(), opts, 0, 10, 4, query)).done).toBe(true)
  })

  it('is done when the dictionary is exhausted exactly on a boundary', async () => {
    // An empty page after a full one: nothing extracted, nothing left.
    const { query } = engine([{ match: 'ORDER BY d.', rows: [] }])
    const result = await extractBatch(OMOP, source(), opts, 100, 10, 100, query)
    expect(result).toEqual({ rows: [], nextOffset: 100, done: true })
  })

  it('stops between concepts when cancelled, without claiming to be done', async () => {
    // A cancelled batch is short for a different reason than an exhausted one;
    // calling it done would strand the rest of the dictionary.
    const controller = new AbortController()
    let profiled = 0
    const query = async (sql: string) => {
      if (sql.includes('ORDER BY d.')) return page(10)
      if (sql.includes('COUNT(*) AS rows_count')) {
        profiled++
        if (profiled === 2) controller.abort()
        return [{ rows_count: 1, patients_count: 1 }]
      }
      return []
    }
    const result = await extractBatch(OMOP, source(), opts, 0, 10, 100, query, controller.signal)
    expect(result.done).toBe(false)
    expect(result.rows.length).toBeLessThan(10)
    expect(result.nextOffset).toBe(result.rows.length)
  })

  it('keeps a concept whose profile failed, rather than leaving a hole', async () => {
    // A dropped row is a concept the editor could never show. One bad concept
    // must not cost the batch.
    const query = async (sql: string) => {
      if (sql.includes('ORDER BY d.')) return page(1)
      throw new Error('bad column')
    }
    const result = await extractBatch(OMOP, source(), opts, 0, 10, 1, query)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ concept_code: 'C1', record_count: 0 })
  })

  it('leaves info_json empty for a concept below the privacy threshold', async () => {
    const { query } = engine([
      { match: 'ORDER BY d.', rows: page(1) },
      { match: 'COUNT(*) AS rows_count', rows: [{ rows_count: 9, patients_count: 2 }] },
    ])
    const result = await extractBatch(
      OMOP, source(), { ...DEFAULT_PROFILE_OPTIONS, minPatients: 11 }, 0, 10, 1, query,
    )
    expect(result.rows[0].info_json).toBe('')
    // The counts still travel — only the aggregate profile is withheld.
    expect(result.rows[0]).toMatchObject({ record_count: 9, patient_count: 2 })
  })

  it('reports progress as an absolute position, not a per-batch one', async () => {
    // The bar spans the whole dictionary, so a resumed batch must continue the
    // count rather than restart it.
    const { query } = engine([
      { match: 'ORDER BY d.', rows: page(3, 500) },
      { match: 'COUNT(*) AS rows_count', rows: [{ rows_count: 1, patients_count: 1 }] },
    ])
    const seen: number[] = []
    await extractBatch(OMOP, source(), opts, 500, 10, 9000, query, undefined, (n) => seen.push(n))
    expect(seen).toEqual([501, 502, 503])
  })
})
