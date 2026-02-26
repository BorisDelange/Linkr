import { create } from 'zustand'
import type { PluginManifest } from '@/types/plugin'
import type { UserPlugin } from '@/types'
import { getStorage } from '@/lib/storage'
import {
  getAllPlugins,
  registerPlugin,
  unregisterPlugin,
} from '@/lib/plugins/registry'
import { SYSTEM_PLUGIN_IDS } from '@/lib/plugins/builtin-widget-plugins'
import { buildPlugin } from '@/lib/plugins/default-plugins'
import { computePluginContentHash } from '@/lib/plugin-hash'
import { useWorkspaceStore } from './workspace-store'
import { useOrganizationStore } from './organization-store'

export interface PluginListItem {
  id: string
  manifest: PluginManifest
  isBuiltIn: boolean
  /** System plugins are built-in patient data widgets — metadata-only editing, no code. */
  isSystemPlugin: boolean
}

const SCAFFOLD_MANIFEST_LAB = {
  id: '',
  name: { en: 'New Plugin', fr: 'Nouveau plugin' },
  description: { en: '', fr: '' },
  version: '1.0.0',
  scope: 'lab' as const,
  category: 'analysis',
  tags: [],
  runtime: ['script'] as const,
  languages: ['python'] as ('python' | 'r')[],
  icon: 'Puzzle',
  configSchema: {},
  dependencies: { python: [], r: [] },
  templates: { python: 'analysis.py.template' },
}

const SCAFFOLD_TEMPLATE_LAB = `import pandas as pd

# 'dataset' is a pandas DataFrame injected automatically.

# Your analysis code here
print(dataset.describe())
`

const SCAFFOLD_MANIFEST_WAREHOUSE = {
  id: '',
  name: { en: 'New Plugin', fr: 'Nouveau plugin' },
  description: { en: '', fr: '' },
  version: '1.0.0',
  scope: 'warehouse' as const,
  category: 'patient-data',
  tags: [],
  runtime: ['script'] as const,
  languages: ['python'] as ('python' | 'r')[],
  icon: 'Puzzle',
  configSchema: {},
  dependencies: { python: [], r: [] },
  templates: { python: 'analysis.py.template' },
}

const SCAFFOLD_TEMPLATE_WAREHOUSE = `import pandas as pd

# Variables available: person_id, visit_occurrence_id, visit_detail_id
# Use sql_query() to query the DuckDB database

df = await sql_query(f"SELECT * FROM person WHERE person_id = {person_id}")
print(df)
`

interface PluginEditorState {
  // List
  pluginList: PluginListItem[]
  refreshPluginList: () => Promise<void>

  /** Active tab in the plugin list view (survives editor open/close). */
  activePluginTab: 'warehouse' | 'lab'
  setActivePluginTab: (tab: 'warehouse' | 'lab') => void

  // Editor
  editingPluginId: string | null
  isBuiltIn: boolean
  /** System plugins are built-in patient data widgets — metadata-only editing. */
  isSystemPlugin: boolean
  files: Record<string, string>
  openFiles: string[]
  activeFile: string | null
  isDirty: boolean
  originalFiles: Record<string, string>
  /** Set when save is rejected (e.g. invalid plugin.json). Cleared on next successful save. */
  saveError: string | null

  // Plugin actions
  openPlugin: (id: string) => Promise<void>
  closeEditor: () => void
  createPlugin: (name?: string, scope?: 'lab' | 'warehouse') => Promise<string>
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
  /** Data source ID for warehouse plugin testing. */
  testDataSourceId: string | null
  /** Patient context for warehouse plugin testing. */
  testPersonId: string | null
  testVisitId: string | null
  testVisitDetailId: string | null
  testConfig: Record<string, unknown>
  setTestLanguage: (lang: 'python' | 'r') => void
  setTestProject: (uid: string | null) => void
  setTestDataset: (id: string | null) => void
  setTestDataSource: (id: string | null) => void
  setTestPersonId: (id: string | null) => void
  setTestVisitId: (id: string | null) => void
  setTestVisitDetailId: (id: string | null) => void
  setTestConfig: (config: Record<string, unknown>) => void
}

/** Set of built-in plugin IDs (populated on first list refresh). */
const builtInIds = new Set<string>()

