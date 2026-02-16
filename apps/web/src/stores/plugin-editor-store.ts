import { create } from 'zustand'
import type { AnalysisPluginManifest } from '@/types/analysis-plugin'
import type { UserPlugin } from '@/types'
import { getStorage } from '@/lib/storage'
import {
  getAllAnalysisPlugins,
  registerAnalysisPlugin,
  unregisterAnalysisPlugin,
} from '@/lib/analysis-plugins/registry'
import { buildPlugin } from '@/lib/analysis-plugins/default-plugins'

export interface PluginListItem {
  id: string
  manifest: AnalysisPluginManifest
  isBuiltIn: boolean
}

const SCAFFOLD_MANIFEST = {
  id: '',
  name: { en: 'New Plugin', fr: 'Nouveau plugin' },
  description: { en: '', fr: '' },
  version: '1.0.0',
  category: 'analysis',
  tags: [],
  runtime: ['script'] as const,
  languages: ['python'] as ('python' | 'r')[],
  icon: 'Puzzle',
  configSchema: {},
  dependencies: { python: [], r: [] },
  templates: { python: 'analysis.py.template' },
}

const SCAFFOLD_TEMPLATE = `import pandas as pd

# 'dataset' is a pandas DataFrame injected automatically.

# Your analysis code here
print(dataset.describe())
`

interface PluginEditorState {
  // List
  pluginList: PluginListItem[]
  refreshPluginList: () => Promise<void>

  // Editor
  editingPluginId: string | null
  isBuiltIn: boolean
  files: Record<string, string>
  openFiles: string[]
  activeFile: string | null
  isDirty: boolean
  originalFiles: Record<string, string>

  // Plugin actions
  openPlugin: (id: string) => Promise<void>
  closeEditor: () => void
  createPlugin: (name?: string) => Promise<string>
  duplicatePlugin: (sourceId: string) => Promise<string>
  deletePlugin: (id: string) => Promise<void>
  savePlugin: () => Promise<void>

  // File actions
  openFile: (filename: string) => void
  closeFile: (filename: string) => void
  updateFileContent: (filename: string, content: string) => void
  createFile: (filename: string) => void
  deleteFile: (filename: string) => void
  renameFile: (oldName: string, newName: string) => void
  reorderOpenFiles: (fromIndex: number, toIndex: number) => void

  // Test state
  testLanguage: 'python' | 'r'
  testProjectUid: string | null
  testDatasetFileId: string | null
  testConfig: Record<string, unknown>
  setTestLanguage: (lang: 'python' | 'r') => void
  setTestProject: (uid: string | null) => void
  setTestDataset: (id: string | null) => void
  setTestConfig: (config: Record<string, unknown>) => void
}

/** Set of built-in plugin IDs (populated on first list refresh). */
const builtInIds = new Set<string>()

