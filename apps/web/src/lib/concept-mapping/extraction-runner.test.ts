import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import type { SourceExtraction } from '@/types'
import { describe, expect, it } from 'vitest'

import { DEFAULT_PROFILE_OPTIONS, resolveProfileSource } from './concept-profile'
import { startRun, watchRun, type StartRunInput } from './extraction-runner'
import { EMPTY_WALK, extendWalk, walkKey, type ExtractionSort } from './source-extraction'

const MEASUREMENTS = {
  table: 'measurement',
  conceptIdColumn: 'measurement_concept_id',
  valueColumn: 'value_as_number',
  patientIdColumn: 'person_id',
}
const OMOP_V1 = {
  presetId: 'omop-5.4',
  presetLabel: { en: 'OMOP' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  conceptTables: [{
    key: 'concept', table: 'concept', idColumn: 'concept_id',
    nameColumn: 'concept_name', codeColumn: 'concept_code', terminologyIdColumn: 'vocabulary_id',
  }],
  eventTables: { Measurements: MEASUREMENTS },
}
const OMOP = mappingV1ToV2(OMOP_V1 as never)
const TWO_TABLES = mappingV1ToV2({
  ...OMOP_V1,
  eventTables: {
    Measurements: MEASUREMENTS,
    Observations: { table: 'observation', conceptIdColumn: 'observation_concept_id', patientIdColumn: 'person_id' },
  },
} as never)

const NO_METADATA = { ...DEFAULT_PROFILE_OPTIONS, metadata: false }
const BY_RECORDS: ExtractionSort = { key: 'records', direction: 'desc' }

interface Warehouse {
  /** The dictionary: id → name. */
  dictionary: Record<number, string>
  /** Records per concept, as the counting pass returns them. */
  records: Record<number, number>
}

/**
 * A fake source answering the extraction's queries by their shape. `queryAll`
 * re-sorts like the server pager (`ORDER BY ALL`), so a walk that trusted the
 * row order would come out id-ascending.
 */
function fakeSource({ dictionary, records }: Warehouse) {
  const seen: string[] = []
  const answer = async (sql: string): Promise<Record<string, unknown>[]> => {
    seen.push(sql)
    const ids = Object.keys(dictionary).map(Number)
    if (sql.includes('COUNT(*) AS total')) return [{ total: ids.length }]
    if (sql.includes('AS record_count')) {
      return Object.entries(records).map(([id, n]) => ({ concept_id: Number(id), record_count: n, patient_count: 1 }))
    }
    if (sql.includes('AS ord')) {
      const byName = [...ids].sort((a, b) => dictionary[b].localeCompare(dictionary[a]) || a - b)
      return byName.map((id, i) => ({ concept_id: id, ord: i + 1 }))
    }
    if (sql.includes('SELECT DISTINCT')) return ids.map((id) => ({ concept_id: id }))
    const inList = sql.match(/IN \(([^)]*)\)/)
    if (inList) {
      return inList[1].split(',').map(Number).filter((id) => id in dictionary).map((id) => ({
        concept_id: id, concept_code: `C${id}`, concept_name: dictionary[id], vocabulary_id: 'V', category: null,
      }))
    }
    return []
  }
  const serverPager = async (sql: string) => {
    const rows = await answer(sql)
    return [...rows].sort((a, b) => Number(a.concept_id) - Number(b.concept_id))
  }
  return { answer, serverPager, seen }
}

interface Write { state: SourceExtraction; chunk: string; reset: boolean }

let runCount = 0

/** Run an extraction to its end and return what it wrote. */
async function runToEnd(
  input: Omit<StartRunInput, 'projectId' | 'persist' | 'persistError'>,
): Promise<Write[]> {
  const projectId = `p${++runCount}`
  const writes: Write[] = []
  const finished = new Promise<void>((resolve, reject) => {
    let started = false
    watchRun(projectId, (s) => {
      if (s.running) started = true
      else if (started && s.error) reject(new Error(s.error))
      else if (started) resolve()
    })
  })
  startRun({
    ...input,
    projectId,
    persist: async (state, chunk, _rows, reset) => {
      writes.push({ state, chunk, reset })
      // A run that keeps writing without moving is the bug these tests guard.
      if (writes.length > 50) throw new Error('the run does not advance')
    },
    persistError: async () => {},
  })
  await finished
  return writes
}

/** The concept ids written, in order, across every chunk. */
function writtenIds(writes: Write[]): number[] {
  return writes
    .flatMap((w) => w.chunk.split('\n'))
    .filter((line) => line && !line.startsWith('terminology'))
    .map((line) => Number(line.split(',')[2]))
}

