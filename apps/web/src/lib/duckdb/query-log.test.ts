import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearLoggedQueries, loggedQueries, logQuery, originOf, pageOrigin } from './query-log'

afterEach(() => {
  vi.useRealTimers()
  clearLoggedQueries()
})

describe('a query’s origin', () => {
  it('is the page it was sent from when its caller names none', () => {
    expect(pageOrigin('/workspaces/ab/projects/cd/warehouse/cohorts/x')).toBe('Cohorts')
    expect(pageOrigin('/workspaces/ab/projects/cd/warehouse/patient-data')).toBe('Patient data')
    expect(pageOrigin('/somewhere/else')).toBe('SQL query')
  })

  it('names what in a section sent it', () => {
    expect(originOf('Cohort', ' Sepsis ')).toBe('Cohort · Sepsis')
    expect(originOf('Cohort', '')).toBe('Cohort')
  })
})

describe('the front-only query log', () => {
  it('keeps each query’s SQL, row count or error, newest first', () => {
    logQuery('ds', 'SELECT 1', 'Cohorts')({ rows: 3 })
    logQuery('ds', 'SELECT nope', 'Concepts')({ error: new Error('no column nope') })
    const end = logQuery('ds', 'SELECT 3', 'Patient board')
    expect(loggedQueries().map((q) => [q.sql, q.status, q.rows, q.error])).toEqual([
      ['SELECT 3', 'running', null, null],
      ['SELECT nope', 'error', null, 'no column nope'],
      ['SELECT 1', 'done', 3, null],
    ])
    end({ cancelled: true })
    expect(loggedQueries()[0].status).toBe('cancelled')
  })

  it('forgets a query after a day, and keeps the running ones when cleared', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-03T08:00:00Z'))
    logQuery('ds', 'SELECT old', 'Cohorts')({ rows: 1 })
    vi.setSystemTime(new Date('2026-11-04T09:00:00Z'))
    logQuery('ds', 'SELECT new', 'Cohorts')({ rows: 1 })
    logQuery('ds', 'SELECT live', 'Cohorts')
    expect(loggedQueries().map((q) => q.sql)).toEqual(['SELECT live', 'SELECT new'])
    clearLoggedQueries()
    expect(loggedQueries().map((q) => q.sql)).toEqual(['SELECT live'])
  })
})
