import { describe, expect, it } from 'vitest'
import type { Job } from '@/lib/api/environments'
import { groupJobs } from './job-groups'

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
      job('4', { groupKey: 'g', groupLabel: 'Patient 12' }),
      job('3'),
      job('2', { groupKey: 'g', groupLabel: 'Patient 12' }),
      job('1', { groupKey: 'g', groupLabel: 'Patient 12' }),
    ])
    expect(rows).toHaveLength(2)
    const first = rows[0]
    expect('group' in first && first.group.label).toBe('Patient 12')
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
    expect(groupJobs([job('1', { groupKey: 'g', groupLabel: 'Patient 12' })])).toEqual([{ job: expect.objectContaining({ id: '1' }) }])
  })
})