export const usePluginEditorStore = create<PluginEditorState>((set, get) => ({
  // List
  pluginList: [],
  activePluginTab: 'warehouse',
  setActivePluginTab(tab) { set({ activePluginTab: tab }) },

  async refreshPluginList() {
    // Built-in plugins from registry (no workspaceId = true built-in)
    const registryPlugins = getAllPlugins()
    if (builtInIds.size === 0) {
      for (const p of registryPlugins) {
        if (!p.workspaceId) builtInIds.add(p.manifest.id)
      }
    }

    // User plugins from IDB — filtered by active workspace
    const storage = getStorage()
    const wsId = useWorkspaceStore.getState().activeWorkspaceId
    const userPlugins = wsId
      ? await storage.userPlugins.getByWorkspace(wsId)
      : await storage.userPlugins.getAll()
    const userIds = new Set(userPlugins.map(up => {
      try {
        const m = JSON.parse(up.files['plugin.json'] ?? '{}')
        return m.id as string
      } catch { return up.id }
    }))

    const list: PluginListItem[] = []
    // Add built-in plugins (those without workspaceId)
    for (const p of registryPlugins) {
      if (p.workspaceId) continue // skip user plugins in registry — we add them from IDB below
      list.push({
        id: p.manifest.id,
        manifest: p.manifest,
        isBuiltIn: !userIds.has(p.manifest.id),
        isSystemPlugin: SYSTEM_PLUGIN_IDS.has(p.manifest.id),
      })
    }
    // Add user plugins from IDB (current workspace only)
    for (const up of userPlugins) {
      try {
        const manifest = JSON.parse(up.files['plugin.json'] ?? '{}') as PluginManifest
        const id = manifest.id ?? up.id
        // If this user plugin overrides a built-in, replace the built-in entry
        const existingIdx = list.findIndex(p => p.id === id)
        if (existingIdx >= 0) {
          list[existingIdx] = { id, manifest, isBuiltIn: false, isSystemPlugin: SYSTEM_PLUGIN_IDS.has(id) }
        } else {
          list.push({ id, manifest, isBuiltIn: false, isSystemPlugin: false })
        }
      } catch { /* skip invalid */ }
    }
    set({ pluginList: list })
  },

  // Editor
  editingPluginId: null,
  isBuiltIn: false,
  isSystemPlugin: false,
  files: {},
  openFiles: [],
  activeFile: null,
  isDirty: false,
  originalFiles: {},
  saveError: null,

  async openPlugin(id: string) {
    const isSystem = SYSTEM_PLUGIN_IDS.has(id)

    const storage = getStorage()
    // Try user plugin first
    const userPlugin = await storage.userPlugins.getById(id)
    if (userPlugin) {
      const files = { ...userPlugin.files }
      const firstFile = 'plugin.json'
      set({
        editingPluginId: id,
        isBuiltIn: false,
        isSystemPlugin: isSystem,
        files,
        originalFiles: { ...files },
        openFiles: [firstFile],
        activeFile: firstFile,
        isDirty: false,
      })
      return
    }
    // Built-in plugin: reconstruct files from registry
    const plugin = getAllPlugins().find(p => p.manifest.id === id)
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
      isSystemPlugin: isSystem,
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
      isSystemPlugin: false,
      files: {},
      originalFiles: {},
      openFiles: [],
      activeFile: null,
      isDirty: false,
      saveError: null,
    })
  },

  async createPlugin(name?: string, scope?: 'lab' | 'warehouse') {
    const id = `user-plugin-${Date.now()}`
    const pluginName = name?.trim() || 'New Plugin'
    const isWarehouse = scope === 'warehouse'
    const scaffoldManifest = isWarehouse ? SCAFFOLD_MANIFEST_WAREHOUSE : SCAFFOLD_MANIFEST_LAB
    const scaffoldTemplate = isWarehouse ? SCAFFOLD_TEMPLATE_WAREHOUSE : SCAFFOLD_TEMPLATE_LAB
    const manifest = { ...scaffoldManifest, id, name: { en: pluginName, fr: pluginName } }
    const files: Record<string, string> = {
      'plugin.json': JSON.stringify(manifest, null, 2),
      'analysis.py.template': scaffoldTemplate,
    }
    const now = new Date().toISOString()
    const wsId = useWorkspaceStore.getState().activeWorkspaceId
    const userPlugin: UserPlugin = { id, files, createdAt: now, updatedAt: now, workspaceId: wsId ?? undefined }
    const storage = getStorage()
    await storage.userPlugins.create(userPlugin)
    // Register in runtime
    const plugin = buildPlugin(manifest as unknown as Record<string, unknown>, { python: scaffoldTemplate })
    plugin.workspaceId = wsId ?? undefined
    registerPlugin(plugin)
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
      const plugin = getAllPlugins().find(p => p.manifest.id === sourceId)
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
    const wsId = useWorkspaceStore.getState().activeWorkspaceId
    const newPlugin: UserPlugin = { id: newId, files: sourceFiles, createdAt: now, updatedAt: now, workspaceId: wsId ?? undefined }
    await storage.userPlugins.create(newPlugin)

    // Register
    try {
      const manifest = JSON.parse(sourceFiles['plugin.json']) as Record<string, unknown>
      const templates: Record<string, string> = {}
      for (const [filename, content] of Object.entries(sourceFiles)) {
        if (filename.endsWith('.py.template')) templates.python = content
        else if (filename.endsWith('.R.template')) templates.r = content
      }
      const plugin = buildPlugin(manifest, Object.keys(templates).length > 0 ? templates : null)
      plugin.workspaceId = wsId ?? undefined
      registerPlugin(plugin)
    } catch { /* skip */ }

    await state.refreshPluginList()
    // Open the new plugin
    await get().openPlugin(newId)
    return newId
  },

  async deletePlugin(id: string) {
    const storage = getStorage()
    await storage.userPlugins.delete(id)
    unregisterPlugin(id)
    if (get().editingPluginId === id) get().closeEditor()
    await get().refreshPluginList()

  },

  async savePlugin() {
    const { editingPluginId, isBuiltIn, isSystemPlugin } = get()
    let { files } = get()
    if (!editingPluginId) return

    // System plugins are read-only — nothing to save
    if (isSystemPlugin) return

    // Validate plugin.json before saving — reject if unparseable
    try {
      JSON.parse(files['plugin.json'] ?? '{}')
    } catch {
      set({ saveError: 'invalid_json' })
      return
    }
    set({ saveError: null })

    // Compute content hash + protect immutable fields + auto-stamp organization
    try {
      const hash = await computePluginContentHash(files)
      const manifest = JSON.parse(files['plugin.json'] ?? '{}')
      manifest.id = editingPluginId
      manifest.contentHash = hash

      // Stamp workspace organization (read-only, inherited)
      const { activeWorkspaceId, _workspacesRaw } = useWorkspaceStore.getState()
      const ws = _workspacesRaw.find((w) => w.id === activeWorkspaceId)
      if (ws?.organizationId) {
        const org = useOrganizationStore.getState().getOrganization(ws.organizationId)
        if (org) {
          const { id: _id, createdAt: _ca, updatedAt: _ua, ...orgInfo } = org
          manifest.organization = orgInfo
        }
      }

      files = { ...files, 'plugin.json': JSON.stringify(manifest, null, 2) }
      set({ files })
    } catch { /* invalid plugin.json — save without hash */ }

    const storage = getStorage()
    const now = new Date().toISOString()

    if (isBuiltIn) {
      // First save of a built-in plugin: create as user plugin
      const wsId = useWorkspaceStore.getState().activeWorkspaceId
      await storage.userPlugins.create({ id: editingPluginId, files: { ...files }, createdAt: now, updatedAt: now, workspaceId: wsId ?? undefined })
      set({ isBuiltIn: false })
    } else {
      await storage.userPlugins.update(editingPluginId, {
        files: { ...files },
        updatedAt: now,
      })
    }

    // Hot-register in plugin registry
    try {
      const manifest = JSON.parse(files['plugin.json'] ?? '{}') as Record<string, unknown>
      const templates: Record<string, string> = {}
      for (const [filename, content] of Object.entries(files)) {
        if (filename.endsWith('.py.template')) templates.python = content
        else if (filename.endsWith('.R.template')) templates.r = content
      }
      // Re-register (overwrites previous)
      registerPlugin(buildPlugin(manifest, Object.keys(templates).length > 0 ? templates : null))
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
    const { files, originalFiles, saveError } = get()
    const newFiles = { ...files, [filename]: content }
    const dirty = JSON.stringify(newFiles) !== JSON.stringify(originalFiles)
    // Clear save error when the user edits plugin.json
    const clearError = saveError && filename === 'plugin.json' ? { saveError: null as string | null } : {}
    set({ files: newFiles, isDirty: dirty, ...clearError })
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
  testDataSourceId: null,
  testPersonId: null,
  testVisitId: null,
  testVisitDetailId: null,
  testConfig: {},

  setTestLanguage(lang) { set({ testLanguage: lang }) },
  setTestProject(uid) { set({ testProjectUid: uid, testDatasetFileId: null }) },
  setTestDataset(id) { set({ testDatasetFileId: id }) },
  setTestDataSource(id) { set({ testDataSourceId: id, testPersonId: null, testVisitId: null, testVisitDetailId: null }) },
  setTestPersonId(id) { set({ testPersonId: id, testVisitId: null, testVisitDetailId: null }) },
  setTestVisitId(id) { set({ testVisitId: id, testVisitDetailId: null }) },
  setTestVisitDetailId(id) { set({ testVisitDetailId: id }) },
  setTestConfig(config) { set({ testConfig: config }) },
}))
