import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sent: { sql: string; signal?: AbortSignal }[] = []
/** Statements whose read waits for the test, until aborted. */
const stalled = new Set<string>()
vi.mock('@/lib/duckdb/engine', () => ({
  queryDataSource: vi.fn((_id: string, sql: string, options: { signal?: AbortSignal } = {}) => {
    sent.push({ sql, signal: options.signal })
    if (!stalled.has(sql)) return Promise.resolve([{ sql }])
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')))
    })
  }),
}))

const { clearPatientQueries, estimateBytes, patientQuery, setPrefetchPatients, statementsFor } = await import('./patient-prefetch')

const notes = (p: string) => `SELECT * FROM linkr_note WHERE patient_id = '${p}'`
const sentSql = () => sent.map((s) => s.sql)
const settle = async () => {
  await vi.advanceTimersByTimeAsync(1500)
}

beforeEach(() => {
  vi.useFakeTimers()
  sent.length = 0
  stalled.clear()
})
afterEach(() => {
  setPrefetchPatients(null, null, null)
  clearPatientQueries()
  vi.useRealTimers()
})

describe('statementsFor', () => {
  it('rewrites the patient literal, and leaves out a statement not naming it', () => {
    expect(statementsFor([notes('p1'), 'SELECT 1'], 'p1', 'p2')).toEqual([notes('p2')])
  })

  it('escapes both ids as the builders do', () => {
    expect(statementsFor(["WHERE id = 'o''b'"], "o'b", "c'd")).toEqual(["WHERE id = 'c''d'"])
  })
})

describe('reading the next patient ahead', () => {
  it('sends the current patient’s statements for the next one once the screen has settled', async () => {
    setPrefetchPatients('db', 'p1', 'p2')
    await patientQuery('db', notes('p1'))
    expect(sentSql()).toEqual([notes('p1')])
    await settle()
    expect(sentSql()).toEqual([notes('p1'), notes('p2')])
  })

  it('serves the next patient from what was read, without a second query', async () => {
    setPrefetchPatients('db', 'p1', 'p2')
    await patientQuery('db', notes('p1'))
    await settle()
    setPrefetchPatients('db', 'p2', 'p3')
    sent.length = 0
    expect(await patientQuery('db', notes('p2'))).toEqual([{ sql: notes('p2') }])
    expect(sent).toEqual([])
  })

  it('queries as before a statement it did not read ahead', async () => {
    setPrefetchPatients('db', 'p1', 'p2')
    await patientQuery('db', notes('p1'))
    await settle()
    setPrefetchPatients('db', 'p2', null)
    sent.length = 0
    const other = `${notes('p2')} AND visit_id = 'v9'`
    await patientQuery('db', other)
    expect(sentSql()).toEqual([other])
  })

  it('stops the read ahead when another patient is opened, and keeps nothing of it', async () => {
    stalled.add(notes('p2'))
    setPrefetchPatients('db', 'p1', 'p2')
    await patientQuery('db', notes('p1'))
    await settle()
    const ahead = sent.find((s) => s.sql === notes('p2'))!
    setPrefetchPatients('db', 'p7', 'p8')
    expect(ahead.signal?.aborted).toBe(true)
    stalled.clear()
    sent.length = 0
    setPrefetchPatients('db', 'p2', null)
    await patientQuery('db', notes('p2'))
    expect(sentSql()).toEqual([notes('p2')])
  })

  it('waits while the current patient is still loading', async () => {
    stalled.add(notes('p1'))
    setPrefetchPatients('db', 'p1', 'p2')
    void patientQuery('db', notes('p1')).catch(() => {})
    await settle()
    expect(sentSql()).toEqual([notes('p1')])
  })
})

describe('in the order React runs effects', () => {
  it('serves a read ahead to a widget that queries the next patient before the list says so', async () => {
    setPrefetchPatients('db', 'p1', 'p2')
    await patientQuery('db', notes('p1'))
    await settle()
    sent.length = 0
    // The widget's effect, then the list's.
    expect(await patientQuery('db', notes('p2'))).toEqual([{ sql: notes('p2') }])
    setPrefetchPatients('db', 'p2', 'p3')
    expect(sent).toEqual([])
    await settle()
    expect(sentSql()).toEqual([notes('p3')])
  })

  it('records the first patient’s queries sent before the list is known', async () => {
    await patientQuery('db', notes('p1'))
    setPrefetchPatients('db', 'p1', 'p2')
    await settle()
    expect(sentSql()).toEqual([notes('p1'), notes('p2')])
  })
})

describe('kept for the session', () => {
  it('reads nothing when coming back to a patient already seen', async () => {
    setPrefetchPatients('db', 'p1', null)
    await patientQuery('db', notes('p1'))
    setPrefetchPatients('db', 'p5', null)
    await patientQuery('db', notes('p5'))
    setPrefetchPatients('db', 'p1', null)
    sent.length = 0
    expect(await patientQuery('db', notes('p1'))).toEqual([{ sql: notes('p1') }])
    expect(sent).toEqual([])
  })

  it('does not keep a read its widget stopped', async () => {
    stalled.add(notes('p1'))
    const controller = new AbortController()
    const read = patientQuery('db', notes('p1'), { signal: controller.signal })
    controller.abort()
    await expect(read).rejects.toThrow()
    stalled.clear()
    sent.length = 0
    await patientQuery('db', notes('p1'))
    expect(sentSql()).toEqual([notes('p1')])
  })

  it('forgets a database’s rows once its data has changed', async () => {
    await patientQuery('db', notes('p1'))
    await patientQuery('other', notes('p1'))
    clearPatientQueries('db')
    sent.length = 0
    await patientQuery('db', notes('p1'))
    await patientQuery('other', notes('p1'))
    expect(sentSql()).toEqual([notes('p1')])
  })

  it('weighs rows by their text', () => {
    expect(estimateBytes([{ a: 'xx', b: 1 }])).toBe(16 + 4 + 16)
  })
})
