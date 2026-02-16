import { create } from 'zustand'
import type { IdeFile } from '@/types'
import { getStorage } from '@/lib/storage'
import { useAppStore } from '@/stores/app-store'

export type FileNode = IdeFile

export interface OutputTab {
  id: string
  label: string
  type: 'figure' | 'table' | 'text' | 'html'
  content: unknown
}

export type ExecLanguage = 'python' | 'r' | 'sql'

export interface ExecutionResult {
  id: string
  fileName: string
  language: ExecLanguage
  timestamp: number
  duration: number
  success: boolean
  output: string
}

export interface UndoAction {
  id: string
  descriptionKey: string
  descriptionParams?: Record<string, string>
  timestamp: number
  undo: () => void
}

interface FileState {
  files: FileNode[]
  expandedFolders: string[]
  selectedFileId: string | null
  activeProjectUid: string | null
  openFileIds: string[]

  loadProjectFiles: (projectUid: string) => Promise<void>
  createFile: (name: string, parentId: string | null, language: string) => void
  createFolder: (name: string, parentId: string | null) => void
  deleteNode: (id: string) => void
  renameNode: (id: string, newName: string) => void
  moveNode: (id: string, newParentId: string | null) => void
  duplicateFile: (id: string) => void
  updateFileContent: (id: string, content: string) => void
  isFileDirty: (id: string) => boolean
  getDirtyFileIds: () => string[]
  saveFile: (id: string) => Promise<void>
  revertFile: (id: string) => void
  _dirtyVersion: number
  selectFile: (id: string | null) => void
  openFile: (id: string) => void
  closeFile: (id: string) => void
  reorderOpenFiles: (fromIndex: number, toIndex: number) => void
  toggleFolder: (id: string) => void

  outputTabs: OutputTab[]
  activeOutputTab: string | null
  outputTabOrder: string[] // unified order: exec tab IDs + output tab IDs
  addOutputTab: (tab: OutputTab) => void
  closeOutputTab: (id: string) => void
  reorderOutputTabs: (fromIndex: number, toIndex: number) => void
  reorderAllOutputTabs: (fromIndex: number, toIndex: number) => void
  setActiveOutputTab: (id: string) => void

  outputVisible: boolean
  setOutputVisible: (v: boolean) => void

  executionResults: ExecutionResult[]
  addExecutionResult: (result: ExecutionResult) => void
  updateExecutionResult: (id: string, updates: Partial<ExecutionResult>) => void
  clearExecutionResults: () => void
  clearExecutionResultsByLanguage: (lang: ExecLanguage) => void

  undoStack: UndoAction[]
  pushUndo: (action: UndoAction) => void
  performUndo: () => void
  peekUndo: () => UndoAction | undefined
}

let fileCounter = 10
let undoCounter = 0

function getLanguageForFile(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    py: 'python',
    r: 'r',
    R: 'r',
    sql: 'sql',
    sh: 'shell',
    json: 'json',
    md: 'markdown',
    rmd: 'markdown',
    qmd: 'markdown',
    ipynb: 'json',
    txt: 'plaintext',
  }
  return map[ext ?? ''] ?? 'plaintext'
}

const defaultFiles: FileNode[] = [
  {
    id: 'folder-1',
    projectUid: '',
    name: 'scripts',
    type: 'folder',
    parentId: null,
    createdAt: '2026-02-10',
  },
  {
    id: 'file-1',
    projectUid: '',
    name: 'analysis.py',
    type: 'file',
    parentId: 'folder-1',
    language: 'python',
    content: `import pandas as pd
import numpy as np

# Load OMOP data
df = pd.read_parquet("data/person.parquet")

# Basic statistics
print(f"Total patients: {len(df)}")
print(f"Mean age: {df['year_of_birth'].mean():.1f}")
print(df.describe())
`,
    createdAt: '2026-02-10',
  },
  {
    id: 'file-2',
    projectUid: '',
    name: 'queries.sql',
    type: 'file',
    parentId: 'folder-1',
    language: 'sql',
    content: `-- Count patients by gender
SELECT
  c.concept_name AS gender,
  COUNT(*) AS patient_count
FROM person p
JOIN concept c ON p.gender_concept_id = c.concept_id
GROUP BY c.concept_name
ORDER BY patient_count DESC;
`,
    createdAt: '2026-02-10',
  },
  {
    id: 'file-3',
    projectUid: '',
    name: 'plot_demographics.R',
    type: 'file',
    parentId: 'folder-1',
    language: 'r',
    content: `library(ggplot2)
library(dplyr)

# Load OMOP person data
person <- read_parquet("data/person.parquet")

# Age distribution by gender
person %>%
  mutate(age = 2026 - year_of_birth) %>%
  ggplot(aes(x = age, fill = gender)) +
  geom_histogram(binwidth = 5, alpha = 0.7, position = "dodge") +
  scale_fill_manual(values = c("M" = "#3b82f6", "F" = "#ec4899")) +
  labs(
    title = "Age Distribution by Gender",
    x = "Age (years)",
    y = "Count",
    fill = "Gender"
  ) +
  theme_minimal() +
  theme(
    plot.title = element_text(size = 14, face = "bold"),
    legend.position = "top"
  )
`,
    createdAt: '2026-02-10',
  },
  {
    id: 'file-4',
    projectUid: '',
    name: 'README.md',
    type: 'file',
    parentId: null,
    language: 'markdown',
    content: `# MIMIC-IV Demo Project

This project demonstrates linkr's capabilities with MIMIC-IV data.

## Files
- \`scripts/analysis.py\` — Python analysis script
- \`scripts/queries.sql\` — SQL queries for OMOP data
`,
    createdAt: '2026-02-10',
  },
]

