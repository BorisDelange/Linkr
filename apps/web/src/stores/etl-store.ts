import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { EtlPipeline, EtlFile } from '@/types'

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

export const useEtlStore = create<EtlState>((set, get) => ({
  // --- Pipeline CRUD ---
  etlPipelines: [],
  etlPipelinesLoaded: false,

  loadEtlPipelines: async () => {
    const all = await getStorage().etlPipelines.getAll()
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
    const files = await getStorage().etlFiles.getByPipeline(pipelineId)
    set({
      files: files.sort((a, b) => a.order - b.order),
      filesLoaded: true,
      activePipelineId: pipelineId,
    })
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
    set((s) => ({
      files: s.files.filter((f) => f.id !== id),
      openFileIds: s.openFileIds.filter((fid) => fid !== id),
      selectedFileId: s.selectedFileId === id
        ? s.openFileIds.filter((fid) => fid !== id)[0] ?? null
        : s.selectedFileId,
    }))
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
}))
