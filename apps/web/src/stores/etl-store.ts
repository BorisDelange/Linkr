import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { migrateEntityIds } from '@/lib/slugify-id'
import { localized, toLocalized } from '@/lib/localized'
import type { EtlPipeline, EtlFile, EtlRunLog, EtlRunHistoryEntry } from '@/types'

// --- Output tab types (mirrors useFileStore pattern) ---

export interface EtlOutputTab {
  id: string
  label: string
  type: 'table' | 'text' | 'figure' | 'html' | 'markdown'
  content: unknown
}

export interface EtlExecutionResult {
  id: string
  fileName: string
  language: string
  timestamp: number
  duration: number
  success: boolean
  output: string
  code?: string
}

// --- Store interface ---

interface EtlState {
  // Pipeline CRUD
  etlPipelines: EtlPipeline[]
  etlPipelinesLoaded: boolean
  loadEtlPipelines: () => Promise<void>
  getWorkspacePipelines: (workspaceId: string) => EtlPipeline[]
  createPipeline: (pipeline: EtlPipeline) => Promise<void>
  updatePipeline: (id: string, changes: Partial<EtlPipeline>) => Promise<void>
  deletePipeline: (id: string) => Promise<void>

  // File management (scoped to active pipeline)
  files: EtlFile[]
  filesLoaded: boolean
  activePipelineId: string | null
  loadPipelineFiles: (pipelineId: string) => Promise<void>
  createFile: (file: EtlFile) => Promise<void>
  updateFile: (id: string, changes: Partial<EtlFile>) => Promise<void>
  deleteFile: (id: string) => Promise<void>

  // Editor state
  selectedFileId: string | null
  openFileIds: string[]
  selectFile: (id: string) => void
  closeFile: (id: string) => void
  reorderOpenFiles: (fromIdx: number, toIdx: number) => void
  updateFileContent: (id: string, content: string) => void

  // Dirty tracking
  _dirtyMap: Map<string, string>
  _dirtyVersion: number
  isFileDirty: (id: string) => boolean
  saveFile: (id: string) => Promise<void>
  revertFile: (id: string) => void

  // Pipeline run state
  pipelineRunning: boolean
  pipelineRunAbort: AbortController | null
  scriptStatuses: Map<string, EtlRunLog>
  runHistory: EtlRunHistoryEntry[]
  /** False until this pipeline's history has been read. The quality-check cache
   *  keys on the last run, so acting on an empty history would recompute the
   *  table once and then again the moment the runs arrive. */
  runHistoryLoaded: boolean
  /** Returns false when a run is already in progress (the caller must not proceed). */
  /** `fileIds` are the scripts THIS run covers, so progress counts the right
   *  set: running one line must not report "0/16" against the whole pipeline. */
  startPipelineRun: (fileIds?: string[]) => boolean
  /** Scripts of the run in progress, in order. Empty when nothing is running. */
  runningFileIds: string[]
  stopPipelineRun: () => void
  setScriptStatus: (fileId: string, log: EtlRunLog) => void
  finishPipelineRun: (status: 'success' | 'error') => void
  /** Forget every past run: the history list AND the per-script status icons the
   *  Pipeline widgets and the Scripts tree read from it. Refused while a run is
   *  in progress, which would otherwise wipe the state that run is writing. */
  clearRunHistory: () => void
  /** Past runs of this pipeline, from storage. Runs are persisted, so a reload no
   *  longer loses every trace of what was executed against the target. */
  loadRunHistory: (pipelineId: string) => Promise<void>

  // Output tabs
  outputTabs: EtlOutputTab[]
  outputTabOrder: string[]
  activeOutputTab: string | null
  executionResults: EtlExecutionResult[]
  outputVisible: boolean
  addOutputTab: (tab: EtlOutputTab) => void
  closeOutputTab: (id: string) => void
  setActiveOutputTab: (id: string) => void
  reorderAllOutputTabs: (fromIdx: number, toIdx: number) => void
  addExecutionResult: (result: EtlExecutionResult) => void
  updateExecutionResult: (id: string, changes: Partial<EtlExecutionResult>) => void
  clearExecutionResults: () => void
  setOutputVisible: (visible: boolean) => void
}

/** How many past runs are kept. A run is rewritten on every progress tick, so an
 *  unbounded list would grow without ever being read past the first screen. */
const MAX_RUN_HISTORY = 50

