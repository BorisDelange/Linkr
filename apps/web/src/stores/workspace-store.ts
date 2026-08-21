import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { deleteProjectData } from '@/lib/entity-io'
import { seedBuiltinPluginsForWorkspace } from '@/lib/plugins/default-plugins'
import { isShellHtml, toLocalized, setLocalized, localized } from '@/lib/localized'
import type { Workspace, GitRemoteConfig, Language, ProjectBadge, LocalizedString, EntityLicense } from '@/types'
import { useAppStore, registerWorkspaceStore, stampAuthored, stampLineage } from './app-store'
import { useOrganizationStore } from './organization-store'

export interface WorkspaceItem {
  id: string
  name: string
  description: string
  organizationName: string
  createdAt: string
  updatedAt: string
}

function resolveOrgName(ws: Workspace, lang: string): string {
  if (ws.organizationId) {
    const org = useOrganizationStore.getState().getOrganization(ws.organizationId)
    if (org) return localized(org.name, lang)
  }
  // Fallback to embedded org (legacy data)
  return localized(ws.organization?.name, lang)
}

function workspaceToItem(ws: Workspace, lang: string): WorkspaceItem {
  return {
    id: ws.id,
    name: ws.name[lang] ?? ws.name['en'] ?? Object.values(ws.name)[0] ?? '',
    description: ws.description[lang] ?? ws.description['en'] ?? Object.values(ws.description)[0] ?? '',
    organizationName: resolveOrgName(ws, lang),
    createdAt: ws.createdAt?.split('T')[0] ?? '',
    updatedAt: ws.updatedAt,
  }
}

interface WorkspaceState {
  // Data
  _workspacesRaw: Workspace[]
  workspaces: WorkspaceItem[]
  workspacesLoaded: boolean

  // Active workspace
  activeWorkspaceId: string | null
  activeWorkspaceName: string | null

  // CRUD
  loadWorkspaces: () => Promise<void>
  addWorkspace: (params: {
    name: string
    description: string
    organizationId?: string
    gitRemoteConfig?: GitRemoteConfig
  }) => Promise<string>
  updateWorkspace: (id: string, changes: Partial<Workspace>) => Promise<void>
  updateWorkspaceBadges: (id: string, badges: ProjectBadge[]) => Promise<void>
  updateWorkspaceReadme: (id: string, readme: string) => Promise<void>
  updateWorkspaceLicense: (id: string, license: EntityLicense | null) => Promise<void>
  deleteWorkspace: (id: string, onProgress?: (phaseKey: string) => void) => Promise<void>

