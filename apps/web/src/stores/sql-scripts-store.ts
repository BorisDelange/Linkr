import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { SqlScriptCollection, SqlScriptFile } from '@/types'

// --- Output tab types ---

export interface SqlOutputTab {
  id: string
  label: string
  type: 'table' | 'text'
  content: unknown
}

export interface SqlExecutionResult {
  id: string
  fileName: string
  timestamp: number
  duration: number
  success: boolean
  output: string
  code?: string
}

// --- Store interface ---

interface SqlScriptsState {
  // Collection CRUD
  collections: SqlScriptCollection[]
  collectionsLoaded: boolean
  loadCollections: () => Promise<void>
  getWorkspaceCollections: (workspaceId: string) => SqlScriptCollection[]
  createCollection: (collection: SqlScriptCollection) => Promise<void>
  updateCollection: (id: string, changes: Partial<SqlScriptCollection>) => Promise<void>
  deleteCollection: (id: string) => Promise<void>

  // File management (scoped to active collection)
  files: SqlScriptFile[]
  filesLoaded: boolean
  activeCollectionId: string | null
  loadCollectionFiles: (collectionId: string) => Promise<void>
  createFile: (file: SqlScriptFile) => Promise<void>
  updateFile: (id: string, changes: Partial<SqlScriptFile>) => Promise<void>
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
  outputTabs: SqlOutputTab[]
  outputTabOrder: string[]
  activeOutputTab: string | null
  executionResults: SqlExecutionResult[]
  outputVisible: boolean
  addOutputTab: (tab: SqlOutputTab) => void
  closeOutputTab: (id: string) => void
  setActiveOutputTab: (id: string) => void
  addExecutionResult: (result: SqlExecutionResult) => void
  clearExecutionResults: () => void
  setOutputVisible: (visible: boolean) => void
}

export const useSqlScriptsStore = create<SqlScriptsState>((set, get) => ({
  // --- Collection CRUD ---
  collections: [],
  collectionsLoaded: false,

  loadCollections: async () => {
    const all = await getStorage().sqlScriptCollections.getAll()
    set({ collections: all, collectionsLoaded: true })
  },

  getWorkspaceCollections: (workspaceId) =>
    get().collections.filter((c) => c.workspaceId === workspaceId),

  createCollection: async (collection) => {
    await getStorage().sqlScriptCollections.create(collection)
    set((s) => ({ collections: [...s.collections, collection] }))
  },

  updateCollection: async (id, changes) => {
    await getStorage().sqlScriptCollections.update(id, changes)
    set((s) => ({
      collections: s.collections.map((c) =>
        c.id === id ? { ...c, ...changes, updatedAt: new Date().toISOString() } : c,
      ),
    }))
  },

  deleteCollection: async (id) => {
    await getStorage().sqlScriptFiles.deleteByCollection(id)
    await getStorage().sqlScriptCollections.delete(id)
    set((s) => ({
      collections: s.collections.filter((c) => c.id !== id),
      files: s.activeCollectionId === id ? [] : s.files,
      activeCollectionId: s.activeCollectionId === id ? null : s.activeCollectionId,
    }))
  },

  // --- File management ---
  files: [],
  filesLoaded: false,
  activeCollectionId: null,

  loadCollectionFiles: async (collectionId) => {
    const files = await getStorage().sqlScriptFiles.getByCollection(collectionId)
    set({
      files: files.sort((a, b) => a.order - b.order),
      filesLoaded: true,
      activeCollectionId: collectionId,
    })
  },

  createFile: async (file) => {
    await getStorage().sqlScriptFiles.create(file)
    set((s) => ({
      files: [...s.files, file].sort((a, b) => a.order - b.order),
    }))
  },

  updateFile: async (id, changes) => {
    await getStorage().sqlScriptFiles.update(id, changes)
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, ...changes } : f)),
    }))
  },

  deleteFile: async (id) => {
    await getStorage().sqlScriptFiles.delete(id)
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
    await getStorage().sqlScriptFiles.update(id, { content: file.content })
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
