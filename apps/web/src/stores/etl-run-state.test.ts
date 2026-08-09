import { describe, expect, it, beforeEach } from 'vitest'
import { useEtlStore } from './etl-store'
import type { EtlRunLog } from '@/types'

/**
 * Run state has to survive a tab switch and a Stop, because the ETL page mounts
 * and unmounts its tabs freely: state kept in a component made an in-flight run
 * look finished, and a stopped script stayed "running" for good.
 */

const RUNNING: EtlRunLog = {
  id: 'log-1',
  pipelineId: 'p1',
  fileId: 'f1',
  status: 'running',
  startedAt: new Date(Date.now() - 5_000).toISOString(),
}

describe('ETL run state', () => {
  beforeEach(() => {
    useEtlStore.setState({
      pipelineRunning: false,
      pipelineRunAbort: null,
      scriptStatuses: new Map(),
      runHistory: [],
    })
  })

  it('marks the run as in progress, for any observer', () => {
    useEtlStore.getState().startPipelineRun()
    expect(useEtlStore.getState().pipelineRunning).toBe(true)
  })

  it('stopping resolves the script left in flight', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun()
    store.setScriptStatus('f1', RUNNING)
    useEtlStore.getState().stopPipelineRun()

    const log = useEtlStore.getState().scriptStatuses.get('f1')
    // Not "running": the sidebar showed a spinner for ever after a Stop.
    expect(log?.status).toBe('stopped')
    expect(log?.completedAt).toBeTruthy()
  })

  it('reports how long the stopped script had been going', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun()
    store.setScriptStatus('f1', RUNNING)
    useEtlStore.getState().stopPipelineRun()
    expect(useEtlStore.getState().scriptStatuses.get('f1')?.durationMs).toBeGreaterThan(0)
  })

  it('distinguishes stopped from error — the user chose to stop', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun()
    store.setScriptStatus('f1', RUNNING)
    useEtlStore.getState().stopPipelineRun()
    expect(useEtlStore.getState().scriptStatuses.get('f1')?.status).not.toBe('error')
  })

  it('leaves already-finished scripts alone when stopping', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun()
    store.setScriptStatus('done', { ...RUNNING, fileId: 'done', status: 'success' })
    store.setScriptStatus('f1', RUNNING)
    useEtlStore.getState().stopPipelineRun()

    const statuses = useEtlStore.getState().scriptStatuses
    expect(statuses.get('done')?.status).toBe('success')
    expect(statuses.get('f1')?.status).toBe('stopped')
  })

  it('clears the running flag and the abort controller on stop', () => {
    useEtlStore.getState().startPipelineRun()
    useEtlStore.getState().stopPipelineRun()
    const s = useEtlStore.getState()
    expect(s.pipelineRunning).toBe(false)
    expect(s.pipelineRunAbort).toBeNull()
  })

  it('aborts the signal the runner watches, so the loop ends', () => {
    useEtlStore.getState().startPipelineRun()
    const signal = useEtlStore.getState().pipelineRunAbort?.signal
    useEtlStore.getState().stopPipelineRun()
    expect(signal?.aborted).toBe(true)
  })

  it('stopping without a run in progress is harmless', () => {
    expect(() => useEtlStore.getState().stopPipelineRun()).not.toThrow()
  })
})