/**
 * The per-script badge map for a run: fileId → its log.
 *
 * Exported for its test, and used to restore the DAG widgets and tree marks after
 * a reload. A script left 'running' by a run that was interrupted (the tab closed
 * mid-run, say) is reported as 'stopped': nothing is executing now, so a spinner
 * would claim work that is not happening.
 */
export function statusesOf(run: EtlRunHistoryEntry | undefined): Map<string, EtlRunLog> {
  const out = new Map<string, EtlRunLog>()
  if (!run) return out
  for (const log of run.scripts) {
    out.set(log.fileId, log.status === 'running' ? { ...log, status: 'stopped' } : log)
  }
  return out
}

/**
 * Mirror a run to storage, fire-and-forget.
 *
 * Deliberately not awaited by the callers: a run writes its history on every
 * progress tick, and making the UI wait on a round trip (or fail with it) would
 * turn a persistence hiccup into a broken run. The in-memory state stays
 * authoritative for the live display; storage is the record for the next reload.
 */
function persistRun(entry: EtlRunHistoryEntry | undefined): void {
  if (!entry) return
  // try/catch AND .catch(): getStorage() throws synchronously when storage is not
  // initialised yet, so a promise-only guard would still take the run down with it.
  try {
    void getStorage().etlRunHistory.save(entry).catch(() => {})
  } catch {
    // Swallowed on purpose: losing a history row must not interrupt the run.
  }
}

