import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { statusesOf, useEtlStore } from './etl-store'
import { initStorage } from '@/lib/storage'
import type { EtlRunLog, EtlRunHistoryEntry } from '@/types'

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
      runningFileIds: [],
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

  it('a late progress callback cannot flip a stopped script back to running', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun()
    store.setScriptStatus('f1', RUNNING)
    useEtlStore.getState().stopPipelineRun()
    expect(useEtlStore.getState().scriptStatuses.get('f1')?.status).toBe('stopped')
    // The in-flight statement's next progress tick arrives AFTER the stop.
    useEtlStore.getState().setScriptStatus('f1', RUNNING)
    expect(useEtlStore.getState().scriptStatuses.get('f1')?.status).toBe('stopped')
  })

  it('refuses a second run while one is in progress', () => {
    expect(useEtlStore.getState().startPipelineRun()).toBe(true)
    const firstAbort = useEtlStore.getState().pipelineRunAbort
    // A second Run (e.g. from another tab) must not replace the live controller.
    expect(useEtlStore.getState().startPipelineRun()).toBe(false)
    expect(useEtlStore.getState().pipelineRunAbort).toBe(firstAbort)
  })
})

describe('clearing the run history', () => {
  beforeEach(() => {
    useEtlStore.setState({
      pipelineRunning: false,
      pipelineRunAbort: null,
      runningFileIds: [],
      scriptStatuses: new Map(),
      runHistory: [],
    })
  })

  it('forgets the per-script marks as well as the list', () => {
    // The ticks on the pipeline widgets and in the Scripts tree are views of
    // scriptStatuses: clearing only the list would leave them behind.
    const store = useEtlStore.getState()
    store.startPipelineRun(['f1'])
    store.setScriptStatus('f1', { ...RUNNING, status: 'success' })
    store.finishPipelineRun('success')

    expect(useEtlStore.getState().runHistory).toHaveLength(1)
    expect(useEtlStore.getState().scriptStatuses.size).toBe(1)

    useEtlStore.getState().clearRunHistory()
    expect(useEtlStore.getState().runHistory).toHaveLength(0)
    expect(useEtlStore.getState().scriptStatuses.size).toBe(0)
  })

  it('refuses while a run is in progress', () => {
    // Clearing mid-run would wipe the state that run is writing.
    const store = useEtlStore.getState()
    store.startPipelineRun(['f1'])
    store.setScriptStatus('f1', RUNNING)

    useEtlStore.getState().clearRunHistory()
    expect(useEtlStore.getState().scriptStatuses.size).toBe(1)
    expect(useEtlStore.getState().runHistory).toHaveLength(1)
  })

  it('is safe on an empty history', () => {
    useEtlStore.getState().clearRunHistory()
    expect(useEtlStore.getState().runHistory).toEqual([])
  })
})

describe('the scripts a run covers', () => {
  beforeEach(() => {
    useEtlStore.setState({
      pipelineRunning: false, pipelineRunAbort: null,
      runningFileIds: [], scriptStatuses: new Map(), runHistory: [],
    })
  })

  it('records just the declared set, so one line is not counted against the pipeline', () => {
    useEtlStore.getState().startPipelineRun(['f2'])
    expect(useEtlStore.getState().runningFileIds).toEqual(['f2'])
  })

  it('clears the set when the run ends', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun(['f1', 'f2'])
    store.finishPipelineRun('success')
    expect(useEtlStore.getState().runningFileIds).toEqual([])
  })

  it('clears the set on a stop, too', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun(['f1'])
    useEtlStore.getState().stopPipelineRun()
    expect(useEtlStore.getState().runningFileIds).toEqual([])
  })
})

