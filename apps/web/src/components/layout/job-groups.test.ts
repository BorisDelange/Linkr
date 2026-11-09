import { describe, expect, it } from 'vitest'
import type { Job } from '@/lib/api/environments'
import { splitEntityHead, groupJobs } from './job-groups'

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id, projectUid: null, workspaceId: 'ws', kind: 'sql_query', label: `Query ${id}`,
    status: 'done', progress: 0, logTail: '', createdAt: `2026-11-03T10:00:0${id}Z`,
    startedAt: `2026-11-03T10:00:0${id}Z`, finishedAt: `2026-11-03T10:00:0${id}.5Z`, ...over,
  }
}

describe('groupJobs', () => {
  it('folds a group where its newest job is, and keeps the others apart', () => {
    const rows = groupJobs([
      job('4', { groupKey: 'g', groupLabel: 'Patient' }),
      job('3'),
      job('2', { groupKey: 'g', groupLabel: 'Patient' }),
      job('1', { groupKey: 'g', groupLabel: 'Patient' }),
    ])
    expect(rows).toHaveLength(2)
    const first = rows[0]
    expect('group' in first && first.group.label).toBe('Patient')
    expect('group' in first && first.group.jobs.map((j) => j.id)).toEqual(['4', '2', '1'])
    expect('group' in first && first.group.startedAt).toBe('2026-11-03T10:00:01Z')
    expect('group' in first && first.group.finishedAt).toBe('2026-11-03T10:00:04.5Z')
    expect('job' in rows[1] && rows[1].job.id).toBe('3')
  })

  it('runs while one of its jobs runs, else says its worst outcome', () => {
    const running = groupJobs([
      job('2', { groupKey: 'g', status: 'running', finishedAt: null }),
      job('1', { groupKey: 'g', status: 'error' }),
    ])[0]
    expect('group' in running && running.group.status).toBe('running')
    expect('group' in running && running.group.finishedAt).toBeNull()
    const failed = groupJobs([job('2', { groupKey: 'g', status: 'cancelled' }), job('1', { groupKey: 'g', status: 'error' })])[0]
    expect('group' in failed && failed.group.status).toBe('error')
  })

  it('shows a group of one job as that job', () => {
    expect(groupJobs([job('1', { groupKey: 'g', groupLabel: 'Patient' })])).toEqual([{ job: expect.objectContaining({ id: '1' }) }])
  })
})

describe('groupJobs, jobs sent together', () => {
  it('folds a burst of jobs of no group into one row, named by their section', () => {
    const rows = groupJobs([
      job('3', { label: 'test · List its tables and columns' }),
      job('2', { label: 'test · List its tables and columns' }),
      job('1', { label: 'test · count patients' }),
    ])
    expect(rows).toHaveLength(1)
    expect('group' in rows[0] && rows[0].group.label).toBe('test')
    expect('group' in rows[0] && rows[0].group.jobs).toHaveLength(3)
  })

  it('names a burst of several sections by its count', () => {
    const rows = groupJobs(
      [job('2', { label: 'test · tables' }), job('1', { label: 'Databases · patient count' })],
      { mixed: (n) => `${n} together`, queries: () => 'Queries' },
    )
    expect('group' in rows[0] && rows[0].group.label).toBe('2 together')
  })

  it('keeps apart the jobs sent further apart, and those of a group', () => {
    const apart = groupJobs([
      job('9', { createdAt: '2026-11-03T10:00:09Z' }),
      job('1', { createdAt: '2026-11-03T10:00:01Z' }),
    ])
    expect(apart).toHaveLength(2)
    const grouped = groupJobs([job('3', { groupKey: 'run', groupLabel: 'Run' }), job('2'), job('1', { groupKey: 'run' })])
    expect(grouped.map((r) => ('group' in r ? r.group.key : r.job.id))).toEqual(['run', '2'])
  })
})


describe('groupJobs, by what the jobs are for', () => {
  const db = (name: string, id = name) => ({ entityType: 'database', entityId: id, entityName: name })

  it('names a burst by the section its jobs share, its entity beside', () => {
    const rows = groupJobs([
      job('2', { label: 'Concepts · value histogram of 1', ...db('test') }),
      job('1', { label: 'Concepts · count records of 1', ...db('test') }),
    ])
    expect('group' in rows[0] && rows[0].group.label).toBe('Concepts')
    expect('group' in rows[0] && rows[0].group.entity).toEqual({ type: 'database', id: 'test', name: 'test' })
  })

  it('reads the section past the entity its labels start by naming', () => {
    const rows = groupJobs([
      job('2', { label: 'Database “test” · Patient list · patient count', ...db('test') }),
      job('1', { label: 'Database “test” · Patient list · one page of patients', ...db('test') }),
    ])
    expect('group' in rows[0] && rows[0].group.label).toBe('Patient list')
  })

  it('calls the jobs of one entity sharing no section its queries', () => {
    const rows = groupJobs([
      job('2', { label: 'test · patient count', ...db('test') }),
      job('1', { label: 'test · List its tables and columns', ...db('test') }),
    ])
    expect('group' in rows[0] && rows[0].group.label).toBe('Queries')
  })

  it('keeps the jobs of two databases sent together apart', () => {
    const rows = groupJobs([
      job('3', db('a')), job('2', db('b')), job('1', db('b')),
    ])
    expect(rows.map((r) => ('group' in r ? r.group.jobs.length : r.job.id))).toEqual(['3', 2])
  })

  it('says no entity for a group of several', () => {
    const rows = groupJobs([
      job('2', { groupKey: 'run', ...db('a') }),
      job('1', { groupKey: 'run', ...db('b') }),
    ])
    expect('group' in rows[0] && rows[0].group.entity).toBeNull()
  })
})

describe('splitEntityHead', () => {
  it('takes the entity a label starts by naming', () => {
    expect(splitEntityHead('Database “test” · Patient list · one page')).toEqual({ head: 'Database “test” · ', action: 'Patient list · one page' })
    expect(splitEntityHead('Cohorte « test » · membres')).toEqual({ head: 'Cohorte « test » · ', action: 'Membres' })
  })

  it("takes the bare name of the job's entity a server label starts with", () => {
    const entity = { type: 'database', id: 'd', name: 'Test' }
    expect(splitEntityHead('Test · patient count', entity)).toEqual({ head: 'Test · ', action: 'Patient count' })
    expect(splitEntityHead('Test · patient count')).toEqual({ head: '', action: 'Test · patient count' })
  })

  it('leaves a label that names no entity first whole', () => {
    expect(splitEntityHead('Statistics of database “test”')).toEqual({ head: '', action: 'Statistics of database “test”' })
    expect(splitEntityHead('Patient list · one page of patients')).toEqual({ head: '', action: 'Patient list · one page of patients' })
  })
})

