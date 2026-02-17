import { create } from 'zustand'
import type { DatasetFile, DatasetAnalysis, DatasetColumn } from '@/types'
import { getStorage } from '@/lib/storage'

export interface UndoAction {
  id: string
  descriptionKey: string
  descriptionParams?: Record<string, string>
  timestamp: number
  undo: () => void
}

interface DatasetState {
  files: DatasetFile[]
  expandedFolders: string[]
  selectedFileId: string | null
  activeProjectUid: string | null
  openFileIds: string[]

  analyses: DatasetAnalysis[]
  openAnalysisIds: string[]
  selectedAnalysisId: string | null

  _dirtyVersion: number
  isFileDirty: (id: string) => boolean
  isAnalysisDirty: (id: string) => boolean

  loadProjectDatasets: (projectUid: string) => Promise<void>
  createFile: (name: string, parentId: string | null) => void
  createFolder: (name: string, parentId: string | null) => void
  deleteNode: (id: string) => void
  renameNode: (id: string, newName: string) => void
  moveNode: (id: string, newParentId: string | null) => void
  duplicateFile: (id: string) => void

  selectFile: (id: string | null) => void
  openFile: (id: string) => void
  closeFile: (id: string) => void
  reorderOpenFiles: (fromIndex: number, toIndex: number) => void
  toggleFolder: (id: string) => void

  loadFileData: (fileId: string) => Promise<void>
  getFileRows: (fileId: string) => Record<string, unknown>[]
  updateCell: (fileId: string, rowIndex: number, columnId: string, value: unknown) => void
  addRow: (fileId: string) => void
  removeRow: (fileId: string, rowIndex: number) => void
  addColumn: (fileId: string, name: string, type: DatasetColumn['type']) => void
  removeColumn: (fileId: string, columnId: string) => void
  renameColumn: (fileId: string, columnId: string, newName: string) => void
  reorderColumns: (fileId: string, fromIndex: number, toIndex: number) => void
  importData: (fileId: string, columns: DatasetColumn[], rows: Record<string, unknown>[]) => void
  createFileWithData: (name: string, parentId: string | null, columns: DatasetColumn[], rows: Record<string, unknown>[], parseOptions?: import('@/types').DatasetParseOptions, rawFile?: { blob: Blob; fileName: string }) => Promise<string>
  reimportData: (fileId: string, columns: DatasetColumn[], rows: Record<string, unknown>[], parseOptions?: import('@/types').DatasetParseOptions) => Promise<void>

  saveFile: (id: string) => Promise<void>
  revertFile: (id: string) => void

  loadAnalyses: (datasetFileId: string) => Promise<void>
  createAnalysis: (datasetFileId: string, name: string, type: DatasetAnalysis['type'], initialConfig?: Record<string, unknown>) => void
  updateAnalysis: (id: string, changes: Partial<DatasetAnalysis>) => void
  deleteAnalysis: (id: string) => void
  renameAnalysis: (id: string, newName: string) => void
  selectAnalysis: (id: string | null) => void
  openAnalysis: (id: string) => void
  closeAnalysis: (id: string) => void
  saveAnalysis: (id: string) => Promise<void>

  undoStack: UndoAction[]
  pushUndo: (action: UndoAction) => void
  performUndo: () => void
  peekUndo: () => UndoAction | undefined
}

let fileCounter = 10
let undoCounter = 0

const _loadedData = new Map<string, Record<string, unknown>[]>()
const _dataSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const _savedDataSnapshot = new Map<string, string>()
const _analysisSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const _savedAnalysisSnapshot = new Map<string, string>()

function getAllDescendants(files: DatasetFile[], parentId: string): string[] {
  const children = files.filter((f) => f.parentId === parentId)
  const ids: string[] = []
  for (const child of children) {
    ids.push(child.id)
    if (child.type === 'folder') {
      ids.push(...getAllDescendants(files, child.id))
    }
  }
  return ids
}

function initFileCounter(files: DatasetFile[], analyses?: DatasetAnalysis[]) {
  let max = 10
  for (const f of files) {
    const match = f.id.match(/^(?:file|folder)-(\d+)$/)
    if (match) {
      const n = parseInt(match[1], 10)
      if (n >= max) max = n + 1
    }
  }
  if (analyses) {
    for (const a of analyses) {
      const match = a.id.match(/^analysis-(\d+)$/)
      if (match) {
        const n = parseInt(match[1], 10)
        if (n >= max) max = n + 1
      }
    }
  }
  fileCounter = max
}