  // Navigation
  openWorkspace: (id: string, name: string) => void
  closeWorkspace: () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, _get) => ({
  _workspacesRaw: [],
  workspaces: [],
  workspacesLoaded: false,

  activeWorkspaceId: null,
  activeWorkspaceName: null,

  loadWorkspaces: async () => {
    const storage = getStorage()
    const workspaces = await storage.workspaces.getAll()

    // Migration: coerce a legacy string readme into a LocalizedString, and drop
    // values polluted with the SPA shell HTML by an earlier buggy seed loader
    // (a missing README.<lang>.md used to resolve to index.html).
    for (const ws of workspaces) {
      const legacyReadme = typeof ws.readme === 'string' && (ws.readme as string).length > 0
      const readmeObj = legacyReadme ? undefined : (ws.readme as LocalizedString | undefined)
      const polluted = readmeObj != null && Object.values(readmeObj).some(isShellHtml)
      if (!legacyReadme && !polluted) continue
      let next: LocalizedString
      if (legacyReadme) {
        next = isShellHtml(ws.readme as unknown as string) ? {} : toLocalized(ws.readme)
      } else {
        next = Object.fromEntries(Object.entries(readmeObj!).filter(([, v]) => !isShellHtml(v)))
      }
      ws.readme = next
      storage.workspaces.update(ws.id, { readme: next }).catch(() => {})
    }

    const lang = useAppStore.getState().language
    set({
      _workspacesRaw: workspaces,
      workspaces: workspaces.map((ws) => workspaceToItem(ws, lang)),
      workspacesLoaded: true,
    })
  },

  addWorkspace: async ({ name, description, organizationId, gitRemoteConfig }) => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const lang = useAppStore.getState().language
    const workspace: Workspace = {
      id,
      name: { [lang]: name },
      description: { [lang]: description },
      organizationId,
      gitRemoteConfig,
      ...stampAuthored(),
      ...stampLineage(),
      createdAt: now,
      updatedAt: now,
    }
    await getStorage().workspaces.create(workspace)
    // No schema presets are created here any more: a schema is an ordinary entity,
    // installed from the catalog or imported like anything else. See
    // docs/planning/default-data-repos-plan.md §11.10.
    // Seed a copy of every built-in plugin so the workspace lists them in its
    // Plugins page.
    await seedBuiltinPluginsForWorkspace(id)
    set((s) => ({
      _workspacesRaw: [...s._workspacesRaw, workspace],
      workspaces: [...s.workspaces, workspaceToItem(workspace, lang)],
    }))
    return id
  },

  updateWorkspace: async (id, changes) => {
    await getStorage().workspaces.update(id, changes)
    const lang = useAppStore.getState().language
    set((s) => {
      const newRaw = s._workspacesRaw.map((ws) =>
        ws.id === id ? { ...ws, ...changes, updatedAt: new Date().toISOString() } : ws,
      )
      return {
        _workspacesRaw: newRaw,
        workspaces: newRaw.map((ws) => workspaceToItem(ws, lang)),
        activeWorkspaceName:
          s.activeWorkspaceId === id
            ? (changes.name
                ? (changes.name[lang] ?? changes.name['en'] ?? Object.values(changes.name)[0] ?? s.activeWorkspaceName)
                : s.activeWorkspaceName)
            : s.activeWorkspaceName,
      }
    })
  },

  updateWorkspaceBadges: async (id, badges) => {
    await getStorage().workspaces.update(id, { badges })
    const lang = useAppStore.getState().language
    set((s) => {
      const newRaw = s._workspacesRaw.map((ws) =>
        ws.id === id ? { ...ws, badges, updatedAt: new Date().toISOString() } : ws,
      )
      return {
        _workspacesRaw: newRaw,
        workspaces: newRaw.map((ws) => workspaceToItem(ws, lang)),
      }
    })
  },

  updateWorkspaceReadme: async (id, readme) => {
    const lang = useAppStore.getState().language
    const now = new Date().toISOString()
    let next: LocalizedString | undefined
    set((s) => ({
      _workspacesRaw: s._workspacesRaw.map((ws) => {
        if (ws.id !== id) return ws
        next = setLocalized(ws.readme, lang, readme)
        return { ...ws, readme: next, updatedAt: now }
      }),
    }))
    if (next) await getStorage().workspaces.update(id, { readme: next, updatedAt: now })
  },

  updateWorkspaceLicense: async (id, license) => {
    const next = license ?? undefined
    const now = new Date().toISOString()
    set((s) => ({
      _workspacesRaw: s._workspacesRaw.map((ws) => (ws.id === id ? { ...ws, license: next, updatedAt: now } : ws)),
    }))
    await getStorage().workspaces.update(id, { license: next, updatedAt: now })
  },

  deleteWorkspace: async (id, onProgress) => {
    const storage = getStorage()
    const phase = (key: string) => {
      try { onProgress?.(key) } catch { /* ignore */ }
    }
    /** Yield to the browser so React paints the new phase before the next sync block. */
    const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

    // Cascade delete all workspace-scoped entities
    phase('workspaces.delete_phase_projects')
    await yieldToBrowser()
    const projects = (await storage.projects.getAll()).filter(p => p.workspaceId === id)
    for (const p of projects) {
      await deleteProjectData(storage, p.uid)
      await storage.projects.delete(p.uid).catch(() => {})
    }

    // Data sources
    phase('workspaces.delete_phase_databases')
    await yieldToBrowser()
    const dataSources = await storage.dataSources.getByWorkspace(id)
    for (const ds of dataSources) {
      await storage.files.deleteByDataSource(ds.id).catch(() => {})
      await storage.fileHandles.deleteByDataSource(ds.id).catch(() => {})
      await storage.databaseStatsCache.delete(ds.id).catch(() => {})
      await storage.dataSources.delete(ds.id).catch(() => {})
    }

    // Wiki
    phase('workspaces.delete_phase_wiki')
    await yieldToBrowser()
    await storage.wikiAttachments.deleteByWorkspace(id).catch(() => {})
    await storage.readmeAttachments.deleteByWorkspace(id).catch(() => {})
    await storage.wikiPages.deleteByWorkspace(id).catch(() => {})

    // SQL scripts
    phase('workspaces.delete_phase_sql')
    await yieldToBrowser()
    const sqlCollections = await storage.sqlScriptCollections.getByWorkspace(id)
    for (const c of sqlCollections) {
      await storage.sqlScriptFiles.deleteByCollection(c.id).catch(() => {})
      await storage.sqlScriptCollections.delete(c.id).catch(() => {})
    }

    // ETL
    phase('workspaces.delete_phase_etl')
    await yieldToBrowser()
    const etlPipelines = await storage.etlPipelines.getByWorkspace(id)
    for (const p of etlPipelines) {
      await storage.etlFiles.deleteByPipeline(p.id).catch(() => {})
      await storage.etlPipelines.delete(p.id).catch(() => {})
    }

    // DQ
    phase('workspaces.delete_phase_dq')
    await yieldToBrowser()
    const dqRuleSets = await storage.dqRuleSets.getByWorkspace(id)
    for (const rs of dqRuleSets) {
      await storage.dqCustomChecks.deleteByRuleSet(rs.id).catch(() => {})
      await storage.dqRuleSets.delete(rs.id).catch(() => {})
    }

    // Concept mapping
    phase('workspaces.delete_phase_mappings')
    await yieldToBrowser()
    const mappingProjects = await storage.mappingProjects.getByWorkspace(id)
    const mappingProjectIds = mappingProjects.map((mp) => mp.id)
    // Delete in bulk to avoid one round-trip per project, and ensure we don't miss any row.
    await storage.conceptMappings.deleteByProjectIds(mappingProjectIds).catch(() => {})
    for (const mp of mappingProjects) {
      await storage.mappingProjects.delete(mp.id).catch(() => {})
    }
    // Defensive sweep: delete any concept_mapping row whose projectId is no longer a valid project
    // (orphans from earlier failed imports).
    try {
      const remainingProjects = await storage.mappingProjects.getAll()
      const validIds = new Set(remainingProjects.map((p) => p.id))
      await storage.conceptMappings.deleteOrphans(validIds)
    } catch { /* ignore */ }
    const conceptSets = await storage.conceptSets.getByWorkspace(id)
    for (const cs of conceptSets) await storage.conceptSets.delete(cs.id).catch(() => {})

    // Source concept ID registry (workspace-scoped)
    phase('workspaces.delete_phase_source_id_registry')
    await yieldToBrowser()
    await storage.sourceConceptIdEntries.deleteByWorkspace(id).catch(() => {})
    await storage.sourceConceptIdRanges.deleteByWorkspace(id).catch(() => {})

    // Catalogs & service mappings
    phase('workspaces.delete_phase_catalogs')
    await yieldToBrowser()
    const catalogs = await storage.dataCatalogs.getByWorkspace(id)
    for (const cat of catalogs) await storage.dataCatalogs.delete(cat.id).catch(() => {})
    const serviceMappings = await storage.serviceMappings.getByWorkspace(id)
    for (const sm of serviceMappings) await storage.serviceMappings.delete(sm.id).catch(() => {})

    // Plugins
    phase('workspaces.delete_phase_plugins')
    await yieldToBrowser()
    const plugins = await storage.userPlugins.getByWorkspace(id)
    for (const p of plugins) await storage.userPlugins.delete(p.id).catch(() => {})

    // Schema presets
    phase('workspaces.delete_phase_schemas')
    await yieldToBrowser()
    const schemas = await storage.schemaPresets.getByWorkspace(id)
    for (const sp of schemas) await storage.schemaPresets.delete(sp.presetId).catch(() => {})

    // Finally delete the workspace itself
    phase('workspaces.delete_phase_finalizing')
    await yieldToBrowser()
    await storage.workspaces.delete(id)

    // Reload projects store since we deleted projects
    await useAppStore.getState().loadProjects()

    // Clear concept-mapping in-memory state so deleted mappings don't pollute future
    // project views. Dynamic import to avoid a circular module dependency.
    try {
      const { useConceptMappingStore } = await import('./concept-mapping-store')
      const cm = useConceptMappingStore.getState()
      useConceptMappingStore.setState({
        mappings: [],
        mappingsById: new Map(),
        mappingsVersion: cm.mappingsVersion + 1,
        mappingsStructureVersion: cm.mappingsStructureVersion + 1,
        mappingsLoaded: false,
        activeProjectId: null,
        mappingProjects: cm.mappingProjects.filter((p) => p.workspaceId !== id),
        conceptSets: cm.conceptSets.filter((cs) => cs.workspaceId !== id),
        otherProjectsMappedKeys: new Set(),
        otherProjectsMappings: new Map(),
        _otherKeysLoadedFor: null,
        _otherDetailsLoadedFor: null,
      })
    } catch { /* ignore */ }

    set((s) => ({
      _workspacesRaw: s._workspacesRaw.filter((ws) => ws.id !== id),
      workspaces: s.workspaces.filter((ws) => ws.id !== id),
      activeWorkspaceId: s.activeWorkspaceId === id ? null : s.activeWorkspaceId,
      activeWorkspaceName: s.activeWorkspaceId === id ? null : s.activeWorkspaceName,
    }))
  },

  openWorkspace: (id, name) => {
    // Close any active project when switching workspaces
    useAppStore.getState().closeProject()
    set({ activeWorkspaceId: id, activeWorkspaceName: name })
  },

  closeWorkspace: () => {
    // Close any active project too
    useAppStore.getState().closeProject()
    set({ activeWorkspaceId: null, activeWorkspaceName: null })
  },
}))

// Register with app-store to break circular dependency
registerWorkspaceStore(useWorkspaceStore)

// Re-derive display items when language changes
useAppStore.subscribe((state, prevState) => {
  if (state.language !== (prevState as { language: Language }).language) {
    const wsState = useWorkspaceStore.getState()
    if (wsState._workspacesRaw.length > 0) {
      useWorkspaceStore.setState({
        workspaces: wsState._workspacesRaw.map((ws) => workspaceToItem(ws, state.language)),
      })
    }
  }
})

// Re-derive display items when organization data changes (org name updated, etc.)
useOrganizationStore.subscribe((state, prevState) => {
  if (state._organizationsRaw !== prevState._organizationsRaw) {
    const wsState = useWorkspaceStore.getState()
    if (wsState._workspacesRaw.length > 0) {
      const lang = useAppStore.getState().language
      useWorkspaceStore.setState({
        workspaces: wsState._workspacesRaw.map((ws) => workspaceToItem(ws, lang)),
      })
    }
  }
})