export const useEtlStore = create<EtlState>((set, get) => ({
  // --- Pipeline CRUD ---
  etlPipelines: [],
  etlPipelinesLoaded: false,

  loadEtlPipelines: async () => {
    const storage = getStorage()
    const all = await storage.etlPipelines.getAll()
    for (const p of migrateEntityIds(all, e => localized(e.name, 'en'))) {
      storage.etlPipelines.update(p.id, { entityId: p.entityId }).catch(() => {})
    }
    for (const p of all) {
      if (typeof p.name === 'string' || typeof p.description === 'string') {
        p.name = toLocalized(p.name)
        p.description = toLocalized(p.description)
        storage.etlPipelines.update(p.id, { name: p.name, description: p.description }).catch(() => {})
      }
    }
    set({ etlPipelines: all, etlPipelinesLoaded: true })
  },

  getWorkspacePipelines: (workspaceId) =>
    get().etlPipelines.filter((p) => p.workspaceId === workspaceId),

  createPipeline: async (pipeline) => {
    await getStorage().etlPipelines.create(pipeline)
    set((s) => ({ etlPipelines: [...s.etlPipelines, pipeline] }))
  },

  updatePipeline: async (id, changes) => {
    await getStorage().etlPipelines.update(id, changes)
    set((s) => ({
      etlPipelines: s.etlPipelines.map((p) =>
        p.id === id ? { ...p, ...changes, updatedAt: new Date().toISOString() } : p,
      ),
    }))
  },

  deletePipeline: async (id) => {
    await getStorage().etlFiles.deleteByPipeline(id)
    await getStorage().etlPipelines.delete(id)
    set((s) => ({
      etlPipelines: s.etlPipelines.filter((p) => p.id !== id),
      files: s.activePipelineId === id ? [] : s.files,
      activePipelineId: s.activePipelineId === id ? null : s.activePipelineId,
    }))
  },

  // --- File management ---
  files: [],
  filesLoaded: false,
  activePipelineId: null,

  loadPipelineFiles: async (pipelineId) => {
    // Re-mounting the SAME pipeline (navigating away and back, switching tabs) must
    // not clear the run state: this runs on every mount, so a run in flight lost
    // its per-script badges, the current script and its query progress — the run
    // itself kept going invisibly. Only a DIFFERENT pipeline needs the wipe, or its
    // predecessor's runs would show as if they belonged here.
    const files = await getStorage().etlFiles.getByPipeline(pipelineId)
    // Read AFTER the await: computing it before meant a run (or a pipeline switch)
    // starting during the fetch was judged against a stale activePipelineId.
    const samePipeline = get().activePipelineId === pipelineId
    set({
      files: files.sort((a, b) => a.order - b.order),
      filesLoaded: true,
      activePipelineId: pipelineId,
      _dirtyMap: new Map(),
      _dirtyVersion: 0,
      ...(samePipeline ? {} : { runHistory: [], runHistoryLoaded: false, scriptStatuses: new Map() }),
    })
    // Not awaited with the files: the editor should not wait on the history, and a
    // storage error here must not leave the tab without its scripts.
    // Skipped while a run is in flight: loadRunHistory rebuilds scriptStatuses from
    // the LAST FINISHED run, which would overwrite the live badges of the run in
    // progress with the previous one's results.
    if (!get().pipelineRunning) void get().loadRunHistory(pipelineId).catch(() => {})
  },

  createFile: async (file) => {
    await getStorage().etlFiles.create(file)
    set((s) => ({
      files: [...s.files, file].sort((a, b) => a.order - b.order),
    }))
  },

  updateFile: async (id, changes) => {
    await getStorage().etlFiles.update(id, changes)
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, ...changes } : f)),
    }))
  },

  deleteFile: async (id) => {
    await getStorage().etlFiles.delete(id)
    set((s) => {
      const newDirtyMap = new Map(s._dirtyMap)
      newDirtyMap.delete(id)
      return {
        files: s.files.filter((f) => f.id !== id),
        openFileIds: s.openFileIds.filter((fid) => fid !== id),
        selectedFileId: s.selectedFileId === id
          ? s.openFileIds.filter((fid) => fid !== id)[0] ?? null
          : s.selectedFileId,
        _dirtyMap: newDirtyMap,
      }
    })
  },

  // --- Editor state ---
  selectedFileId: null,
  openFileIds: [],

  selectFile: (id) => {
    set((s) => ({
      selectedFileId: id,
      openFileIds: s.openFileIds.includes(id) ? s.openFileIds : [...s.openFileIds, id],
    }))
  },

  closeFile: (id) => {
    set((s) => {
      const newOpen = s.openFileIds.filter((fid) => fid !== id)
      const newDirtyMap = new Map(s._dirtyMap)
      newDirtyMap.delete(id)
      return {
        openFileIds: newOpen,
        selectedFileId:
          s.selectedFileId === id
            ? newOpen[Math.min(s.openFileIds.indexOf(id), newOpen.length - 1)] ?? null
            : s.selectedFileId,
        _dirtyMap: newDirtyMap,
      }
    })
  },

  reorderOpenFiles: (fromIdx, toIdx) => {
    set((s) => {
      const arr = [...s.openFileIds]
      const [item] = arr.splice(fromIdx, 1)
      arr.splice(toIdx, 0, item)
      return { openFileIds: arr }
    })
  },

  updateFileContent: (id, content) => {
    set((s) => {
      const dirtyMap = new Map(s._dirtyMap)
      const file = s.files.find((f) => f.id === id)
      // Store original content on first edit
      if (!dirtyMap.has(id) && file) {
        dirtyMap.set(id, file.content ?? '')
      }
      return {
        files: s.files.map((f) => (f.id === id ? { ...f, content } : f)),
        _dirtyMap: dirtyMap,
        _dirtyVersion: s._dirtyVersion + 1,
      }
    })
  },

  // --- Dirty tracking ---
  _dirtyMap: new Map(),
  _dirtyVersion: 0,

  isFileDirty: (id) => {
    const s = get()
    if (!s._dirtyMap.has(id)) return false
    const file = s.files.find((f) => f.id === id)
    return file?.content !== s._dirtyMap.get(id)
  },

  saveFile: async (id) => {
    const file = get().files.find((f) => f.id === id)
    if (!file) return
    await getStorage().etlFiles.update(id, { content: file.content })
    set((s) => {
      const dirtyMap = new Map(s._dirtyMap)
      dirtyMap.delete(id)
      return { _dirtyMap: dirtyMap, _dirtyVersion: s._dirtyVersion + 1 }
    })
  },

  revertFile: (id) => {
    const original = get()._dirtyMap.get(id)
    if (original === undefined) return
    set((s) => {
      const dirtyMap = new Map(s._dirtyMap)
      dirtyMap.delete(id)
      return {
        files: s.files.map((f) => (f.id === id ? { ...f, content: original } : f)),
        _dirtyMap: dirtyMap,
        _dirtyVersion: s._dirtyVersion + 1,
      }
    })
  },

  // --- Output tabs ---
  outputTabs: [],
  outputTabOrder: [],
  activeOutputTab: null,
  executionResults: [],
  outputVisible: false,

  addOutputTab: (tab) => {
    set((s) => {
      const exists = s.outputTabs.find((t) => t.id === tab.id)
      if (exists) {
        return {
          outputTabs: s.outputTabs.map((t) => (t.id === tab.id ? tab : t)),
          activeOutputTab: tab.id,
          outputVisible: true,
        }
      }
      return {
        outputTabs: [...s.outputTabs, tab],
        outputTabOrder: [...s.outputTabOrder, tab.id],
        activeOutputTab: tab.id,
        outputVisible: true,
      }
    })
  },

  closeOutputTab: (id) => {
    set((s) => {
      const newTabs = s.outputTabs.filter((t) => t.id !== id)
      const newOrder = s.outputTabOrder.filter((tid) => tid !== id)
      return {
        outputTabs: newTabs,
        outputTabOrder: newOrder,
        activeOutputTab:
          s.activeOutputTab === id
            ? newOrder[0] ?? null
            : s.activeOutputTab,
      }
    })
  },

  setActiveOutputTab: (id) => set({ activeOutputTab: id }),

  reorderAllOutputTabs: (fromIdx, toIdx) => {
    set((s) => {
      const arr = [...s.outputTabOrder]
      const [item] = arr.splice(fromIdx, 1)
      arr.splice(toIdx, 0, item)
      return { outputTabOrder: arr }
    })
  },

  addExecutionResult: (result) => {
    set((s) => {
      const consoleId = '__exec_console__'
      const hasConsole = s.outputTabOrder.includes(consoleId)
      return {
        executionResults: [...s.executionResults, result],
        outputTabOrder: hasConsole ? s.outputTabOrder : [consoleId, ...s.outputTabOrder],
        activeOutputTab: consoleId,
        outputVisible: true,
      }
    })
  },

  updateExecutionResult: (id, changes) => {
    set((s) => ({
      executionResults: s.executionResults.map((r) =>
        r.id === id ? { ...r, ...changes } : r,
      ),
    }))
  },

  clearExecutionResults: () => {
    set((s) => ({
      executionResults: [],
      outputTabOrder: s.outputTabOrder.filter((id) => id !== '__exec_console__'),
      activeOutputTab:
        s.activeOutputTab === '__exec_console__'
          ? s.outputTabOrder.filter((id) => id !== '__exec_console__')[0] ?? null
          : s.activeOutputTab,
    }))
  },

  setOutputVisible: (visible) => set({ outputVisible: visible }),

  // --- Pipeline run state ---
  pipelineRunning: false,
  pipelineRunAbort: null,
  runningFileIds: [],
  scriptStatuses: new Map(),
  runHistory: [],
  runHistoryLoaded: false,

  startPipelineRun: (fileIds = []) => {
    // Re-entrancy guard: the store is shared across tabs, so a Run in the Scripts
    // tab while the Pipeline tab is mid-run would otherwise replace the live
    // AbortController — Stop would then only reach the second run and the first
    // would keep executing against the target with no way to stop it.
    if (get().pipelineRunning) return false
    const abort = new AbortController()
    const runId = `run-${Date.now()}`
    // Persisted rows are keyed by pipeline, so a run has to know which one it
    // belongs to — the history panel of another pipeline must not show it.
    const pipelineId = get().activePipelineId ?? ''
    const entry: EtlRunHistoryEntry = {
      id: runId,
      pipelineId,
      startedAt: new Date().toISOString(),
      status: 'running',
      scripts: [],
    }
    set((s) => ({
      pipelineRunning: true,
      pipelineRunAbort: abort,
      runningFileIds: fileIds,
      scriptStatuses: new Map(),
      runHistory: [entry, ...s.runHistory].slice(0, MAX_RUN_HISTORY),
    }))
    if (pipelineId) persistRun(entry)
    return true
  },

  stopPipelineRun: () => {
    // Computed in the updater, persisted after it returns: a `set` updater must
    // stay pure, or a double-render would save twice.
    let toPersist: EtlRunHistoryEntry | undefined
    const { pipelineRunAbort } = get()
    pipelineRunAbort?.abort()
    set((s) => {
      // The script in flight keeps its own status, which would otherwise stay
      // "running" for good — the abort only stops the loop, it cannot interrupt a
      // statement already sent, so the honest label is "stopped", not "error".
      const stoppedNow = (log: EtlRunLog): EtlRunLog => (
        log.status === 'running'
          ? {
              ...log,
              status: 'stopped',
              completedAt: new Date().toISOString(),
              durationMs: log.startedAt
                ? Date.now() - new Date(log.startedAt).getTime()
                : undefined,
            }
          : log
      )

      const history = [...s.runHistory]
      if (history.length > 0 && history[0].status === 'running') {
        history[0] = {
          ...history[0],
          status: 'error',
          completedAt: new Date().toISOString(),
          // The history keeps its OWN copies of these logs, so relabelling only
          // scriptStatuses left the run's entry showing a spinner for ever.
          scripts: history[0].scripts.map(stoppedNow),
        }
      }

      const statuses = new Map(s.scriptStatuses)
      for (const [fileId, log] of statuses) statuses.set(fileId, stoppedNow(log))
      toPersist = history[0]
      return {
        pipelineRunning: false,
        pipelineRunAbort: null,
        runningFileIds: [],
        runHistory: history,
        scriptStatuses: statuses,
      }
    })
    persistRun(toPersist)
  },

  setScriptStatus: (fileId, log) => {
    // Computed in the updater, persisted after it returns: a `set` updater must
    // stay pure, or a double-render would save twice.
    let toPersist: EtlRunHistoryEntry | undefined
    set((s) => {
      // A statement already in flight when Stop was pressed keeps running and its
      // next progress callback would otherwise flip the script back from 'stopped'
      // to 'running' (stopped → running → stopped flicker). A terminal status wins.
      const prev = s.scriptStatuses.get(fileId)
      if (prev && prev.status !== 'running' && log.status === 'running') {
        return s
      }
      const newStatuses = new Map(s.scriptStatuses)
      newStatuses.set(fileId, log)
      const history = [...s.runHistory]
      if (history.length > 0 && history[0].status === 'running') {
        const existing = history[0].scripts.findIndex((l) => l.fileId === fileId)
        const scripts = [...history[0].scripts]
        if (existing >= 0) scripts[existing] = log
        else scripts.push(log)
        history[0] = { ...history[0], scripts }
        // Only when a script REACHES a terminal state: this runs on every
        // progress tick (once per SQL statement), and saving each one would
        // hammer the API for information that is superseded a moment later.
        if (log.status !== 'running') toPersist = history[0]
      }
      return { scriptStatuses: newStatuses, runHistory: history }
    })
    persistRun(toPersist)
  },

  loadRunHistory: async (pipelineId) => {
    const runs = await getStorage().etlRunHistory.getByPipeline(pipelineId)
    // Re-checked AFTER the await, not only by the caller before it: a run started
    // while this read was in flight would otherwise be overwritten by the stale
    // history. That evicted the live entry, and since finishPipelineRun only
    // updates history[0] when it is still 'running', the run could then NEVER
    // reach a terminal status — it stayed 'running' in storage for good, and
    // statusesOf relabelled it 'stopped' on every later reload. Same for a
    // pipeline switch mid-read: the answer belongs to the pipeline we asked about.
    if (get().pipelineRunning || get().activePipelineId !== pipelineId) return
    // Newest first, as the panel lists them. The server already orders that way,
    // but the IDB index does not, so sorting here keeps both backends identical.
    const history = runs
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, MAX_RUN_HISTORY)
    set({
      runHistory: history,
      runHistoryLoaded: true,
      // Rebuild the per-script badges from the LAST run, so the green ticks and
      // error marks on the DAG widgets and in the Scripts tree survive leaving the
      // page — they are a view of the last run, which is now persisted. Only the
      // most recent one: an older run's result is not what the pipeline looks like
      // today, and merging several would show a success that has since failed.
      scriptStatuses: statusesOf(history[0]),
    })
  },

  clearRunHistory: () => {
    // Both, not just the list: the badges on the script widgets and in the
    // Scripts tree are views of scriptStatuses, so clearing the history alone
    // would leave green ticks for runs the user just asked to forget.
    if (get().pipelineRunning) return
    const pipelineId = get().activePipelineId
    set({ runHistory: [], scriptStatuses: new Map() })
    if (pipelineId) {
      // Guarded like persistRun: clearing the list must succeed for the user even
      // if the storage write cannot.
      try {
        void getStorage().etlRunHistory.deleteByPipeline(pipelineId).catch(() => {})
      } catch { /* empty */ }
    }
  },

  finishPipelineRun: (status) => {
    // Computed in the updater, persisted after it returns (like clearRunHistory):
    // a `set` updater must stay pure, or a double-render would save twice.
    let toPersist: EtlRunHistoryEntry | undefined
    set((s) => {
      const history = [...s.runHistory]
      if (history.length > 0 && history[0].status === 'running') {
        history[0] = { ...history[0], status, completedAt: new Date().toISOString() }
        toPersist = history[0]
      }
      return { pipelineRunning: false, pipelineRunAbort: null, runningFileIds: [], runHistory: history }
    })
    persistRun(toPersist)
  },
}))