const MAX_UNDO = 50

export const useDatasetStore = create<DatasetState>((set, get) => ({
  files: [],
  expandedFolders: [],
  selectedFileId: null,
  activeProjectUid: null,
  openFileIds: [],

  analyses: [],
  openAnalysisIds: [],
  selectedAnalysisId: null,

  _dirtyVersion: 0,

  isFileDirty: (id) => {
    const file = get().files.find((f) => f.id === id)
    if (!file || file.type !== 'file') return false
    const rows = _loadedData.get(id)
    if (!rows) return false
    const saved = _savedDataSnapshot.get(id)
    return saved !== undefined && JSON.stringify(rows) !== saved
  },

  isAnalysisDirty: (id) => {
    const analysis = get().analyses.find((a) => a.id === id)
    if (!analysis) return false
    const saved = _savedAnalysisSnapshot.get(id)
    return saved !== undefined && JSON.stringify(analysis.config) !== saved
  },

  loadProjectDatasets: async (projectUid) => {
    if (get().activeProjectUid === projectUid) return

    try {
      const storage = getStorage()
      const stored = await storage.datasetFiles.getByProject(projectUid)

      _loadedData.clear()
      _dataSaveTimers.forEach((t) => clearTimeout(t))
      _dataSaveTimers.clear()
      _savedDataSnapshot.clear()
      _analysisSaveTimers.forEach((t) => clearTimeout(t))
      _analysisSaveTimers.clear()
      _savedAnalysisSnapshot.clear()

      if (stored.length > 0) {
        initFileCounter(stored)
        const rootFolders = stored
          .filter((f) => f.type === 'folder' && f.parentId === null)
          .map((f) => f.id)
        set({
          files: stored,
          activeProjectUid: projectUid,
          selectedFileId: null,
          openFileIds: [],
          expandedFolders: rootFolders,
          analyses: [],
          openAnalysisIds: [],
          selectedAnalysisId: null,
          _dirtyVersion: 0,
        })
      } else {
        set({
          files: [],
          activeProjectUid: projectUid,
          selectedFileId: null,
          openFileIds: [],
          expandedFolders: [],
          analyses: [],
          openAnalysisIds: [],
          selectedAnalysisId: null,
          _dirtyVersion: 0,
        })
      }
    } catch {
      set({
        files: [],
        activeProjectUid: projectUid,
        selectedFileId: null,
        openFileIds: [],
        expandedFolders: [],
        analyses: [],
        openAnalysisIds: [],
        selectedAnalysisId: null,
      })
    }
  },

  createFile: (name, parentId) => {
    const projectUid = get().activeProjectUid ?? ''
    const id = `file-${fileCounter++}`
    const node: DatasetFile = {
      id,
      projectUid,
      name,
      type: 'file',
      parentId,
      columns: [],
      rowCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    _loadedData.set(id, [])
    _savedDataSnapshot.set(id, '[]')
    set((s) => ({
      files: [...s.files, node],
      selectedFileId: id,
    }))
    getStorage().datasetFiles.create(node).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'datasets.new_file',
      descriptionParams: { name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.filter((f) => f.id !== id),
          selectedFileId: s.selectedFileId === id ? null : s.selectedFileId,
        }))
        _loadedData.delete(id)
        _savedDataSnapshot.delete(id)
        getStorage().datasetFiles.delete(id).catch(() => {})
        getStorage().datasetData.delete(id).catch(() => {})
      },
    })
  },

  createFolder: (name, parentId) => {
    const projectUid = get().activeProjectUid ?? ''
    const id = `folder-${fileCounter++}`
    const node: DatasetFile = {
      id,
      projectUid,
      name,
      type: 'folder',
      parentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    set((s) => ({
      files: [...s.files, node],
      expandedFolders: [...s.expandedFolders, id],
    }))
    getStorage().datasetFiles.create(node).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'datasets.new_folder',
      descriptionParams: { name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.filter((f) => f.id !== id),
          expandedFolders: s.expandedFolders.filter((fid) => fid !== id),
        }))
        getStorage().datasetFiles.delete(id).catch(() => {})
      },
    })
  },

  deleteNode: (id) => {
    const state = get()
    const node = state.files.find((f) => f.id === id)
    if (!node) return
    const idsToRemove = [id]
    if (node.type === 'folder') {
      idsToRemove.push(...getAllDescendants(state.files, id))
    }
    const removedFiles = state.files.filter((f) => idsToRemove.includes(f.id))
    const removedData = new Map<string, Record<string, unknown>[]>()
    const removedAnalyses: DatasetAnalysis[] = []
    for (const rid of idsToRemove) {
      const rows = _loadedData.get(rid)
      if (rows) removedData.set(rid, [...rows])
      const fileAnalyses = state.analyses.filter((a) => a.datasetFileId === rid)
      removedAnalyses.push(...fileAnalyses)
    }
    const prevSelectedFileId = state.selectedFileId
    set((s) => {
      const remainingOpen = s.openFileIds.filter((fid) => !idsToRemove.includes(fid))
      const isSelectedRemoved = idsToRemove.includes(s.selectedFileId ?? '')
      let nextSelected = s.selectedFileId
      if (isSelectedRemoved) {
        const idx = s.openFileIds.indexOf(s.selectedFileId!)
        nextSelected = remainingOpen[Math.min(idx, remainingOpen.length - 1)] ?? null
      }
      return {
        files: s.files.filter((f) => !idsToRemove.includes(f.id)),
        selectedFileId: nextSelected,
        openFileIds: remainingOpen,
        expandedFolders: s.expandedFolders.filter((fid) => !idsToRemove.includes(fid)),
        analyses: s.analyses.filter((a) => !idsToRemove.includes(a.datasetFileId)),
        openAnalysisIds: s.openAnalysisIds.filter((aid) => {
          const analysis = s.analyses.find((a) => a.id === aid)
          return analysis && !idsToRemove.includes(analysis.datasetFileId)
        }),
        selectedAnalysisId: s.selectedAnalysisId && s.analyses.find((a) => a.id === s.selectedAnalysisId && idsToRemove.includes(a.datasetFileId))
          ? null
          : s.selectedAnalysisId,
      }
    })
    for (const rid of idsToRemove) {
      _loadedData.delete(rid)
      _savedDataSnapshot.delete(rid)
      const timer = _dataSaveTimers.get(rid)
      if (timer) { clearTimeout(timer); _dataSaveTimers.delete(rid) }
    }
    for (const analysis of removedAnalyses) {
      _savedAnalysisSnapshot.delete(analysis.id)
      const timer = _analysisSaveTimers.get(analysis.id)
      if (timer) { clearTimeout(timer); _analysisSaveTimers.delete(analysis.id) }
    }
    const storage = getStorage()
    for (const rid of idsToRemove) {
      storage.datasetFiles.delete(rid).catch(() => {})
      storage.datasetData.delete(rid).catch(() => {})
      storage.datasetRawFiles.delete(rid).catch(() => {})
    }
    for (const analysis of removedAnalyses) {
      storage.datasetAnalyses.delete(analysis.id).catch(() => {})
    }

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'datasets.delete',
      descriptionParams: { name: node.name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: [...s.files, ...removedFiles],
          selectedFileId: prevSelectedFileId,
          analyses: [...s.analyses, ...removedAnalyses],
        }))
        for (const f of removedFiles) {
          storage.datasetFiles.create(f).catch(() => {})
        }
        for (const [rid, rows] of removedData) {
          _loadedData.set(rid, rows)
          storage.datasetData.save({ datasetFileId: rid, rows }).catch(() => {})
        }
        for (const analysis of removedAnalyses) {
          storage.datasetAnalyses.create(analysis).catch(() => {})
        }
      },
    })
  },

  renameNode: (id, newName) => {
    const state = get()
    const node = state.files.find((f) => f.id === id)
    if (!node) return
    const oldName = node.name
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, name: newName, updatedAt: new Date().toISOString() } : f)),
    }))
    getStorage().datasetFiles.update(id, { name: newName, updatedAt: new Date().toISOString() }).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'datasets.rename',
      descriptionParams: { name: oldName },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.map((f) =>
            f.id === id ? { ...f, name: oldName, updatedAt: new Date().toISOString() } : f
          ),
        }))
        getStorage().datasetFiles.update(id, { name: oldName, updatedAt: new Date().toISOString() }).catch(() => {})
      },
    })
  },

  moveNode: (id, newParentId) => {
    const state = get()
    const node = state.files.find((f) => f.id === id)
    if (!node) return
    const oldParentId = node.parentId
    if (oldParentId === newParentId) return
    set((s) => ({
      files: s.files.map((f) =>
        f.id === id ? { ...f, parentId: newParentId, updatedAt: new Date().toISOString() } : f
      ),
    }))
    getStorage().datasetFiles.update(id, { parentId: newParentId, updatedAt: new Date().toISOString() }).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'datasets.move',
      descriptionParams: { name: node.name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.map((f) =>
            f.id === id ? { ...f, parentId: oldParentId, updatedAt: new Date().toISOString() } : f
          ),
        }))
        getStorage().datasetFiles.update(id, { parentId: oldParentId, updatedAt: new Date().toISOString() }).catch(() => {})
      },
    })
  },

  duplicateFile: (id) => {
    const state = get()
    const original = state.files.find((f) => f.id === id)
    if (!original || original.type !== 'file') return
    const newId = `file-${fileCounter++}`
    const nameParts = original.name.split('.')
    const ext = nameParts.length > 1 ? `.${nameParts.pop()}` : ''
    const baseName = nameParts.join('.')
    const siblings = state.files.filter((f) => f.parentId === original.parentId)
    const siblingNames = new Set(siblings.map((f) => f.name))
    let newName = `${baseName} (copy)${ext}`
    let counter = 2
    while (siblingNames.has(newName)) {
      newName = `${baseName} (copy ${counter})${ext}`
      counter++
    }
    const node: DatasetFile = {
      ...original,
      id: newId,
      name: newName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    // Copy loaded data if available
    const originalRows = _loadedData.get(id)
    if (originalRows) {
      const copiedRows = originalRows.map((r) => ({ ...r }))
      _loadedData.set(newId, copiedRows)
      _savedDataSnapshot.set(newId, JSON.stringify(copiedRows))
    }
    set((s) => ({ files: [...s.files, node] }))
    const storage = getStorage()
    storage.datasetFiles.create(node).catch(() => {})
    // Also copy the data rows in IndexedDB
    if (originalRows) {
      storage.datasetData.save(newId, originalRows).catch(() => {})
    }

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'datasets.duplicate',
      descriptionParams: { name: newName },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.filter((f) => f.id !== newId),
        }))
        _loadedData.delete(newId)
        _savedDataSnapshot.delete(newId)
        storage.datasetFiles.delete(newId).catch(() => {})
        storage.datasetData.delete(newId).catch(() => {})
      },
    })
  },

  selectFile: (id) => {
    if (id === null) {
      set({ selectedFileId: null })
      return
    }
    set((s) => ({
      selectedFileId: id,
      openFileIds: s.openFileIds.includes(id) ? s.openFileIds : [...s.openFileIds, id],
    }))
  },

  openFile: (id) =>
    set((s) => ({
      selectedFileId: id,
      openFileIds: s.openFileIds.includes(id) ? s.openFileIds : [...s.openFileIds, id],
    })),

  closeFile: (id) =>
    set((s) => {
      const remaining = s.openFileIds.filter((fid) => fid !== id)
      let nextSelected = s.selectedFileId
      if (s.selectedFileId === id) {
        const idx = s.openFileIds.indexOf(id)
        nextSelected = remaining[Math.min(idx, remaining.length - 1)] ?? null
      }
      return { openFileIds: remaining, selectedFileId: nextSelected }
    }),

  reorderOpenFiles: (fromIndex, toIndex) =>
    set((s) => {
      const ids = [...s.openFileIds]
      const [moved] = ids.splice(fromIndex, 1)
      ids.splice(toIndex, 0, moved)
      return { openFileIds: ids }
    }),

  toggleFolder: (id) =>
    set((s) => ({
      expandedFolders: s.expandedFolders.includes(id)
        ? s.expandedFolders.filter((fid) => fid !== id)
        : [...s.expandedFolders, id],
    })),

  loadFileData: async (fileId) => {
    // Skip IDB load if data is already in memory (e.g. just imported)
    if (_loadedData.has(fileId)) return
    try {
      const storage = getStorage()
      const data = await storage.datasetData.get(fileId)
      if (data) {
        _loadedData.set(fileId, data.rows)
        _savedDataSnapshot.set(fileId, JSON.stringify(data.rows))
      } else {
        _loadedData.set(fileId, [])
        _savedDataSnapshot.set(fileId, '[]')
      }
    } catch {
      _loadedData.set(fileId, [])
      _savedDataSnapshot.set(fileId, '[]')
    }
  },

  getFileRows: (fileId) => {
    return _loadedData.get(fileId) ?? []
  },

  updateCell: (fileId, rowIndex, columnId, value) => {
    const rows = _loadedData.get(fileId)
    if (!rows || rowIndex < 0 || rowIndex >= rows.length) return
    rows[rowIndex][columnId] = value
    set((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
    const existingTimer = _dataSaveTimers.get(fileId)
    if (existingTimer) clearTimeout(existingTimer)
    _dataSaveTimers.set(fileId, setTimeout(() => {
      _dataSaveTimers.delete(fileId)
      getStorage().datasetData.save({ datasetFileId: fileId, rows }).then(() => {
        _savedDataSnapshot.set(fileId, JSON.stringify(rows))
        useDatasetStore.setState((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
      }).catch(() => {})
    }, 500))
  },

  addRow: (fileId) => {
    const file = get().files.find((f) => f.id === fileId)
    if (!file || file.type !== 'file') return
    const rows = _loadedData.get(fileId) ?? []
    const newRow: Record<string, unknown> = {}
    for (const col of file.columns ?? []) {
      newRow[col.id] = null
    }
    rows.push(newRow)
    set((s) => ({
      files: s.files.map((f) => f.id === fileId ? { ...f, rowCount: rows.length, updatedAt: new Date().toISOString() } : f),
      _dirtyVersion: s._dirtyVersion + 1,
    }))
    const existingTimer = _dataSaveTimers.get(fileId)
    if (existingTimer) clearTimeout(existingTimer)
    _dataSaveTimers.set(fileId, setTimeout(() => {
      _dataSaveTimers.delete(fileId)
      getStorage().datasetData.save({ datasetFileId: fileId, rows }).then(() => {
        _savedDataSnapshot.set(fileId, JSON.stringify(rows))
        useDatasetStore.setState((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
      }).catch(() => {})
      getStorage().datasetFiles.update(fileId, { rowCount: rows.length, updatedAt: new Date().toISOString() }).catch(() => {})
    }, 500))
  },

  removeRow: (fileId, rowIndex) => {
    const rows = _loadedData.get(fileId)
    if (!rows || rowIndex < 0 || rowIndex >= rows.length) return
    rows.splice(rowIndex, 1)
    set((s) => ({
      files: s.files.map((f) => f.id === fileId ? { ...f, rowCount: rows.length, updatedAt: new Date().toISOString() } : f),
      _dirtyVersion: s._dirtyVersion + 1,
    }))
    const existingTimer = _dataSaveTimers.get(fileId)
    if (existingTimer) clearTimeout(existingTimer)
    _dataSaveTimers.set(fileId, setTimeout(() => {
      _dataSaveTimers.delete(fileId)
      getStorage().datasetData.save({ datasetFileId: fileId, rows }).then(() => {
        _savedDataSnapshot.set(fileId, JSON.stringify(rows))
        useDatasetStore.setState((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
      }).catch(() => {})
      getStorage().datasetFiles.update(fileId, { rowCount: rows.length, updatedAt: new Date().toISOString() }).catch(() => {})
    }, 500))
  },

  addColumn: (fileId, name, type) => {
    const file = get().files.find((f) => f.id === fileId)
    if (!file || file.type !== 'file') return
    const columns = file.columns ?? []
    const id = `col-${Date.now()}`
    const newColumn: DatasetColumn = { id, name, type, order: columns.length }
    const updatedColumns = [...columns, newColumn]
    const rows = _loadedData.get(fileId) ?? []
    for (const row of rows) {
      row[id] = null
    }
    set((s) => ({
      files: s.files.map((f) => f.id === fileId ? { ...f, columns: updatedColumns, updatedAt: new Date().toISOString() } : f),
      _dirtyVersion: s._dirtyVersion + 1,
    }))
    getStorage().datasetFiles.update(fileId, { columns: updatedColumns, updatedAt: new Date().toISOString() }).catch(() => {})
    getStorage().datasetData.save({ datasetFileId: fileId, rows }).catch(() => {})
  },

  removeColumn: (fileId, columnId) => {
    const file = get().files.find((f) => f.id === fileId)
    if (!file || file.type !== 'file') return
    const columns = file.columns ?? []
    const updatedColumns = columns.filter((c) => c.id !== columnId).map((c, i) => ({ ...c, order: i }))
    const rows = _loadedData.get(fileId) ?? []
    for (const row of rows) {
      delete row[columnId]
    }
    set((s) => ({
      files: s.files.map((f) => f.id === fileId ? { ...f, columns: updatedColumns, updatedAt: new Date().toISOString() } : f),
      _dirtyVersion: s._dirtyVersion + 1,
    }))
    getStorage().datasetFiles.update(fileId, { columns: updatedColumns, updatedAt: new Date().toISOString() }).catch(() => {})
    getStorage().datasetData.save({ datasetFileId: fileId, rows }).catch(() => {})
  },

  renameColumn: (fileId, columnId, newName) => {
    const file = get().files.find((f) => f.id === fileId)
    if (!file || file.type !== 'file') return
    const columns = file.columns ?? []
    const updatedColumns = columns.map((c) => c.id === columnId ? { ...c, name: newName } : c)
    set((s) => ({
      files: s.files.map((f) => f.id === fileId ? { ...f, columns: updatedColumns, updatedAt: new Date().toISOString() } : f),
    }))
    getStorage().datasetFiles.update(fileId, { columns: updatedColumns, updatedAt: new Date().toISOString() }).catch(() => {})
  },

  reorderColumns: (fileId, fromIndex, toIndex) => {
    const file = get().files.find((f) => f.id === fileId)
    if (!file || file.type !== 'file') return
    const columns = [...(file.columns ?? [])]
    const [moved] = columns.splice(fromIndex, 1)
    columns.splice(toIndex, 0, moved)
    const updatedColumns = columns.map((c, i) => ({ ...c, order: i }))
    set((s) => ({
      files: s.files.map((f) => f.id === fileId ? { ...f, columns: updatedColumns, updatedAt: new Date().toISOString() } : f),
    }))
    getStorage().datasetFiles.update(fileId, { columns: updatedColumns, updatedAt: new Date().toISOString() }).catch(() => {})
  },

  importData: (fileId, columns, rows) => {
    const storage = getStorage()
    _loadedData.set(fileId, rows)
    const snapshot = JSON.stringify(rows)
    _savedDataSnapshot.set(fileId, snapshot)
    set((s) => ({
      files: s.files.map((f) => f.id === fileId ? { ...f, columns, rowCount: rows.length, updatedAt: new Date().toISOString() } : f),
      _dirtyVersion: s._dirtyVersion + 1,
    }))
    storage.datasetFiles.update(fileId, { columns, rowCount: rows.length, updatedAt: new Date().toISOString() }).catch(() => {})
    storage.datasetData.save({ datasetFileId: fileId, rows }).catch(() => {})
  },

  createFileWithData: async (name, parentId, columns, rows, parseOptions, rawFile) => {
    const projectUid = get().activeProjectUid ?? ''
    const id = `file-${fileCounter++}`
    const now = new Date().toISOString()
    const node: DatasetFile = {
      id,
      projectUid,
      name,
      type: 'file',
      parentId,
      columns,
      rowCount: rows.length,
      parseOptions,
      createdAt: now,
      updatedAt: now,
    }

    // Update Zustand state synchronously
    _loadedData.set(id, rows)
    _savedDataSnapshot.set(id, JSON.stringify(rows))
    set((s) => ({
      files: [...s.files, node],
      selectedFileId: id,
      openFileIds: s.openFileIds.includes(id) ? s.openFileIds : [...s.openFileIds, id],
      _dirtyVersion: s._dirtyVersion + 1,
    }))

    // Persist to IDB sequentially — no race conditions
    const storage = getStorage()
    await storage.datasetFiles.create(node)
    await storage.datasetData.save({ datasetFileId: id, rows })
    if (rawFile) {
      await storage.datasetRawFiles.save({ datasetFileId: id, ...rawFile })
    }

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'datasets.new_file',
      descriptionParams: { name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.filter((f) => f.id !== id),
          selectedFileId: s.selectedFileId === id ? null : s.selectedFileId,
          openFileIds: s.openFileIds.filter((fid) => fid !== id),
        }))
        _loadedData.delete(id)
        _savedDataSnapshot.delete(id)
        storage.datasetFiles.delete(id).catch(() => {})
        storage.datasetData.delete(id).catch(() => {})
        storage.datasetRawFiles.delete(id).catch(() => {})
      },
    })

    return id
  },

  reimportData: async (fileId, columns, rows, parseOptions) => {
    const storage = getStorage()
    _loadedData.set(fileId, rows)
    const snapshot = JSON.stringify(rows)
    _savedDataSnapshot.set(fileId, snapshot)
    set((s) => ({
      files: s.files.map((f) => f.id === fileId ? { ...f, columns, rowCount: rows.length, parseOptions, updatedAt: new Date().toISOString() } : f),
      _dirtyVersion: s._dirtyVersion + 1,
    }))
    await storage.datasetFiles.update(fileId, { columns, rowCount: rows.length, parseOptions, updatedAt: new Date().toISOString() })
    await storage.datasetData.save({ datasetFileId: fileId, rows })
  },

  saveFile: async (id) => {
    const file = get().files.find((f) => f.id === id)
    if (!file || file.type !== 'file') return
    const rows = _loadedData.get(id) ?? []
    const timer = _dataSaveTimers.get(id)
    if (timer) { clearTimeout(timer); _dataSaveTimers.delete(id) }
    await getStorage().datasetData.save({ datasetFileId: id, rows })
    await getStorage().datasetFiles.update(id, { updatedAt: new Date().toISOString() })
    _savedDataSnapshot.set(id, JSON.stringify(rows))
    set((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
  },

  revertFile: (id) => {
    const saved = _savedDataSnapshot.get(id)
    if (saved === undefined) return
    const timer = _dataSaveTimers.get(id)
    if (timer) { clearTimeout(timer); _dataSaveTimers.delete(id) }
    const rows = JSON.parse(saved) as Record<string, unknown>[]
    _loadedData.set(id, rows)
    set((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
  },

  loadAnalyses: async (datasetFileId) => {
    try {
      const storage = getStorage()
      const analyses = await storage.datasetAnalyses.getByDataset(datasetFileId)
      // Ensure fileCounter accounts for existing analysis IDs
      for (const a of analyses) {
        const match = a.id.match(/^analysis-(\d+)$/)
        if (match) {
          const n = parseInt(match[1], 10)
          if (n >= fileCounter) fileCounter = n + 1
        }
      }
      set({ analyses })
      for (const analysis of analyses) {
        _savedAnalysisSnapshot.set(analysis.id, JSON.stringify(analysis.config))
      }
    } catch {
      set({ analyses: [] })
    }
  },

  createAnalysis: (datasetFileId, name, type, initialConfig) => {
    const id = `analysis-${fileCounter++}`
    const analysis: DatasetAnalysis = {
      id,
      datasetFileId,
      name,
      type,
      config: initialConfig ?? {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    _savedAnalysisSnapshot.set(id, JSON.stringify(analysis.config))
    set((s) => ({
      analyses: [...s.analyses, analysis],
      selectedAnalysisId: id,
      openAnalysisIds: s.openAnalysisIds.includes(id) ? s.openAnalysisIds : [...s.openAnalysisIds, id],
    }))
    getStorage().datasetAnalyses.create(analysis).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'datasets.new_analysis',
      descriptionParams: { name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          analyses: s.analyses.filter((a) => a.id !== id),
          selectedAnalysisId: s.selectedAnalysisId === id ? null : s.selectedAnalysisId,
          openAnalysisIds: s.openAnalysisIds.filter((aid) => aid !== id),
        }))
        _savedAnalysisSnapshot.delete(id)
        getStorage().datasetAnalyses.delete(id).catch(() => {})
      },
    })
  },

  updateAnalysis: (id, changes) => {
    set((s) => ({
      analyses: s.analyses.map((a) => a.id === id ? { ...a, ...changes, updatedAt: new Date().toISOString() } : a),
      _dirtyVersion: s._dirtyVersion + 1,
    }))
    const existingTimer = _analysisSaveTimers.get(id)
    if (existingTimer) clearTimeout(existingTimer)
    _analysisSaveTimers.set(id, setTimeout(() => {
      _analysisSaveTimers.delete(id)
      const analysis = useDatasetStore.getState().analyses.find((a) => a.id === id)
      if (analysis) {
        getStorage().datasetAnalyses.update(id, { ...changes, updatedAt: new Date().toISOString() }).then(() => {
          _savedAnalysisSnapshot.set(id, JSON.stringify(analysis.config))
          useDatasetStore.setState((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
        }).catch(() => {})
      }
    }, 500))
  },

  deleteAnalysis: (id) => {
    const state = get()
    const analysis = state.analyses.find((a) => a.id === id)
    if (!analysis) return
    set((s) => ({
      analyses: s.analyses.filter((a) => a.id !== id),
      selectedAnalysisId: s.selectedAnalysisId === id ? null : s.selectedAnalysisId,
      openAnalysisIds: s.openAnalysisIds.filter((aid) => aid !== id),
    }))
    _savedAnalysisSnapshot.delete(id)
    const timer = _analysisSaveTimers.get(id)
    if (timer) { clearTimeout(timer); _analysisSaveTimers.delete(id) }
    getStorage().datasetAnalyses.delete(id).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'datasets.delete_analysis',
      descriptionParams: { name: analysis.name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          analyses: [...s.analyses, analysis],
        }))
        getStorage().datasetAnalyses.create(analysis).catch(() => {})
      },
    })
  },

  renameAnalysis: (id, newName) => {
    const state = get()
    const analysis = state.analyses.find((a) => a.id === id)
    if (!analysis) return
    const oldName = analysis.name
    set((s) => ({
      analyses: s.analyses.map((a) => a.id === id ? { ...a, name: newName, updatedAt: new Date().toISOString() } : a),
    }))
    getStorage().datasetAnalyses.update(id, { name: newName, updatedAt: new Date().toISOString() }).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'datasets.rename_analysis',
      descriptionParams: { name: oldName },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          analyses: s.analyses.map((a) =>
            a.id === id ? { ...a, name: oldName, updatedAt: new Date().toISOString() } : a
          ),
        }))
        getStorage().datasetAnalyses.update(id, { name: oldName, updatedAt: new Date().toISOString() }).catch(() => {})
      },
    })
  },

  selectAnalysis: (id) => {
    if (id === null) {
      set({ selectedAnalysisId: null })
      return
    }
    set((s) => ({
      selectedAnalysisId: id,
      openAnalysisIds: s.openAnalysisIds.includes(id) ? s.openAnalysisIds : [...s.openAnalysisIds, id],
    }))
  },

  openAnalysis: (id) =>
    set((s) => ({
      selectedAnalysisId: id,
      openAnalysisIds: s.openAnalysisIds.includes(id) ? s.openAnalysisIds : [...s.openAnalysisIds, id],
    })),

  closeAnalysis: (id) =>
    set((s) => {
      const remaining = s.openAnalysisIds.filter((aid) => aid !== id)
      let nextSelected = s.selectedAnalysisId
      if (s.selectedAnalysisId === id) {
        const idx = s.openAnalysisIds.indexOf(id)
        nextSelected = remaining[Math.min(idx, remaining.length - 1)] ?? null
      }
      return { openAnalysisIds: remaining, selectedAnalysisId: nextSelected }
    }),

  saveAnalysis: async (id) => {
    const analysis = get().analyses.find((a) => a.id === id)
    if (!analysis) return
    const timer = _analysisSaveTimers.get(id)
    if (timer) { clearTimeout(timer); _analysisSaveTimers.delete(id) }
    await getStorage().datasetAnalyses.update(id, { config: analysis.config, updatedAt: new Date().toISOString() })
    _savedAnalysisSnapshot.set(id, JSON.stringify(analysis.config))
    set((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
  },

  undoStack: [],
  pushUndo: (action) =>
    set((s) => ({
      undoStack: [...s.undoStack.slice(-MAX_UNDO + 1), action],
    })),
  performUndo: () => {
    const state = get()
    const last = state.undoStack[state.undoStack.length - 1]
    if (!last) return
    set((s) => ({
      undoStack: s.undoStack.slice(0, -1),
    }))
    last.undo()
  },
  peekUndo: () => {
    const state = get()
    return state.undoStack[state.undoStack.length - 1]
  },
}))