export const usePluginEditorStore = create<PluginEditorState>((set, get) => ({
  // List
  pluginList: [],

  async refreshPluginList() {
    // Built-in plugins from registry
    const registryPlugins = getAllAnalysisPlugins()
    if (builtInIds.size === 0) {
      for (const p of registryPlugins) {
        builtInIds.add(p.manifest.id)
      }
    }

    // User plugins from IDB
    const storage = getStorage()
    const userPlugins = await storage.userPlugins.getAll()
    const userIds = new Set(userPlugins.map(up => {
      try {
        const m = JSON.parse(up.files['plugin.json'] ?? '{}')
        return m.id as string
      } catch { return up.id }
    }))

    const list: PluginListItem[] = []
    for (const p of registryPlugins) {
      list.push({
        id: p.manifest.id,
        manifest: p.manifest,
        isBuiltIn: builtInIds.has(p.manifest.id) && !userIds.has(p.manifest.id),
      })
    }
    // Add user plugins not yet in registry
    for (const up of userPlugins) {
      try {
        const manifest = JSON.parse(up.files['plugin.json'] ?? '{}') as AnalysisPluginManifest
        if (!list.some(p => p.id === manifest.id)) {
          list.push({ id: manifest.id ?? up.id, manifest, isBuiltIn: false })
        }
      } catch { /* skip invalid */ }
    }
    set({ pluginList: list })
  },

  // Editor
  editingPluginId: null,
  isBuiltIn: false,
  files: {},
  openFiles: [],
  activeFile: null,
  isDirty: false,
  originalFiles: {},

  async openPlugin(id: string) {
    const storage = getStorage()
    // Try user plugin first
    const userPlugin = await storage.userPlugins.getById(id)
    if (userPlugin) {
      const files = { ...userPlugin.files }
      const firstFile = 'plugin.json'
      set({
        editingPluginId: id,
        isBuiltIn: false,
        files,
        originalFiles: { ...files },
        openFiles: [firstFile],
        activeFile: firstFile,
        isDirty: false,
      })
      return
    }
    // Built-in plugin: reconstruct files from registry
    const plugin = getAllAnalysisPlugins().find(p => p.manifest.id === id)
    if (!plugin) return
    const files: Record<string, string> = {
      'plugin.json': JSON.stringify(plugin.manifest, null, 2),
    }
    if (plugin.templates) {
      for (const [lang, content] of Object.entries(plugin.templates)) {
        const ext = lang === 'r' ? '.R.template' : '.py.template'
        const name = (plugin.manifest.id.replace('linkr-analysis-', '') || 'analysis') + ext
        files[name] = content
      }
    }
    set({
      editingPluginId: id,
      isBuiltIn: true,
      files,
      originalFiles: { ...files },
      openFiles: ['plugin.json'],
      activeFile: 'plugin.json',
      isDirty: false,
    })
  },

  closeEditor() {
    set({
      editingPluginId: null,
      isBuiltIn: false,
      files: {},
      originalFiles: {},
      openFiles: [],
      activeFile: null,
      isDirty: false,
    })
  },

  async createPlugin(name?: string) {
    const id = `user-plugin-${Date.now()}`
    const pluginName = name?.trim() || 'New Plugin'
    const manifest = { ...SCAFFOLD_MANIFEST, id, name: { en: pluginName, fr: pluginName } }
    const files: Record<string, string> = {
      'plugin.json': JSON.stringify(manifest, null, 2),
      'analysis.py.template': SCAFFOLD_TEMPLATE,
    }
    const now = new Date().toISOString()
    const userPlugin: UserPlugin = { id, files, createdAt: now, updatedAt: now }
    const storage = getStorage()
    await storage.userPlugins.create(userPlugin)
    // Register in runtime
    registerAnalysisPlugin(buildPlugin(manifest as unknown as Record<string, unknown>, { python: SCAFFOLD_TEMPLATE }, null))
    set({
      editingPluginId: id,
      isBuiltIn: false,
      files,
      originalFiles: { ...files },
      openFiles: ['plugin.json'],
      activeFile: 'plugin.json',
      isDirty: false,
    })
    await get().refreshPluginList()
    return id
  },

  async duplicatePlugin(sourceId: string) {
    const state = get()
    // Load source files
    let sourceFiles: Record<string, string>
    const storage = getStorage()
    const userPlugin = await storage.userPlugins.getById(sourceId)
    if (userPlugin) {
      sourceFiles = { ...userPlugin.files }
    } else {
      // Built-in: reconstruct from registry
      const plugin = getAllAnalysisPlugins().find(p => p.manifest.id === sourceId)
      if (!plugin) return sourceId
      sourceFiles = { 'plugin.json': JSON.stringify(plugin.manifest, null, 2) }
      if (plugin.templates) {
        for (const [lang, content] of Object.entries(plugin.templates)) {
          const ext = lang === 'r' ? '.R.template' : '.py.template'
          const name = (plugin.manifest.id.replace('linkr-analysis-', '') || 'analysis') + ext
          sourceFiles[name] = content
        }
      }
    }

    const newId = `user-plugin-${Date.now()}`
    // Update manifest ID in the copy
    try {
      const manifest = JSON.parse(sourceFiles['plugin.json'] ?? '{}')
      manifest.id = newId
      if (manifest.name?.en) manifest.name.en += ' (copy)'
      if (manifest.name?.fr) manifest.name.fr += ' (copie)'
      sourceFiles['plugin.json'] = JSON.stringify(manifest, null, 2)
    } catch { /* keep as-is */ }

    const now = new Date().toISOString()
    const newPlugin: UserPlugin = { id: newId, files: sourceFiles, createdAt: now, updatedAt: now }
    await storage.userPlugins.create(newPlugin)

    // Register
    try {
      const manifest = JSON.parse(sourceFiles['plugin.json']) as Record<string, unknown>
      const templates: Record<string, string> = {}
      for (const [filename, content] of Object.entries(sourceFiles)) {
        if (filename.endsWith('.py.template')) templates.python = content
        else if (filename.endsWith('.R.template')) templates.r = content
      }
      registerAnalysisPlugin(buildPlugin(manifest, Object.keys(templates).length > 0 ? templates : null, null))
    } catch { /* skip */ }

    await state.refreshPluginList()
    // Open the new plugin
    await get().openPlugin(newId)
    return newId
  },

  async deletePlugin(id: string) {
    const storage = getStorage()
    await storage.userPlugins.delete(id)
    unregisterAnalysisPlugin(id)
    if (get().editingPluginId === id) get().closeEditor()
    await get().refreshPluginList()
  },

  async savePlugin() {
    const { editingPluginId, files, isBuiltIn } = get()
    if (!editingPluginId || isBuiltIn) return

    const storage = getStorage()
    await storage.userPlugins.update(editingPluginId, {
      files: { ...files },
      updatedAt: new Date().toISOString(),
    })

    // Hot-register in plugin registry
    try {
      const manifest = JSON.parse(files['plugin.json'] ?? '{}') as Record<string, unknown>
      const templates: Record<string, string> = {}
      for (const [filename, content] of Object.entries(files)) {
        if (filename.endsWith('.py.template')) templates.python = content
        else if (filename.endsWith('.R.template')) templates.r = content
      }
      // Re-register (overwrites previous)
      registerAnalysisPlugin(buildPlugin(manifest, Object.keys(templates).length > 0 ? templates : null, null))
    } catch { /* invalid plugin.json — still saved to IDB */ }

    set({ isDirty: false, originalFiles: { ...files } })
    await get().refreshPluginList()
  },

  // File actions
  openFile(filename: string) {
    const { openFiles } = get()
    if (!openFiles.includes(filename)) {
      set({ openFiles: [...openFiles, filename], activeFile: filename })
    } else {
      set({ activeFile: filename })
    }
  },

  closeFile(filename: string) {
    const { openFiles, activeFile } = get()
    const next = openFiles.filter(f => f !== filename)
    const newActive = activeFile === filename
      ? next[Math.min(openFiles.indexOf(filename), next.length - 1)] ?? null
      : activeFile
    set({ openFiles: next, activeFile: newActive })
  },

  updateFileContent(filename: string, content: string) {
    const { files, originalFiles } = get()
    const newFiles = { ...files, [filename]: content }
    const dirty = JSON.stringify(newFiles) !== JSON.stringify(originalFiles)
    set({ files: newFiles, isDirty: dirty })
  },

  createFile(filename: string) {
    const { files } = get()
    if (files[filename] !== undefined) return
    const newFiles = { ...files, [filename]: '' }
    set({ files: newFiles, isDirty: true })
    get().openFile(filename)
  },

  deleteFile(filename: string) {
    const { files, openFiles, activeFile } = get()
    const { [filename]: _, ...rest } = files
    const nextOpen = openFiles.filter(f => f !== filename)
    const newActive = activeFile === filename
      ? nextOpen[0] ?? null
      : activeFile
    set({ files: rest, openFiles: nextOpen, activeFile: newActive, isDirty: true })
  },

  renameFile(oldName: string, newName: string) {
    const { files, openFiles, activeFile } = get()
    if (oldName === newName || files[newName] !== undefined) return
    const content = files[oldName]
    const { [oldName]: _, ...rest } = files
    const newFiles = { ...rest, [newName]: content }
    const newOpen = openFiles.map(f => f === oldName ? newName : f)
    const newActive = activeFile === oldName ? newName : activeFile
    set({ files: newFiles, openFiles: newOpen, activeFile: newActive, isDirty: true })
  },

  reorderOpenFiles(fromIndex: number, toIndex: number) {
    const { openFiles } = get()
    const next = [...openFiles]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    set({ openFiles: next })
  },

  // Test state
  testLanguage: 'python',
  testProjectUid: null,
  testDatasetFileId: null,
  testConfig: {},

  setTestLanguage(lang) { set({ testLanguage: lang }) },
  setTestProject(uid) { set({ testProjectUid: uid, testDatasetFileId: null }) },
  setTestDataset(id) { set({ testDatasetFileId: id }) },
  setTestConfig(config) { set({ testConfig: config }) },
}))