describe('a stopped run in the history', () => {
  beforeEach(() => {
    useEtlStore.setState({
      pipelineRunning: false, pipelineRunAbort: null,
      runningFileIds: [], scriptStatuses: new Map(), runHistory: [],
    })
  })

  it('does not leave the history entry showing a spinner', () => {
    // The history keeps its OWN copies of the logs, so relabelling only
    // scriptStatuses left 00_vocabulary.sql "running" for ever in the panel.
    const store = useEtlStore.getState()
    store.startPipelineRun(['f1'])
    store.setScriptStatus('f1', RUNNING)

    useEtlStore.getState().stopPipelineRun()

    const run = useEtlStore.getState().runHistory[0]
    expect(run.scripts.map((s) => s.status)).toEqual(['stopped'])
    expect(useEtlStore.getState().scriptStatuses.get('f1')?.status).toBe('stopped')
  })

  it('leaves a script that already finished alone', () => {
    // Only the one in flight becomes 'stopped'; a success stays a success.
    const store = useEtlStore.getState()
    store.startPipelineRun(['f1', 'f2'])
    store.setScriptStatus('f1', { ...RUNNING, status: 'success' })
    store.setScriptStatus('f2', { ...RUNNING, id: 'log-2', fileId: 'f2' })

    useEtlStore.getState().stopPipelineRun()

    const byFile = new Map(
      useEtlStore.getState().runHistory[0].scripts.map((s) => [s.fileId, s.status]),
    )
    expect(byFile.get('f1')).toBe('success')
    expect(byFile.get('f2')).toBe('stopped')
  })

  it('records how long the interrupted script had been going', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun(['f1'])
    store.setScriptStatus('f1', RUNNING)
    useEtlStore.getState().stopPipelineRun()
    const log = useEtlStore.getState().runHistory[0].scripts[0]
    expect(log.durationMs).toBeGreaterThan(0)
    expect(log.completedAt).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Runs used to live only here, so a reload erased every trace of what had been
 * executed against the target. They are now mirrored to storage — without ever
 * letting a storage problem interrupt the run itself.
 */
describe('persisting the run history', () => {
  let saved: EtlRunHistoryEntry[]
  let deletedPipelines: string[]

  beforeEach(() => {
    saved = []
    deletedPipelines = []
    initStorage({
      etlRunHistory: {
        getByPipeline: async () => [],
        save: async (entry: EtlRunHistoryEntry) => { saved.push(entry) },
        delete: async () => {},
        deleteByPipeline: async (id: string) => { deletedPipelines.push(id) },
      },
    } as unknown as Parameters<typeof initStorage>[0])

    useEtlStore.setState({
      pipelineRunning: false,
      pipelineRunAbort: null,
      runningFileIds: [],
      scriptStatuses: new Map(),
      runHistory: [],
      activePipelineId: 'p1',
    })
  })

  afterEach(() => {
    // Leave the module-level storage unset for the tests that assert a run
    // survives having none.
    initStorage(undefined as unknown as Parameters<typeof initStorage>[0])
  })

  it('saves the run when it starts, tagged with its pipeline', () => {
    useEtlStore.getState().startPipelineRun(['f1'])
    expect(saved).toHaveLength(1)
    expect(saved[0].pipelineId).toBe('p1')
    expect(saved[0].status).toBe('running')
  })

  it('saves again when the run finishes, with the final status', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun(['f1'])
    useEtlStore.getState().finishPipelineRun('success')
    expect(saved.at(-1)?.status).toBe('success')
    expect(saved.at(-1)?.completedAt).toBeDefined()
  })

  it('does not save on every progress tick, only on a terminal script status', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun(['f1'])
    const afterStart = saved.length
    // Three statements of the same script reported as running.
    for (const done of [0, 1, 2]) {
      useEtlStore.getState().setScriptStatus('f1', { ...RUNNING, statementsDone: done })
    }
    expect(saved).toHaveLength(afterStart)

    useEtlStore.getState().setScriptStatus('f1', { ...RUNNING, status: 'success' })
    expect(saved.length).toBe(afterStart + 1)
  })

  it('records the stop, so a reload does not show a spinner for ever', () => {
    const store = useEtlStore.getState()
    store.startPipelineRun(['f1'])
    useEtlStore.getState().setScriptStatus('f1', RUNNING)
    useEtlStore.getState().stopPipelineRun()
    const last = saved.at(-1)!
    expect(last.status).toBe('error')
    expect(last.scripts[0].status).toBe('stopped')
  })

  it('clearing the history deletes the pipeline\'s stored runs too', () => {
    useEtlStore.getState().startPipelineRun(['f1'])
    useEtlStore.getState().finishPipelineRun('success')
    useEtlStore.getState().clearRunHistory()
    expect(deletedPipelines).toEqual(['p1'])
  })

  it('loads past runs newest first, capped', async () => {
    initStorage({
      etlRunHistory: {
        getByPipeline: async () => ([
          { id: 'a', pipelineId: 'p1', startedAt: '2026-08-10T09:00:00Z', status: 'success', scripts: [] },
          { id: 'b', pipelineId: 'p1', startedAt: '2026-08-10T11:00:00Z', status: 'error', scripts: [] },
          { id: 'c', pipelineId: 'p1', startedAt: '2026-08-10T10:00:00Z', status: 'success', scripts: [] },
        ]),
        save: async () => {},
        delete: async () => {},
        deleteByPipeline: async () => {},
      },
    } as unknown as Parameters<typeof initStorage>[0])

    await useEtlStore.getState().loadRunHistory('p1')
    expect(useEtlStore.getState().runHistory.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('a failing storage never breaks the run', () => {
    initStorage({
      etlRunHistory: {
        getByPipeline: async () => [],
        save: async () => { throw new Error('offline') },
        delete: async () => {},
        deleteByPipeline: async () => { throw new Error('offline') },
      },
    } as unknown as Parameters<typeof initStorage>[0])

    expect(() => useEtlStore.getState().startPipelineRun(['f1'])).not.toThrow()
    expect(useEtlStore.getState().pipelineRunning).toBe(true)
    expect(() => useEtlStore.getState().finishPipelineRun('success')).not.toThrow()
    expect(() => useEtlStore.getState().clearRunHistory()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Badges restored after leaving the page
// ---------------------------------------------------------------------------

describe('restoring the per-script badges', () => {
  it('rebuilds them from a run, keyed by file', () => {
    // The green ticks and error marks on the DAG widgets and in the Scripts tree
    // used to vanish on leaving the page, even though the run was persisted.
    const map = statusesOf({
      id: 'r1', pipelineId: 'p1', startedAt: '2026-08-10T09:00:00Z', status: 'error',
      scripts: [
        { id: 'l1', pipelineId: 'p1', fileId: 'f1', status: 'success' },
        { id: 'l2', pipelineId: 'p1', fileId: 'f2', status: 'error', error: 'boom' },
      ],
    })
    expect(map.get('f1')?.status).toBe('success')
    expect(map.get('f2')?.status).toBe('error')
    expect(map.get('f2')?.error).toBe('boom')
  })

  it('reports a script left mid-run as stopped, not running', () => {
    // The tab was closed while it ran: nothing is executing now, so a spinner
    // would claim work that is not happening.
    const map = statusesOf({
      id: 'r1', pipelineId: 'p1', startedAt: '2026-08-10T09:00:00Z', status: 'running',
      scripts: [{ id: 'l1', pipelineId: 'p1', fileId: 'f1', status: 'running' }],
    })
    expect(map.get('f1')?.status).toBe('stopped')
  })

  it('is empty when there is no run to restore from', () => {
    expect(statusesOf(undefined).size).toBe(0)
  })

  it('loadRunHistory restores the badges of the LAST run only', async () => {
    // An older run's result is not what the pipeline looks like today; merging
    // several would show a success that has since failed.
    initStorage({
      etlRunHistory: {
        getByPipeline: async () => ([
          {
            id: 'old', pipelineId: 'p1', startedAt: '2026-08-10T08:00:00Z', status: 'success',
            scripts: [{ id: 'a', pipelineId: 'p1', fileId: 'f1', status: 'success' }],
          },
          {
            id: 'new', pipelineId: 'p1', startedAt: '2026-08-10T10:00:00Z', status: 'error',
            scripts: [{ id: 'b', pipelineId: 'p1', fileId: 'f1', status: 'error' }],
          },
        ]),
        save: async () => {},
        delete: async () => {},
        deleteByPipeline: async () => {},
      },
    } as unknown as Parameters<typeof initStorage>[0])

    await useEtlStore.getState().loadRunHistory('p1')
    expect(useEtlStore.getState().scriptStatuses.get('f1')?.status).toBe('error')
    initStorage(undefined as unknown as Parameters<typeof initStorage>[0])
  })
})
