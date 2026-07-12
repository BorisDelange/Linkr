import { create } from 'zustand'
import type { PluginManifest } from '@/types/plugin'
import type { UserPlugin } from '@/types'
import { getStorage } from '@/lib/storage'
import {
  getAllPlugins,
  getPlugin,
  registerPlugin,
  unregisterPlugin,
} from '@/lib/plugins/registry'
import { SYSTEM_PLUGIN_IDS } from '@/lib/plugins/builtin-widget-plugins'
import { buildPlugin, isBuiltinPluginId } from '@/lib/plugins/default-plugins'
import { computePluginContentHash } from '@/lib/plugin-hash'
import { useWorkspaceStore } from './workspace-store'
import { useOrganizationStore } from './organization-store'

/** Plugins are always workspace-scoped. Callers guard the UI so this only throws
 * as a backstop (e.g. a create attempted with no workspace open). */
function requireActiveWorkspace(): string {
  const wsId = useWorkspaceStore.getState().activeWorkspaceId
  if (!wsId) throw new Error('A workspace must be open to create or edit a plugin')
  return wsId
}

export interface PluginListItem {
  /** Storage row id (unique per workspace). Use for open/edit/delete/versioning. */
  id: string
  /** Manifest id (shared across workspaces for built-ins). Use for registry lookup,
   *  system-plugin detection and add-default dedup. */
  manifestId: string
  manifest: PluginManifest
  /** App-provided built-in (lab component or warehouse widget). Its code lives in the
   *  bundle, so it is read-only: not editable, not openable. */
  isBuiltIn: boolean
  /** System plugins are built-in patient data widgets — metadata-only editing, no code. */
  isSystemPlugin: boolean
  /** Convenience: read-only = built-in or system. Neither can be edited/opened. */
  readOnly: boolean
  /** entityId from the UserPlugin record (only for user plugins). */
  entityId?: string
  /** Git remote for export/versioning (from the UserPlugin record). */
  gitRemoteConfig?: import('@/types').GitRemoteConfig
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
  createPlugin: (name?: string, scope?: 'lab' | 'warehouse', entityId?: string) => Promise<string>
  /** Create a plugin from full form fields (create dialog) — writes name/desc/etc. in one shot. */
  createPluginWithFields: (fields: import('@/types/plugin').PluginFormFields, lang: string, entityId?: string) => Promise<string>
  /** Apply edited metadata fields to the open plugin's plugin.json and persist. */
  applyManifestFields: (fields: import('@/types/plugin').PluginFormFields, lang: string) => Promise<void>
  /** Edit a plugin's metadata by id (from the list, without opening the code editor). */
  updatePluginMetadata: (pluginId: string, fields: import('@/types/plugin').PluginFormFields, lang: string) => Promise<void>
  /** Copy a built-in plugin from the registry into IDB for the current workspace. */
  addBuiltinPlugin: (pluginId: string) => Promise<string | null>
  duplicatePlugin: (sourceId: string) => Promise<string>
  deletePlugin: (id: string) => Promise<void>
  savePlugin: () => Promise<void>

  // File actions
  openFile: (filename: string) => void
  closeFile: (filename: string) => void
  updateFileContent: (filename: string, content: string) => void
  createFile: (filename: string, content?: string) => void
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
    // Populate builtInIds once for reference
    if (builtInIds.size === 0) {
      for (const p of getAllPlugins()) {
        if (!p.workspaceId) builtInIds.add(p.manifest.id)
      }
    }

    // Only show plugins from IDB (user-added or added from defaults)
    const storage = getStorage()
    const wsId = useWorkspaceStore.getState().activeWorkspaceId
    const userPlugins = wsId
      ? await storage.userPlugins.getByWorkspace(wsId)
      : await storage.userPlugins.getAll()

