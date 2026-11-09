import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useEtlStore } from './etl-store'
import type { ServerRun } from '@/lib/api/server-runs'
import type { EtlRunState } from '@/lib/api/etl-runs'

/**
 * Server mode with a managed target: the pipeline runs on the server and the
 * store only mirrors it — a reload reads it back, Pause and Stop go there.
 */

const run = (status: ServerRun['status'], state: EtlRunState): ServerRun<EtlRunState> => ({
  id: 'run-1', dataSourceId: 'target', kind: 'etl', scopeId: 'target', status, requested: null,
  state: { pipelineId: 'p1', fileIds: ['f1', 'f2', 'f3'], startedAt: '2026-11-08T10:00:00.000Z', ...state },
  error: null, jobId: 'j', attempt: 1, createdAt: 'then', updatedAt: 'then', finishedAt: null,
})

const SECOND_RUNNING: EtlRunState = {
  next: 1,
  scripts: [
    { id: 'l1', pipelineId: 'p1', fileId: 'f1', status: 'success' },
    { id: 'l2', pipelineId: 'p1', fileId: 'f2', status: 'running', statementsDone: 2, statementsTotal: 5 },
  ],
  current: { fileId: 'f2', index: 2, total: 5, sql: 'INSERT …', reading: 40 },
}

describe('a pipeline run on the server, mirrored', () => {
  beforeEach(() => {
    useEtlStore.setState({
      activePipelineId: 'p1', pipelineRunning: false, pipelineRunAbort: null, runningFileIds: [],
      scriptStatuses: new Map(), runHistory: [], pausedRun: null, mirroredRunId: null, serverDriver: null, runReading: null,
    })
  })

  it('shows a run going on, script by script, wherever it was started', () => {
    useEtlStore.getState().mirrorServerRun(run('running', SECOND_RUNNING))
    const s = useEtlStore.getState()
    expect(s.pipelineRunning).toBe(true)
    expect(s.runningFileIds).toEqual(['f1', 'f2', 'f3'])
    expect(s.scriptStatuses.get('f1')?.status).toBe('success')
    expect(s.scriptStatuses.get('f2')).toMatchObject({ status: 'running', statementsDone: 2 })
    expect(s.runReading).toBe(40)
    expect(s.runHistory[0]).toMatchObject({ id: 'run-1', status: 'running' })
  })

  it('offers to resume a paused run from the script it cut', () => {
    useEtlStore.getState().mirrorServerRun(run('paused', {
      ...SECOND_RUNNING,
      scripts: [SECOND_RUNNING.scripts![0], { ...SECOND_RUNNING.scripts![1], status: 'stopped' }],
    }))
    const s = useEtlStore.getState()
    expect(s.pipelineRunning).toBe(false)
    expect(s.pausedRun).toEqual({ runId: 'run-1', pendingFileIds: ['f2', 'f3'] })
  })

  it('lets the history speak once the run ended', () => {
    const load = vi.fn(async () => {})
    useEtlStore.setState({ loadRunHistory: load })
    useEtlStore.getState().mirrorServerRun(run('running', SECOND_RUNNING))
    useEtlStore.getState().mirrorServerRun(run('done', { ...SECOND_RUNNING, next: 3 }))
    const s = useEtlStore.getState()
    expect(s.pipelineRunning).toBe(false)
    expect(s.mirroredRunId).toBeNull()
    expect(load).toHaveBeenCalledWith('p1')
  })

  it('leaves alone a run of another pipeline on the same target', () => {
    useEtlStore.getState().mirrorServerRun(run('running', { ...SECOND_RUNNING, pipelineId: 'p2' }))
    expect(useEtlStore.getState().pipelineRunning).toBe(false)
  })

  it('sends Pause, Stop and discard to the server', () => {
    const driver = { pause: vi.fn(), cancel: vi.fn() }
    useEtlStore.getState().setServerDriver(driver)
    useEtlStore.getState().mirrorServerRun(run('running', SECOND_RUNNING))
    useEtlStore.getState().pausePipelineRun()
    expect(driver.pause).toHaveBeenCalledOnce()
    useEtlStore.getState().stopPipelineRun()
    expect(driver.cancel).toHaveBeenCalledOnce()
    // Still mirrored as it was: the server says when it stopped.
    expect(useEtlStore.getState().pipelineRunning).toBe(true)
    useEtlStore.getState().mirrorServerRun(run('paused', SECOND_RUNNING))
    useEtlStore.getState().discardPausedRun()
    expect(driver.cancel).toHaveBeenCalledTimes(2)
  })
})
