import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import type { SourceExtraction } from '@/types'
import { describe, expect, it } from 'vitest'

import { DEFAULT_PROFILE_OPTIONS, resolveProfileSource } from './concept-profile'
import { pauseRun, startRun, watchRun, type StartRunInput } from './extraction-runner'
import type { ProfileJobs } from './profile-jobs'
import type { BatchProfileStore } from './source-extraction'
import { SECTION_KEYS, variantOf, type StoredProfile } from '@/lib/concept-profiles/profile-store'
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
  /** Ids the dictionary holds twice, whatever the query asks. */
  duplicated?: number[]
  /** Ids the ids query lists but a page no longer finds. */
  gone?: number[]
}

/**
 * A fake source answering the extraction's queries by their shape. `queryAll`
 * re-sorts like the server pager (`ORDER BY ALL`), so a walk that trusted the
 * row order would come out id-ascending.
 */
function fakeSource({ dictionary, records, duplicated = [], gone = [] }: Warehouse) {
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
    const row = (id: number) => ({
      concept_id: id, concept_code: `C${id}`, concept_name: dictionary[id], vocabulary_id: 'V', category: null,
    })
    const withDuplicates = (found: number[]) =>
      found.flatMap((id) => (duplicated.includes(id) ? [row(id), row(id)] : [row(id)]))
    if (inList) {
      return withDuplicates(inList[1].split(',').map(Number).filter((id) => id in dictionary && !gone.includes(id)))
    }
    const window = sql.match(/LIMIT (\d+) OFFSET (\d+)/)
    if (window) {
      const [limit, offset] = [Number(window[1]), Number(window[2])]
      return withDuplicates([...ids].sort((a, b) => a - b).slice(offset, offset + limit))
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

  it('ranks on the counts the database already has, without scanning the table', async () => {
    const { answer, seen } = fakeSource({ dictionary: { 1: 'a', 2: 'b', 3: 'c' }, records: { 1: 50, 2: 40, 3: 30 } })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA, sort: BY_RECORDS, onlyWithRecords: true,
      resumeFrom: null, query: answer, queryAll: answer,
      countedRecords: async () => [3, 2].map((id) => ({ concept_id: id, record_count: id * 10, patient_count: null })),
    })
    expect(seen.some((sql) => sql.includes('AS record_count'))).toBe(false)
    expect(writtenIds(writes)).toEqual([3, 2])
  })

  it('scans the table when the database has no count for it', async () => {
    const { answer, seen } = fakeSource({ dictionary: { 1: 'a', 2: 'b' }, records: { 1: 50, 2: 40 } })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA, sort: BY_RECORDS, onlyWithRecords: true,
      resumeFrom: null, query: answer, queryAll: answer, countedRecords: async () => null,
    })
    expect(seen.some((sql) => sql.includes('AS record_count'))).toBe(true)
    expect(writtenIds(writes)).toEqual([1, 2])
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

  it('continues over a changed ranking, minus the concepts the CSV already holds', async () => {
    const { answer } = fakeSource({
      dictionary: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' },
      records: { 3: 90, 1: 50, 4: 45, 2: 40 },
    })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA, sort: BY_RECORDS, onlyWithRecords: true,
      resumeFrom: { extracted: 2, total: 3, sizes: [3], walked: walked([1, 2]) },
      query: answer, queryAll: answer,
      readWritten: async () => [1, 2],
    })
    expect(writes.some((w) => w.reset)).toBe(false)
    expect(writtenIds(writes)).toEqual([3, 4])
    const last = writes.at(-1)!.state
    expect([last.extracted, last.total, last.sizes]).toEqual([4, 4, [4]])
  })

  it('starts over when the CSV holds fewer concepts than the run says it wrote', async () => {
    const { answer } = fakeSource({ dictionary: { 1: 'a', 2: 'b', 3: 'c' }, records: { 3: 90, 1: 50, 2: 40 } })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA, sort: BY_RECORDS, onlyWithRecords: true,
      resumeFrom: { extracted: 2, total: 3, sizes: [3], walked: walked([1, 2]) },
      query: answer, queryAll: answer,
      readWritten: async () => [1],
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

describe('a ranked page that does not match its slice', () => {
  const source = resolveProfileSource(OMOP, 'concept')!

  it('writes a concept the dictionary holds twice once, and still reaches the end', async () => {
    const { answer } = fakeSource({
      dictionary: { 1: 'a', 2: 'b', 3: 'c' }, records: { 1: 50, 2: 40, 3: 30 }, duplicated: [1, 2],
    })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA, sort: BY_RECORDS, onlyWithRecords: true,
      resumeFrom: null, query: answer, queryAll: answer,
    })
    expect(writtenIds(writes)).toEqual([1, 2, 3])
    const last = writes.at(-1)!.state
    expect([last.extracted, last.total]).toEqual([3, 3])
  })

  it('steps over a ranked concept the page no longer finds instead of ending there', async () => {
    const { answer } = fakeSource({
      dictionary: { 1: 'a', 2: 'b', 3: 'c' }, records: { 1: 50, 2: 40, 3: 30 }, gone: [2],
    })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA, sort: BY_RECORDS, onlyWithRecords: true,
      resumeFrom: null, query: answer, queryAll: answer,
    })
    expect(writtenIds(writes)).toEqual([1, 3])
    const last = writes.at(-1)!.state
    expect([last.extracted, last.total, last.sizes]).toEqual([2, 2, [2]])
  })
})

