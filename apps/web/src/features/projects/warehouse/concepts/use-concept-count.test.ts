import { describe, expect, it } from 'vitest'
import type { ConceptRun } from '@/lib/api/concept-runs'
import { countSnapshotOf } from './use-concept-count'

const run = (status: ConceptRun['status'], state: ConceptRun['state'], error: string | null = null): ConceptRun => ({
  id: 'r', dataSourceId: 'ds', kind: 'stats', scopeId: 'ds', status, requested: null, state, error,
  jobId: 'j', attempt: 1, createdAt: 'then', updatedAt: 'then', finishedAt: null,
})

describe('the counts of a server run', () => {
  it('are going on while the run counts', () => {
    const live = countSnapshotOf(run('running', {
      stage: 'counts', phase: 'patients', assembled: 2,
      counts: { records: { done: 4, total: 4 }, patients: { done: 3, total: 8 } },
    }))
    expect(live).toMatchObject({
      running: true, phase: 'patients', assembled: 2,
      records: { done: 4, total: 4 }, patients: { done: 3, total: 8 },
    })
  })

  it('are over once the run is on its statistics, or paused', () => {
    expect(countSnapshotOf(run('running', { stage: 'batches' })).running).toBe(false)
    expect(countSnapshotOf(run('paused', { stage: 'counts' }))).toMatchObject({ running: false, phase: null })
  })

  it('carry the run\'s error when they failed it', () => {
    expect(countSnapshotOf(run('failed', { stage: 'counts' }, 'boom')).error).toBe('boom')
    expect(countSnapshotOf(run('failed', { stage: 'batches' }, 'boom')).error).toBeNull()
  })

  it('are none without a run', () => {
    expect(countSnapshotOf(null)).toMatchObject({ running: false, records: { done: 0, total: 0 } })
  })
})