    const list: PluginListItem[] = []
    for (const up of userPlugins) {
      try {
        const manifest = JSON.parse(up.files['plugin.json'] ?? '{}') as PluginManifest
        const manifestId = manifest.id ?? up.id
        const isSystemPlugin = SYSTEM_PLUGIN_IDS.has(manifestId)
        const isBuiltIn = isBuiltinPluginId(manifestId)
        list.push({ id: up.id, manifestId, manifest, isBuiltIn, isSystemPlugin, readOnly: isBuiltIn || isSystemPlugin, entityId: up.entityId, gitRemoteConfig: up.gitRemoteConfig })
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
    const storage = getStorage()
    // Try user plugin first (id is the storage row id)
    const userPlugin = await storage.userPlugins.getById(id)
    if (userPlugin) {
      const files = { ...userPlugin.files }
      const firstFile = 'plugin.json'
      // System-plugin detection is by manifest id, not the (workspace-scoped) row id.
      let manifestId = id
      try { manifestId = JSON.parse(files['plugin.json'] ?? '{}').id ?? id } catch { /* keep id */ }
      set({
        editingPluginId: id,
        isBuiltIn: false,
        isSystemPlugin: SYSTEM_PLUGIN_IDS.has(manifestId),
        files,
        originalFiles: { ...files },
        openFiles: [firstFile],
        activeFile: firstFile,
        isDirty: false,
      })
      return
    }
    // Built-in plugin not seeded as a row: reconstruct from registry (id = manifest id).
    const isSystem = SYSTEM_PLUGIN_IDS.has(id)
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

  async createPlugin(name?: string, scope?: 'lab' | 'warehouse', entityId?: string) {
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
    const wsId = requireActiveWorkspace()
    const userPlugin: UserPlugin = { id, entityId: entityId || undefined, files, createdAt: now, updatedAt: now, workspaceId: wsId }
    const storage = getStorage()
    await storage.userPlugins.create(userPlugin)
    // Register in runtime
    const plugin = buildPlugin(manifest as unknown as Record<string, unknown>, { python: scaffoldTemplate })
    plugin.workspaceId = wsId
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

  async createPluginWithFields(fields, lang, entityId) {
    const id = `user-plugin-${Date.now()}`
    const isWarehouse = fields.scope === 'warehouse'
    const scaffoldManifest = isWarehouse ? SCAFFOLD_MANIFEST_WAREHOUSE : SCAFFOLD_MANIFEST_LAB
    const scaffoldTemplate = isWarehouse ? SCAFFOLD_TEMPLATE_WAREHOUSE : SCAFFOLD_TEMPLATE_LAB
    const name = fields.name.trim() || 'New Plugin'
    const manifest: Record<string, unknown> = {
      ...scaffoldManifest,
      id,
      name: { en: name, fr: name, [lang]: name },
      description: { en: fields.description, fr: fields.description, [lang]: fields.description },
      scope: fields.scope,
      languages: fields.languages.length > 0 ? fields.languages : ['python'],
      icon: fields.icon || 'Puzzle',
      iconColor: fields.iconColor,
      badges: fields.badges,
      version: fields.version || '1.0.0',
      catalogVisibility: fields.catalogVisibility,
      dependencies: { python: fields.pythonDeps, r: fields.rDeps },
    }
    const files: Record<string, string> = {
      'plugin.json': JSON.stringify(manifest, null, 2),
      'analysis.py.template': scaffoldTemplate,
    }
    const now = new Date().toISOString()
    const wsId = requireActiveWorkspace()
    await getStorage().userPlugins.create({ id, entityId: entityId || undefined, files, createdAt: now, updatedAt: now, workspaceId: wsId })
    const plugin = buildPlugin(manifest, { python: scaffoldTemplate })
    plugin.workspaceId = wsId
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

  async updatePluginMetadata(pluginId, fields, lang) {
    const storage = getStorage()
    const up = await storage.userPlugins.getById(pluginId)
    if (!up) return
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(up.files['plugin.json'] ?? '{}')
    } catch { return }
    const name = fields.name.trim()
    manifest.name = { ...(manifest.name as object), en: (manifest.name as Record<string, string>)?.en ?? name, [lang]: name }
    manifest.description = { ...(manifest.description as object), [lang]: fields.description }
    manifest.scope = fields.scope
    manifest.languages = fields.languages
    manifest.icon = fields.icon || 'Puzzle'
    manifest.iconColor = fields.iconColor
    manifest.badges = fields.badges
    manifest.version = fields.version || '1.0.0'
    manifest.catalogVisibility = fields.catalogVisibility
    manifest.dependencies = { python: fields.pythonDeps, r: fields.rDeps }
    const newFiles = { ...up.files, 'plugin.json': JSON.stringify(manifest, null, 2) }
    await storage.userPlugins.update(pluginId, { files: newFiles, updatedAt: new Date().toISOString() })
    // Keep the in-editor state in sync if this same plugin is currently open.
    if (get().editingPluginId === pluginId) {
      set({ files: newFiles, originalFiles: { ...newFiles }, isDirty: false })
    }
    try {
      const templates: Record<string, string> = {}
      for (const [filename, content] of Object.entries(newFiles)) {
        if (filename.endsWith('.py.template')) templates.python = content
        else if (filename.endsWith('.R.template')) templates.r = content
      }
      const rebuilt = buildPlugin(manifest, Object.keys(templates).length > 0 ? templates : null)
      const existing = getPlugin(manifest.id as string)
      if (existing?.componentId && !rebuilt.componentId) rebuilt.componentId = existing.componentId
      registerPlugin(rebuilt)
    } catch { /* invalid json — still persisted */ }
    await get().refreshPluginList()
  },

  async applyManifestFields(fields, lang) {
    const { files } = get()
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(files['plugin.json'] ?? '{}')
    } catch { return }
    const name = fields.name.trim()
    manifest.name = { ...(manifest.name as object), en: (manifest.name as Record<string, string>)?.en ?? name, [lang]: name }
    manifest.description = { ...(manifest.description as object), [lang]: fields.description }
    manifest.scope = fields.scope
    manifest.languages = fields.languages
    manifest.icon = fields.icon || 'Puzzle'
    manifest.iconColor = fields.iconColor
    manifest.badges = fields.badges
    manifest.version = fields.version || '1.0.0'
    manifest.catalogVisibility = fields.catalogVisibility
    manifest.dependencies = { python: fields.pythonDeps, r: fields.rDeps }
    get().updateFileContent('plugin.json', JSON.stringify(manifest, null, 2))
    await get().savePlugin()
  },

  async addBuiltinPlugin(pluginId: string) {
    const plugin = getAllPlugins().find(p => p.manifest.id === pluginId)
    if (!plugin) return null
    const now = new Date().toISOString()
    const wsId = requireActiveWorkspace()
    const files: Record<string, string> = {
      'plugin.json': JSON.stringify(plugin.manifest, null, 2),
    }
    if (plugin.templates) {
      for (const [lang, content] of Object.entries(plugin.templates)) {
        const ext = lang === 'r' ? '.R.template' : '.py.template'
        files[`analysis${ext}`] = content
      }
    }
    // Row id must be unique per workspace (global PK); the manifest id lives in
    // entityId + the plugin.json. Same rule as seedBuiltinPluginsForWorkspace.
    const rowId = crypto.randomUUID()
    const userPlugin: UserPlugin = { id: rowId, entityId: pluginId, files, createdAt: now, updatedAt: now, workspaceId: wsId }
    const storage = getStorage()
    await storage.userPlugins.create(userPlugin)
    registerPlugin(plugin)
    await get().refreshPluginList()
    return rowId
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
    const wsId = requireActiveWorkspace()
    const newPlugin: UserPlugin = { id: newId, files: sourceFiles, createdAt: now, updatedAt: now, workspaceId: wsId }
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
      plugin.workspaceId = wsId
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
      // Do NOT overwrite manifest.id with editingPluginId: the latter is the storage
      // row id (a per-workspace UUID), while manifest.id is the shared plugin identity
      // that the in-memory registry (and rendered widgets) key on.
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
      const wsId = requireActiveWorkspace()
      await storage.userPlugins.create({ id: editingPluginId, files: { ...files }, createdAt: now, updatedAt: now, workspaceId: wsId })
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
      const rebuilt = buildPlugin(manifest, Object.keys(templates).length > 0 ? templates : null)
      // Component plugins are backed by a React component in the bundle, not by templates.
      // The componentId lives only in the in-memory registry (never in the editable files),
      // so carry it over from the existing registration — otherwise the re-registered plugin
      // falls through to the script renderer and reports "templates not found".
      // Look up by manifest id (registry key), not the storage row id.
      const existing = getPlugin(manifest.id as string)
      if (existing?.componentId && !rebuilt.componentId) rebuilt.componentId = existing.componentId
      registerPlugin(rebuilt)
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

  createFile(filename: string, content = '') {
    const { files } = get()
    if (files[filename] !== undefined) return
    const newFiles = { ...files, [filename]: content }
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
