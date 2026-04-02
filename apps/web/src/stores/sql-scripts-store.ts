import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { migrateEntityIds } from '@/lib/slugify-id'
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

interface CollectionOutputState {
  outputTabs: SqlOutputTab[]
  outputTabOrder: string[]
  activeOutputTab: string | null
  executionResults: SqlExecutionResult[]
  outputVisible: boolean
}

const emptyOutput: CollectionOutputState = {
  outputTabs: [],
  outputTabOrder: [],
  activeOutputTab: null,
  executionResults: [],
  outputVisible: false,
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

  // Output tabs (scoped per collection via _outputByCollection)
  _outputByCollection: Map<string, CollectionOutputState>
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

/** Get the output state for the active collection. */
function getOutput(s: SqlScriptsState): CollectionOutputState {
  if (!s.activeCollectionId) return emptyOutput
  return s._outputByCollection.get(s.activeCollectionId) ?? emptyOutput
}

/** Build a partial state update that writes to the active collection's output bucket
 *  and also refreshes the top-level derived fields. */
function setOutput(
  s: SqlScriptsState,
  patch: Partial<CollectionOutputState>,
): Partial<SqlScriptsState> {
  const colId = s.activeCollectionId
  if (!colId) return {}
  const prev = s._outputByCollection.get(colId) ?? { ...emptyOutput }
  const next = { ...prev, ...patch }
  const map = new Map(s._outputByCollection)
  map.set(colId, next)
  return {
    _outputByCollection: map,
    outputTabs: next.outputTabs,
    outputTabOrder: next.outputTabOrder,
    activeOutputTab: next.activeOutputTab,
    executionResults: next.executionResults,
    outputVisible: next.outputVisible,
  }
}

export const useSqlScriptsStore = create<SqlScriptsState>((set, get) => ({
  // --- Collection CRUD ---
  collections: [],
  collectionsLoaded: false,

  loadCollections: async () => {
    const storage = getStorage()
    const all = await storage.sqlScriptCollections.getAll()
    for (const c of migrateEntityIds(all, e => e.name)) {
      storage.sqlScriptCollections.update(c.id, { entityId: c.entityId }).catch(() => {})
    }
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
    set((s) => {
      const map = new Map(s._outputByCollection)
      map.delete(id)
      return {
        collections: s.collections.filter((c) => c.id !== id),
        files: s.activeCollectionId === id ? [] : s.files,
        activeCollectionId: s.activeCollectionId === id ? null : s.activeCollectionId,
        _outputByCollection: map,
      }
    })
  },

  // --- File management ---
  files: [],
  filesLoaded: false,
  activeCollectionId: null,

  loadCollectionFiles: async (collectionId) => {
    const files = await getStorage().sqlScriptFiles.getByCollection(collectionId)
    // Restore output state for this collection
    const s = get()
    const out = s._outputByCollection.get(collectionId) ?? emptyOutput
    set({
      files: files.sort((a, b) => a.order - b.order),
      filesLoaded: true,
      activeCollectionId: collectionId,
      // Refresh derived output fields from the collection's bucket
      outputTabs: out.outputTabs,
      outputTabOrder: out.outputTabOrder,
      activeOutputTab: out.activeOutputTab,
      executionResults: out.executionResults,
      outputVisible: out.outputVisible,
      _dirtyMap: new Map(),
      _dirtyVersion: 0,
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

  // --- Output tabs (per-collection) ---
  _outputByCollection: new Map(),
  outputTabs: [],
  outputTabOrder: [],
  activeOutputTab: null,
  executionResults: [],
  outputVisible: false,

  addOutputTab: (tab) => {
    set((s) => {
      const cur = getOutput(s)
      const exists = cur.outputTabs.find((t) => t.id === tab.id)
      if (exists) {
        return setOutput(s, {
          outputTabs: cur.outputTabs.map((t) => (t.id === tab.id ? tab : t)),
          activeOutputTab: tab.id,
          outputVisible: true,
        })
      }
      return setOutput(s, {
        outputTabs: [...cur.outputTabs, tab],
        outputTabOrder: [...cur.outputTabOrder, tab.id],
        activeOutputTab: tab.id,
        outputVisible: true,
      })
    })
  },

  closeOutputTab: (id) => {
    set((s) => {
      const cur = getOutput(s)
      const newTabs = cur.outputTabs.filter((t) => t.id !== id)
      const newOrder = cur.outputTabOrder.filter((tid) => tid !== id)
      return setOutput(s, {
        outputTabs: newTabs,
        outputTabOrder: newOrder,
        activeOutputTab:
          cur.activeOutputTab === id
            ? newOrder[0] ?? null
            : cur.activeOutputTab,
      })
    })
  },

  setActiveOutputTab: (id) => {
    set((s) => setOutput(s, { activeOutputTab: id }))
  },

  addExecutionResult: (result) => {
    set((s) => {
      const cur = getOutput(s)
      const consoleId = '__exec_console__'
      const hasConsole = cur.outputTabOrder.includes(consoleId)
      return setOutput(s, {
        executionResults: [...cur.executionResults, result],
        outputTabOrder: hasConsole ? cur.outputTabOrder : [consoleId, ...cur.outputTabOrder],
        activeOutputTab: consoleId,
        outputVisible: true,
      })
    })
  },

  clearExecutionResults: () => {
    set((s) => {
      const cur = getOutput(s)
      const newOrder = cur.outputTabOrder.filter((id) => id !== '__exec_console__')
      return setOutput(s, {
        executionResults: [],
        outputTabOrder: newOrder,
        activeOutputTab:
          cur.activeOutputTab === '__exec_console__'
            ? newOrder[0] ?? null
            : cur.activeOutputTab,
      })
    })
  },

  setOutputVisible: (visible) => {
    set((s) => setOutput(s, { outputVisible: visible }))
  },
}))