export function buildFolderTree(
  files: FileNode[],
  parentId: string | null = null,
  depth = 0
): { id: string; name: string; depth: number }[] {
  const result: { id: string; name: string; depth: number }[] = []
  const folders = files
    .filter((f) => f.type === 'folder' && f.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const folder of folders) {
    result.push({ id: folder.id, name: folder.name, depth })
    result.push(...buildFolderTree(files, folder.id, depth + 1))
  }
  return result
}

function getAllDescendants(files: FileNode[], parentId: string): string[] {
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

/** Compute next fileCounter from existing file IDs. */
function initFileCounter(files: FileNode[]) {
  let max = 10
  for (const f of files) {
    const match = f.id.match(/^(?:file|folder)-(\d+)$/)
    if (match) {
      const n = parseInt(match[1], 10)
      if (n >= max) max = n + 1
    }
  }
  fileCounter = max
}

// Per-file debounce timers for content saves
const _contentSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Snapshot of last saved content (from IDB or explicit save)
const _savedContent = new Map<string, string>()

const MAX_UNDO = 50

export const useFileStore = create<FileState>((set, get) => ({
  files: defaultFiles,
  expandedFolders: ['folder-1'],
  selectedFileId: null,
  activeProjectUid: null,
  openFileIds: [],

  loadProjectFiles: async (projectUid) => {
    // Skip if already loaded for this project
    if (get().activeProjectUid === projectUid) return

    try {
      const storage = getStorage()
      const stored = await storage.ideFiles.getByProject(projectUid)

      // Clear saved content map for fresh project load
      _savedContent.clear()
      _contentSaveTimers.forEach((t) => clearTimeout(t))
      _contentSaveTimers.clear()

      if (stored.length > 0) {
        initFileCounter(stored)
        // Populate saved content snapshots
        for (const f of stored) {
          if (f.type === 'file' && f.content !== undefined) {
            _savedContent.set(f.id, f.content)
          }
        }
        // Auto-expand root-level folders
        const rootFolders = stored
          .filter((f) => f.type === 'folder' && f.parentId === null)
          .map((f) => f.id)
        set({
          files: stored,
          activeProjectUid: projectUid,
          selectedFileId: null,
          openFileIds: [],
          expandedFolders: rootFolders,
          _dirtyVersion: 0,
        })
      } else {
        // Seed with defaults, stamping projectUid
        const seeded = defaultFiles.map((f) => ({ ...f, projectUid }))
        initFileCounter(seeded)
        // Populate saved content snapshots
        for (const f of seeded) {
          if (f.type === 'file' && f.content !== undefined) {
            _savedContent.set(f.id, f.content)
          }
        }
        set({
          files: seeded,
          activeProjectUid: projectUid,
          selectedFileId: null,
          openFileIds: [],
          expandedFolders: ['folder-1'],
          _dirtyVersion: 0,
        })
        // Persist seeds
        for (const f of seeded) {
          await storage.ideFiles.create(f)
        }
      }
    } catch {
      // Storage not ready — use defaults
      const seeded = defaultFiles.map((f) => ({ ...f, projectUid }))
      set({
        files: seeded,
        activeProjectUid: projectUid,
        selectedFileId: null,
        openFileIds: [],
        expandedFolders: ['folder-1'],
      })
    }
  },

  createFile: (name, parentId, language) => {
    const projectUid = get().activeProjectUid ?? ''
    const id = `file-${fileCounter++}`
    const lang = language || getLanguageForFile(name)
    const node: FileNode = {
      id,
      projectUid,
      name,
      type: 'file',
      parentId,
      language: lang,
      content: '',
      createdAt: new Date().toISOString().split('T')[0],
    }
    _savedContent.set(id, '')
    set((s) => ({
      files: [...s.files, node],
      selectedFileId: id,
    }))
    // Persist
    getStorage().ideFiles.create(node).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'files.new_file',
      descriptionParams: { name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.filter((f) => f.id !== id),
          selectedFileId: s.selectedFileId === id ? null : s.selectedFileId,
        }))
        getStorage().ideFiles.delete(id).catch(() => {})
      },
    })
  },

  createFolder: (name, parentId) => {
    const projectUid = get().activeProjectUid ?? ''
    const id = `folder-${fileCounter++}`
    const node: FileNode = {
      id,
      projectUid,
      name,
      type: 'folder',
      parentId,
      createdAt: new Date().toISOString().split('T')[0],
    }
    set((s) => ({
      files: [...s.files, node],
      expandedFolders: [...s.expandedFolders, id],
    }))
    getStorage().ideFiles.create(node).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'files.new_folder',
      descriptionParams: { name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.filter((f) => f.id !== id),
          expandedFolders: s.expandedFolders.filter((fid) => fid !== id),
        }))
        getStorage().ideFiles.delete(id).catch(() => {})
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
        expandedFolders: s.expandedFolders.filter(
          (fid) => !idsToRemove.includes(fid)
        ),
      }
    })
    // Cleanup saved content and timers
    for (const rid of idsToRemove) {
      _savedContent.delete(rid)
      const timer = _contentSaveTimers.get(rid)
      if (timer) { clearTimeout(timer); _contentSaveTimers.delete(rid) }
    }
    // Persist deletions
    const storage = getStorage()
    for (const rid of idsToRemove) {
      storage.ideFiles.delete(rid).catch(() => {})
    }

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'files.delete',
      descriptionParams: { name: node.name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: [...s.files, ...removedFiles],
          selectedFileId: prevSelectedFileId,
        }))
        for (const f of removedFiles) {
          storage.ideFiles.create(f).catch(() => {})
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
      files: s.files.map((f) => (f.id === id ? { ...f, name: newName } : f)),
    }))
    getStorage().ideFiles.update(id, { name: newName }).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'files.rename',
      descriptionParams: { name: oldName },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.map((f) =>
            f.id === id ? { ...f, name: oldName } : f
          ),
        }))
        getStorage().ideFiles.update(id, { name: oldName }).catch(() => {})
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
        f.id === id ? { ...f, parentId: newParentId } : f
      ),
    }))
    getStorage().ideFiles.update(id, { parentId: newParentId }).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'files.move',
      descriptionParams: { name: node.name },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.map((f) =>
            f.id === id ? { ...f, parentId: oldParentId } : f
          ),
        }))
        getStorage().ideFiles.update(id, { parentId: oldParentId }).catch(() => {})
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
    const newName = `${baseName} (copy)${ext}`
    const node: FileNode = {
      ...original,
      id: newId,
      name: newName,
      createdAt: new Date().toISOString().split('T')[0],
    }
    set((s) => ({ files: [...s.files, node] }))
    getStorage().ideFiles.create(node).catch(() => {})

    get().pushUndo({
      id: `undo-${undoCounter++}`,
      descriptionKey: 'files.copy',
      descriptionParams: { name: newName },
      timestamp: Date.now(),
      undo: () => {
        set((s) => ({
          files: s.files.filter((f) => f.id !== newId),
        }))
        getStorage().ideFiles.delete(newId).catch(() => {})
      },
    })
  },

  updateFileContent: (id, content) => {
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, content } : f)),
      _dirtyVersion: s._dirtyVersion + 1,
    }))
    // Per-file debounce timer
    const existingTimer = _contentSaveTimers.get(id)
    if (existingTimer) clearTimeout(existingTimer)
    const { editorSettings } = useAppStore.getState()
    const delay = editorSettings.autoSave ? editorSettings.autoSaveDelay : 500
    _contentSaveTimers.set(id, setTimeout(() => {
      _contentSaveTimers.delete(id)
      getStorage().ideFiles.update(id, { content }).then(() => {
        if (editorSettings.autoSave) {
          _savedContent.set(id, content)
          useFileStore.setState((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
        }
      }).catch(() => {})
    }, delay))
  },

  isFileDirty: (id) => {
    const file = get().files.find((f) => f.id === id)
    if (!file || file.type !== 'file') return false
    const saved = _savedContent.get(id)
    return saved !== undefined && file.content !== saved
  },

  getDirtyFileIds: () => {
    return get().openFileIds.filter((id) => get().isFileDirty(id))
  },

  saveFile: async (id) => {
    const file = get().files.find((f) => f.id === id)
    if (!file || file.type !== 'file') return
    const content = file.content ?? ''
    // Cancel pending timer
    const timer = _contentSaveTimers.get(id)
    if (timer) { clearTimeout(timer); _contentSaveTimers.delete(id) }
    // Write to IDB
    await getStorage().ideFiles.update(id, { content })
    _savedContent.set(id, content)
    set((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
  },

  revertFile: (id) => {
    const saved = _savedContent.get(id)
    if (saved === undefined) return
    // Cancel pending timer
    const timer = _contentSaveTimers.get(id)
    if (timer) { clearTimeout(timer); _contentSaveTimers.delete(id) }
    // Revert in-memory content to saved
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, content: saved } : f)),
      _dirtyVersion: s._dirtyVersion + 1,
    }))
  },

  _dirtyVersion: 0,

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
        // Select the tab to the left, or the first remaining, or null
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

  outputTabs: [],
  activeOutputTab: null,
  outputTabOrder: [],

  addOutputTab: (tab) =>
    set((s) => ({
      outputTabs: [...s.outputTabs, tab],
      activeOutputTab: tab.id,
      outputTabOrder: [...s.outputTabOrder, tab.id],
    })),

  closeOutputTab: (id) =>
    set((s) => {
      const remaining = s.outputTabs.filter((t) => t.id !== id)
      return {
        outputTabs: remaining,
        activeOutputTab:
          s.activeOutputTab === id
            ? (remaining[remaining.length - 1]?.id ?? null)
            : s.activeOutputTab,
        outputTabOrder: s.outputTabOrder.filter((tid) => tid !== id),
      }
    }),

  reorderOutputTabs: (fromIndex, toIndex) =>
    set((s) => {
      const tabs = [...s.outputTabs]
      const [moved] = tabs.splice(fromIndex, 1)
      tabs.splice(toIndex, 0, moved)
      return { outputTabs: tabs }
    }),

  reorderAllOutputTabs: (fromIndex, toIndex) =>
    set((s) => {
      const order = [...s.outputTabOrder]
      const [moved] = order.splice(fromIndex, 1)
      order.splice(toIndex, 0, moved)
      return { outputTabOrder: order }
    }),

  setActiveOutputTab: (id) => set({ activeOutputTab: id }),

  outputVisible: false,
  setOutputVisible: (v) => set({ outputVisible: v }),

  executionResults: [],
  addExecutionResult: (result) =>
    set((s) => {
      const execTabId = `__exec_${result.language}__`
      return {
        executionResults: [...s.executionResults, result],
        activeOutputTab: execTabId,
        outputVisible: true,
        outputTabOrder: s.outputTabOrder.includes(execTabId)
          ? s.outputTabOrder
          : [...s.outputTabOrder, execTabId],
      }
    }),
  updateExecutionResult: (id, updates) =>
    set((s) => ({
      executionResults: s.executionResults.map((r) =>
        r.id === id ? { ...r, ...updates } : r
      ),
    })),
  clearExecutionResults: () => set({ executionResults: [] }),
  clearExecutionResultsByLanguage: (lang) =>
    set((s) => {
      const remaining = s.executionResults.filter((r) => r.language !== lang)
      const tabId = `__exec_${lang}__`
      // If active tab was this language's exec tab and no more results, switch away
      const activeTab = s.activeOutputTab === tabId && remaining.length > 0
        ? `__exec_${remaining[remaining.length - 1].language}__`
        : s.activeOutputTab === tabId
          ? (s.outputTabs[s.outputTabs.length - 1]?.id ?? null)
          : s.activeOutputTab
      return {
        executionResults: remaining,
        activeOutputTab: activeTab,
        outputTabOrder: s.outputTabOrder.filter((tid) => tid !== tabId),
      }
    }),

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