describe('resuming a ranked extraction', () => {
  const source = resolveProfileSource(OMOP, 'concept')!
  const walked = (ids: number[]) => walkKey(extendWalk(EMPTY_WALK, ids))

  it('continues when the new ranking starts with the concepts already written, even shorter', async () => {
    // Stored: 5 concepts had records, 1 and 2 are written. Now only 3 have.
    const { answer } = fakeSource({
      dictionary: { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e' },
      records: { 1: 50, 2: 40, 3: 30 },
    })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA, sort: BY_RECORDS, onlyWithRecords: true,
      resumeFrom: { extracted: 2, total: 5, sizes: [5], walked: walked([2, 1]) },
      query: answer, queryAll: answer,
    })
    expect(writes.some((w) => w.reset)).toBe(false)
    expect(writtenIds(writes)).toEqual([3])
    const last = writes.at(-1)!.state
    expect([last.extracted, last.total, last.sizes]).toEqual([3, 3, [3]])
  })

  it('closes a dictionary that ends short of its size instead of asking for it forever', async () => {
    // Ranked ids no longer in the dictionary: the page comes back short.
    const { answer } = fakeSource({ dictionary: { 1: 'a', 2: 'b' }, records: { 1: 50, 2: 40, 3: 30, 4: 20 } })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA, sort: BY_RECORDS, onlyWithRecords: true,
      resumeFrom: null, query: answer, queryAll: answer,
    })
    expect(writtenIds(writes)).toEqual([1, 2])
    expect(writes.at(-1)!.state.extracted).toBe(writes.at(-1)!.state.total)
  })

  it('starts over when the written concepts are not the new ranking\'s first ones', async () => {
    const { answer } = fakeSource({
      dictionary: { 1: 'a', 2: 'b', 3: 'c' },
      records: { 3: 90, 1: 50, 2: 40 },
    })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA, sort: BY_RECORDS, onlyWithRecords: true,
      resumeFrom: { extracted: 2, total: 3, sizes: [3], walked: walked([1, 2]) },
      query: answer, queryAll: answer,
    })
    expect(writes[0].reset).toBe(true)
    expect(writtenIds(writes)).toEqual([3, 1, 2])
  })

  it('starts over a ranked run stored before the walk was recorded', async () => {
    // Its ranking scheme was another (concept 0 first, home-table records): the
    // offset into it means nothing in the new one.
    const { answer } = fakeSource({ dictionary: { 1: 'a', 2: 'b', 3: 'c' }, records: { 1: 50, 2: 40, 3: 30 } })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA, sort: BY_RECORDS, onlyWithRecords: true,
      resumeFrom: { extracted: 2, total: 5, sizes: [5] },
      query: answer, queryAll: answer,
    })
    expect(writes[0].reset).toBe(true)
    expect(writtenIds(writes)).toEqual([1, 2, 3])
  })
})

describe('what an extraction scans', () => {
  it('leaves the clinical tables alone with metadata off', async () => {
    const source = resolveProfileSource(TWO_TABLES, 'concept')!
    const { answer, seen } = fakeSource({ dictionary: { 1: 'a', 2: 'b' }, records: { 1: 5 } })
    await runToEnd({
      mapping: TWO_TABLES, sources: [source], options: NO_METADATA,
      sort: { key: 'id', direction: 'asc' }, onlyWithRecords: false, resumeFrom: null,
      query: answer, queryAll: answer,
    })
    expect(seen.filter((sql) => sql.includes('AS record_count'))).toEqual([])
  })

  it('counts once per event table when asked for the concepts with records, in one request each', async () => {
    const source = resolveProfileSource(TWO_TABLES, 'concept')!
    const { answer, seen } = fakeSource({ dictionary: { 1: 'a', 2: 'b' }, records: { 1: 5 } })
    const paged: string[] = []
    await runToEnd({
      mapping: TWO_TABLES, sources: [source], options: NO_METADATA,
      sort: { key: 'id', direction: 'asc' }, onlyWithRecords: true, resumeFrom: null,
      query: answer,
      queryAll: (sql) => { paged.push(sql); return answer(sql) },
      queryAggregate: answer,
    })
    expect(seen.filter((sql) => sql.includes('AS record_count'))).toHaveLength(2)
    expect(paged.filter((sql) => sql.includes('AS record_count'))).toEqual([])
  })
})

describe('the walk order in server mode', () => {
  it('follows the chosen dictionary order through a pager that re-sorts by id', async () => {
    const source = resolveProfileSource(OMOP, 'concept')!
    const { answer, serverPager } = fakeSource({
      dictionary: { 1: 'alpha', 2: 'zeta', 3: 'mid' },
      records: { 1: 1, 2: 1, 3: 1 },
    })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA,
      sort: { key: 'name', direction: 'desc' }, onlyWithRecords: true, resumeFrom: null,
      query: answer, queryAll: serverPager,
    })
    expect(writtenIds(writes)).toEqual([2, 3, 1])
  })
})