describe('resuming an unranked extraction', () => {
  it('measures again a dictionary that grew since the run was stored', async () => {
    const source = resolveProfileSource(OMOP, 'concept')!
    const { answer } = fakeSource({ dictionary: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' }, records: {} })
    const writes = await runToEnd({
      mapping: OMOP, sources: [source], options: NO_METADATA,
      sort: { key: 'id', direction: 'asc' }, onlyWithRecords: false,
      resumeFrom: { extracted: 2, total: 2, sizes: [2] },
      query: answer, queryAll: answer,
    })
    expect(writtenIds(writes)).toEqual([3, 4])
    expect(writes.at(-1)!.state.total).toBe(4)
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

describe('profile queries run as a server job', () => {
  const source = resolveProfileSource(OMOP, 'concept')!
  const warehouse = { dictionary: { 1: 'a', 2: 'b', 3: 'c' }, records: { 1: 50, 2: 40, 3: 30 } }
  const isProfile = (sql: string) => sql.includes("'scalar' AS block")

  function fakeJobs(done: string[] = []) {
    const started: { key: string; sql: string }[][] = []
    const cancelled: string[] = []
    const read: string[] = []
    const jobs: ProfileJobs = {
      start: async (queries) => {
        started.push([...queries])
        return `job${started.length}`
      },
      rows: async (_id, key) => {
        read.push(key)
        return []
      },
      done: async () => new Set(done),
      cancel: async (id) => { cancelled.push(id) },
    }
    return { jobs, started, cancelled, read }
  }

  const input = (answer: (sql: string) => Promise<Record<string, unknown>[]>) => ({
    mapping: OMOP, sources: [source], options: DEFAULT_PROFILE_OPTIONS, sort: BY_RECORDS, onlyWithRecords: true,
    query: answer, queryAll: answer, queryAggregate: answer,
  })

  it('sends every profile query to one job up front, and reads each from it', async () => {
    const { answer, seen } = fakeSource(warehouse)
    const { jobs, started, read } = fakeJobs()
    const writes = await runToEnd({ ...input(answer), resumeFrom: null, jobs, previousJobIds: ['older'] })
    expect(started).toHaveLength(1)
    expect(started[0].every((q) => isProfile(q.sql))).toBe(true)
    expect(read).toEqual(started[0].map((q) => q.key))
    expect(seen.some(isProfile)).toBe(false)
    expect(writtenIds(writes)).toEqual([1, 2, 3])
    // Recorded before the first page, dropped once the run is done.
    expect(writes[0].state.jobIds).toEqual(['job1'])
    expect(writes.at(-1)!.state.jobIds).toBeUndefined()
  })

  it('splits a run longer than one job takes into jobs started one after the other', async () => {
    // Past the rows one batch reads: one query per concept.
    const { answer } = fakeSource({ ...warehouse, records: { 1: 5_000_000, 2: 4_000_000, 3: 3_000_000 } })
    const whole = fakeJobs()
    await runToEnd({ ...input(answer), resumeFrom: null, jobs: whole.jobs })
    const planned = whole.started[0].map((q) => q.key)
    expect(planned.length).toBeGreaterThan(1)

    const { jobs, started, read } = fakeJobs()
    const order: string[] = []
    const capped: ProfileJobs = {
      ...jobs,
      maxQueries: 1,
      start: async (queries) => { const id = await jobs.start(queries); order.push(`start ${id}`); return id },
      rows: async (id, key, signal) => { order.push(`read ${id}`); return jobs.rows(id, key, signal) },
    }
    const writes = await runToEnd({ ...input(answer), resumeFrom: null, jobs: capped })
    expect(started.map((q) => q.length)).toEqual(planned.map(() => 1))
    expect(started.flat().map((q) => q.key)).toEqual(planned)
    expect(read).toEqual(planned)
    // Each job once the one before it was read: never two at once.
    expect(order).toEqual(planned.flatMap((_, i) => [`start job${i + 1}`, `read job${i + 1}`]))
    // Each recorded as it starts, for a resume to find.
    expect(writes.some((w) => w.state.jobIds?.includes(`job${planned.length}`))).toBe(true)
    expect(writes.at(-1)!.state.jobIds).toBeUndefined()
  })

  it('takes what the paused run\'s job finished, without a new one', async () => {
    const { answer } = fakeSource(warehouse)
    const first = fakeJobs()
    await runToEnd({ ...input(answer), resumeFrom: null, jobs: first.jobs })
    const keys = first.started[0].map((q) => q.key)

    const { jobs, started, cancelled, read } = fakeJobs(keys)
    await runToEnd({
      ...input(answer), jobs, previousJobIds: ['job1'],
      resumeFrom: { extracted: 0, total: 3, sizes: [3], walked: walkKey(EMPTY_WALK) },
    })
    expect(started).toHaveLength(0)
    expect(cancelled).toEqual(['job1'])
    expect(read).toEqual(keys)
  })

  it('plans no query for a concept the store answers whole, and the same queries the pages send', async () => {
    const { answer, seen } = fakeSource(warehouse)
    const { jobs, started, read } = fakeJobs()
    const whole = (conceptId: number): StoredProfile => ({
      dictKey: 'concept', conceptId, rowsCount: 40, patientsCount: 20, json: {},
      sections: [...SECTION_KEYS], variant: variantOf(DEFAULT_PROFILE_OPTIONS), fingerprint: 'f', computedAt: 'then',
    })
    const store: BatchProfileStore = {
      fingerprint: 'f',
      read: async (_dict, ids) => new Map(ids.filter((id) => id === 2).map((id) => [id, whole(id)])),
      write: async () => {},
    }
    await runToEnd({ ...input(answer), resumeFrom: null, jobs, store: async () => store })
    expect(started[0].map((q) => q.sql.match(/IN \(([^)]*)\)/)![1])).toEqual(['1, 3'])
    expect(read).toEqual(started[0].map((q) => q.key))
    expect(seen.some(isProfile)).toBe(false)
  })

  it('cancels the job on a pause, and forgets it', async () => {
    const { answer } = fakeSource(warehouse)
    const { jobs, cancelled } = fakeJobs()
    const pausing: ProfileJobs = {
      ...jobs,
      // The run in flight is the last one started.
      rows: async () => { pauseRun(`p${runCount}`); return null },
    }
    const writes = await runToEnd({ ...input(answer), resumeFrom: null, jobs: pausing })
    expect(cancelled).toEqual(['job1'])
    expect(writes[0].state.jobIds).toEqual(['job1'])
    expect(writes.at(-1)!.state.jobIds).toBeUndefined()
    expect(writes.at(-1)!.state.extracted).toBe(0)
  })

  it('profiles from the database when the concepts are not ranked', async () => {
    const { answer, seen } = fakeSource(warehouse)
    const { jobs, started } = fakeJobs()
    await runToEnd({ ...input(answer), sort: { key: 'name', direction: 'asc' }, onlyWithRecords: false, resumeFrom: null, jobs })
    expect(started).toHaveLength(0)
    expect(seen.some(isProfile)).toBe(true)
  })
})
