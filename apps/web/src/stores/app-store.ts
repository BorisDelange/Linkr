import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { apiRequest, isServerMode } from '@/lib/api-client'
import { deleteProjectData } from '@/lib/entity-io'
import { slugifyId } from '@/lib/slugify-id'
import { setLocalized, toLocalized, isShellHtml } from '@/lib/localized'
import { seedWorkspaces, isSeeded } from '@/lib/seed-loader'
import { userToAuthorDetails } from '@/lib/user-identity'
import { buildPointer } from '@/lib/import-identity'
import type { Project, Workspace, Language, LocalizedString, TodoItem, ProjectStatus, ProjectBadge, OrganizationInfo, CatalogVisibility, AuthorDetails, Authored, Lineaged, EntityLicense } from '@/types'

// Lazy reference to break circular dependency with workspace-store at module init time.
// Populated via registerWorkspaceStore() called from workspace-store.ts after it's created.
// Typed to the minimal surface used here so we avoid importing the full store
// (which would re-introduce the circular dependency).
interface WorkspaceStoreLike {
  getState(): { activeWorkspaceId: string | null; _workspacesRaw: Workspace[] }
  setState(partial: { activeWorkspaceId: string; activeWorkspaceName: string }): void
}
let _useWorkspaceStore: WorkspaceStoreLike | null = null
export function registerWorkspaceStore(store: WorkspaceStoreLike) {
  _useWorkspaceStore = store
}

interface AuthUser {
  id: number
  username: string
  firstName: string
  lastName: string
  role: string
  email?: string
  affiliation?: LocalizedString | string
  profession?: LocalizedString | string
  orcid?: string
}

interface ProjectItem {
  uid: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

interface ManagedUser {
  id: number
  username: string
  firstName: string
  lastName: string
  role: string
}

/** `*-auto` follows the app's light/dark mode (see darkMode) within that theme
 *  family — `linkr-auto` picks linkr-light/linkr-dark, `vs-auto` picks vs/vs-dark.
 *  The other 4 are a fixed choice regardless of app mode. */
export type EditorTheme = 'linkr-auto' | 'vs-auto' | 'linkr-light' | 'linkr-dark' | 'vs' | 'vs-dark'

/** Resolve an EditorTheme + the app's darkMode into a concrete Monaco theme name
 *  (never one of the `*-auto` values). A theme persisted before the 'auto' split
 *  falls through to the linkr-auto behavior. */
export function resolveEditorTheme(theme: EditorTheme, darkMode: boolean): 'linkr-light' | 'linkr-dark' | 'vs' | 'vs-dark' {
  if (theme === 'vs-auto') return darkMode ? 'vs-dark' : 'vs'
  if (theme === 'linkr-light' || theme === 'linkr-dark' || theme === 'vs' || theme === 'vs-dark') return theme
  return darkMode ? 'linkr-dark' : 'linkr-light'
}

/** Is the resolved Monaco theme a dark one? Used by non-Monaco consumers (xterm)
 *  that only need the light/dark split, not the specific theme name. */
export function isEditorThemeDark(theme: EditorTheme, darkMode: boolean): boolean {
  return resolveEditorTheme(theme, darkMode) === 'linkr-dark' || resolveEditorTheme(theme, darkMode) === 'vs-dark'
}

export interface EditorSettings {
  fontSize: number
  wordWrap: 'on' | 'off'
  minimap: boolean
  lineNumbers: 'on' | 'off' | 'relative'
  tabSize: number
  theme: EditorTheme
  autoSave: boolean
  autoSaveDelay: number
}

// --- Preferences persistence (localStorage) ---

const PREFS_KEY = 'linkr-preferences'

interface Preferences {
  language: Language
  darkMode: boolean
  editorSettings: EditorSettings
  sidebarCollapsed: boolean
  dismissSeedUpdateNotifications: boolean
  userFirstName?: string
  userLastName?: string
  userEmail?: string
  userAffiliation?: LocalizedString | string
  userProfession?: LocalizedString | string
  userOrcid?: string
}

function loadPreferences(): Partial<Preferences> {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? (JSON.parse(raw) as Partial<Preferences>) : {}
  } catch {
    return {}
  }
}

function savePreferences(prefs: Preferences): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
}

// --- Project conversion ---

function projectToItem(project: Project, lang: string): ProjectItem {
  // Records imported from a git-linked pointer (or old data) may lack name/description.
  const name = project.name ?? {}
  const description = project.description ?? {}
  return {
    uid: project.uid,
    name: name[lang] ?? name['en'] ?? Object.values(name)[0] ?? '',
    description: description[lang] ?? description['en'] ?? Object.values(description)[0] ?? '',
    createdAt: project.createdAt?.split('T')[0] ?? '',
    updatedAt: project.updatedAt,
  }
}

// --- Seed ---

// --- Store ---

interface AppState {
  // Auth
  user: AuthUser | null
  login: (user: AuthUser) => void
  logout: () => void
  updateUser: (changes: Partial<Pick<AuthUser, 'firstName' | 'lastName' | 'email' | 'affiliation' | 'profession' | 'orcid'>>) => void
  /** Get display name: "First Last", or username if no name set. */
  getUserDisplayName: () => string
  /** Structured author identity snapshot for stamping onto created entities. */
  getAuthorDetails: () => AuthorDetails

  // Projects
  _projectsRaw: Project[]
  projects: ProjectItem[]
  projectsLoaded: boolean
  loadProjects: () => Promise<void>
  addProject: (name: string, description: string, workspaceId?: string, projectId?: string) => Promise<string>
  updateProject: (uid: string, name: string, description: string) => Promise<void>
  updateProjectTodos: (uid: string, todos: TodoItem[]) => void
  updateProjectNotes: (uid: string, notes: string) => void
  updateProjectReadme: (uid: string, readme: string) => void
  updateProjectLicense: (uid: string, license: EntityLicense | null) => Promise<void>

  restoreReadmeVersion: (uid: string, snapshotId: string) => void
  updateProjectStatus: (uid: string, status: ProjectStatus) => void
  updateProjectBadges: (uid: string, badges: ProjectBadge[]) => void
  updateProjectVersion: (uid: string, version: string) => void
  updateProjectOrganization: (uid: string, org: OrganizationInfo | undefined) => void
  /** Persist an author/organization provenance re-attribution and reflect it in memory. */
  updateProjectAuthoring: (uid: string, patch: Partial<Pick<Project, 'createdById' | 'createdBy' | 'createdByDetails' | 'organization'>>) => Promise<void>
  updateProjectCatalogVisibility: (uid: string, visibility: CatalogVisibility) => void
  updateProjectPaths: (uid: string, patch: Partial<Pick<Project, 'idePath' | 'scriptsPath' | 'datasetsPath'>>) => Promise<void>
  /** Toggle a dataset-relative path in project.config.versionedDataFiles (mark /
   *  unmark a data file "to version"). Persists + travels with the export. */
  toggleVersionedDataFile: (uid: string, path: string) => Promise<void>
  toggleExcludedFile: (uid: string, path: string) => Promise<void>
  getWorkspaceProjects: (workspaceId: string) => ProjectItem[]
  deleteProject: (uid: string) => Promise<void>

  // Data source linking (app-level databases ↔ projects)
  linkDataSource: (projectUid: string, dataSourceId: string) => Promise<void>
  unlinkDataSource: (projectUid: string, dataSourceId: string) => void
  getProjectLinkedDataSourceIds: (projectUid: string) => string[]

  // Users (admin)
  users: ManagedUser[]
  addUser: (user: Omit<ManagedUser, 'id'>) => void
  deleteUser: (id: number) => void

  // Active project
  activeProjectUid: string | null
  activeProjectName: string | null
  openProject: (uid: string, name: string) => void
  closeProject: () => void

  // Language
  language: Language
  setLanguage: (lang: Language) => void

  // Theme
  darkMode: boolean
  toggleDarkMode: () => void

  // Editor settings
  editorSettings: EditorSettings
  updateEditorSettings: (settings: Partial<EditorSettings>) => void

  // Notifications
  dismissSeedUpdateNotifications: boolean
  setDismissSeedUpdateNotifications: (value: boolean) => void

  // UI state
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  bottomPanelOpen: boolean
  toggleBottomPanel: () => void
  bottomPanelHeight: number
  setBottomPanelHeight: (height: number) => void
}

const defaultEditorSettings: EditorSettings = {
  fontSize: 11,
  wordWrap: 'on',
  minimap: false,
  lineNumbers: 'on',
  tabSize: 2,
  theme: 'linkr-auto',
  autoSave: false,
  autoSaveDelay: 1000,
}

const prefs = loadPreferences()

let nextUserId = 2

export const useAppStore = create<AppState>((set, get) => ({
  user: { id: 1, username: 'admin', firstName: prefs.userFirstName ?? '', lastName: prefs.userLastName ?? '', role: 'admin', email: prefs.userEmail ?? '', affiliation: prefs.userAffiliation ?? '', profession: prefs.userProfession ?? '', orcid: prefs.userOrcid ?? '' },
  login: (user) => set({ user }),
  logout: () => set({ user: null }),
  updateUser: (changes) => {
    set((s) => (s.user ? { user: { ...s.user, ...changes } } : s))
    // Server mode: persist to the backend so the edit survives a reload (front-only
    // mode is covered by the localStorage prefs subscription below). Best-effort —
    // the optimistic in-memory update already reflects the change in the UI.
    if (isServerMode()) {
      apiRequest('/auth/me', { method: 'PATCH', body: JSON.stringify(changes) })
        .catch(() => { /* leave the optimistic value; next /auth/me reconciles */ })
    }
  },
  getUserDisplayName: () => {
    const u = get().user
    if (!u) return ''
    const full = `${u.firstName} ${u.lastName}`.trim()
    return full || u.username
  },
  getAuthorDetails: () => {
    const u = get().user
    if (!u) return {}
    return userToAuthorDetails(u)
  },

  // Projects
  _projectsRaw: [],
  projects: [],
  projectsLoaded: false,

  loadProjects: async () => {
    const storage = getStorage()
    let projects = await storage.projects.getAll()

    // Seed workspaces from public/data/seed/ on first launch only (never re-seed).
    //
    // Front-only mode ONLY. In server mode the baseline is instance state, and
    // `isSeeded()` reads localStorage — which is per-browser, so a second user (or
    // the same one on another machine) came in "unseeded" and re-ran the whole seed
    // THROUGH THE API, writing a duplicate copy of the demo content into a shared
    // instance. The server-mode baseline is the setup wizard's default-data step
    // (one catalog install, recorded in `app_settings`); see
    // `docs/planning/default-data-repos-plan.md` §0.
    const workspaces = await storage.workspaces.getAll()
    if (!isServerMode() && projects.length === 0 && workspaces.length === 0 && !isSeeded()) {
      try {
        await seedWorkspaces()
        projects = await storage.projects.getAll()

        const { useOrganizationStore } = await import('./organization-store')
        useOrganizationStore.getState().loadOrganizations()
        const { useWorkspaceStore } = await import('./workspace-store')
        useWorkspaceStore.getState().loadWorkspaces()
        // Cohorts and pipelines are read ONCE, by the App shell, and this seed runs
        // after that: what it wrote stayed invisible until a manual reload. Same
        // re-read the catalog install does (lib/catalog/refresh.ts).
        const { useCohortStore } = await import('./cohort-store')
        useCohortStore.getState().loadCohorts()
        const { usePipelineStore } = await import('./pipeline-store')
        usePipelineStore.getState().loadPipelines()
      } catch {
        // Seed data may already exist in IndexedDB from a previous session
      }
    }

    // Migration: repair projects whose workspaceId was saved as a SHORT id prefix (a regression
    // from the short-URL change, where a page persisted the URL prefix instead of the full id).
    // Map a prefix that uniquely matches one real workspace back to that workspace's full id.
    const allWsIds = (await storage.workspaces.getAll()).map((w) => w.id)
    for (const p of projects) {
      if (!p.workspaceId || allWsIds.includes(p.workspaceId)) continue
      const matches = allWsIds.filter((id) => id.startsWith(p.workspaceId!))
      if (matches.length === 1) {
        p.workspaceId = matches[0]
        storage.projects.update(p.uid, { workspaceId: matches[0] }).catch(() => {})
      }
    }

    // Migration: assign a readable slug to projects that don't have one. Both
    // names count as "has one": a project written after the rename carries
    // `entityId`, one written before carries `projectId`, and re-minting for the
    // former would change a folder name that exports and git trees already use.
    const slugOf = (p: Project) => p.entityId ?? p.projectId
    const usedIds = new Set(projects.map(slugOf).filter((v): v is string => !!v))
    for (const p of projects) {
      if (slugOf(p)) continue
      const name = typeof p.name === 'string' ? p.name : (p.name.en || p.name.fr || Object.values(p.name)[0] || 'project')
      let candidate = slugifyId(name) || 'project'
      if (candidate.length < 2) candidate = `project-${candidate}`
      let id = candidate
      let suffix = 2
      while (usedIds.has(id)) { id = `${candidate}-${suffix++}` }
      p.entityId = id
      p.projectId = id
      usedIds.add(id)
      // Both names, same value: `entityId` is what every entity calls its slug,
      // `projectId` is kept so a client or repo predating the rename still reads it.
      storage.projects.update(p.uid, { entityId: id, projectId: id }).catch(() => {})
    }

    // Migration: coerce legacy string readme / notes / todo text into
    // LocalizedString, and repair readmes that were polluted with the SPA shell
    // HTML by an earlier buggy per-language seed loader (see fetchMarkdown).
    for (const p of projects) {
      const legacyReadme = typeof p.readme === 'string' && (p.readme as string).length > 0
      const legacyNotes = typeof p.notes === 'string' && (p.notes as string).length > 0
      const legacyTodos = (p.todos ?? []).some((t) => typeof t.text === 'string')
      const readmeObj = legacyReadme ? undefined : (p.readme as LocalizedString | undefined)
      const pollutedReadme = readmeObj != null && Object.values(readmeObj).some(isShellHtml)
      if (!legacyReadme && !legacyNotes && !legacyTodos && !pollutedReadme) continue
      const changes: Partial<Project> = {}
      if (legacyReadme) {
        // A legacy string that is itself the SPA shell must be dropped, not wrapped.
        changes.readme = isShellHtml(p.readme as unknown as string) ? {} : toLocalized(p.readme)
      } else if (pollutedReadme) {
        changes.readme = Object.fromEntries(
          Object.entries(readmeObj!).filter(([, v]) => !isShellHtml(v)),
        )
      }
      if (legacyNotes) changes.notes = toLocalized(p.notes)
      if (legacyTodos) {
        changes.todos = (p.todos ?? []).map((t) => ({ ...t, text: toLocalized(t.text) }))
      }
      Object.assign(p, changes)
      storage.projects.update(p.uid, changes).catch(() => {})
    }

    const lang = get().language
    set({
      _projectsRaw: projects,
      projects: projects.map((p) => projectToItem(p, lang)),
      projectsLoaded: true,
    })
  },

  addProject: async (name, description, workspaceId?, projectId?) => {
    const uid = crypto.randomUUID()
    const now = new Date().toISOString()
    const lang = get().language
    const project: Project = {
      uid,
      entityId: projectId || undefined,
      projectId: projectId || undefined,
      workspaceId,
      name: { [lang]: name },
      description: { [lang]: description },
      shortDescription: {},
      config: {},
      ownerId: get().user?.id ?? 0,
      ...stampAuthored(),
      ...stampLineage(),
      version: '0.1.0',
      createdAt: now,
      updatedAt: now,
    }
    await getStorage().projects.create(project)
    set((s) => ({
      _projectsRaw: [...s._projectsRaw, project],
      projects: [...s.projects, projectToItem(project, s.language)],
    }))
    return uid
  },

  getWorkspaceProjects: (workspaceId) => {
    const lang = get().language
    return get()._projectsRaw
      .filter((p) => p.workspaceId === workspaceId)
      .map((p) => projectToItem(p, lang))
  },

  updateProject: async (uid, name, description) => {
    const lang = get().language
    const raw = get()._projectsRaw.find((p) => p.uid === uid)
    if (!raw) return

    const updatedName = { ...raw.name, [lang]: name }
    const updatedDesc = { ...raw.description, [lang]: description }
    await getStorage().projects.update(uid, { name: updatedName, description: updatedDesc })

    const updatedProject = { ...raw, name: updatedName, description: updatedDesc, updatedAt: new Date().toISOString() }
    set((s) => {
      const newRaw = s._projectsRaw.map((p) => (p.uid === uid ? updatedProject : p))
      return {
        _projectsRaw: newRaw,
        projects: newRaw.map((p) => projectToItem(p, s.language)),
        activeProjectName: s.activeProjectUid === uid ? name : s.activeProjectName,
      }
    })
  },

  updateProjectTodos: (uid, todos) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, todos } : p
      ),
    }))
    getStorage().projects.update(uid, { todos })
  },

  updateProjectNotes: (uid, notes) => {
    const lang = get().language
    let next: LocalizedString | undefined
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) => {
        if (p.uid !== uid) return p
        next = setLocalized(p.notes, lang, notes)
        return { ...p, notes: next }
      }),
    }))
    if (next) getStorage().projects.update(uid, { notes: next })
  },

  updateProjectReadme: (uid, readme) => {
    const lang = get().language
    let next: LocalizedString | undefined
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) => {
        if (p.uid !== uid) return p
        next = setLocalized(p.readme, lang, readme)
        return { ...p, readme: next }
      }),
    }))
    if (next) getStorage().projects.update(uid, { readme: next })
  },

  updateProjectLicense: async (uid, license) => {
    const next = license ?? undefined
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) => (p.uid === uid ? { ...p, license: next } : p)),
    }))
    await getStorage().projects.update(uid, { license: next })
  },


  restoreReadmeVersion: () => {
    // No-op in local mode — readme history requires backend
  },

  updateProjectStatus: (uid, status) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, status } : p
      ),
    }))
    getStorage().projects.update(uid, { status })
  },

  updateProjectBadges: (uid, badges) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, badges } : p
      ),
    }))
    getStorage().projects.update(uid, { badges })
  },

  updateProjectVersion: (uid, version) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, version } : p
      ),
    }))
    getStorage().projects.update(uid, { version })
  },

  updateProjectOrganization: (uid, organization) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, organization } : p
      ),
    }))
    getStorage().projects.update(uid, { organization })
  },

  updateProjectAuthoring: async (uid, patch) => {
    set((s) => {
      const newRaw = s._projectsRaw.map((p) => (p.uid === uid ? { ...p, ...patch } : p))
      return { _projectsRaw: newRaw, projects: newRaw.map((p) => projectToItem(p, s.language)) }
    })
    await getStorage().projects.update(uid, patch)
  },

  updateProjectCatalogVisibility: (uid, catalogVisibility) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, catalogVisibility } : p
      ),
    }))
    getStorage().projects.update(uid, { catalogVisibility })
  },

  updateProjectPaths: async (uid, patch) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, ...patch } : p
      ),
    }))
    await getStorage().projects.update(uid, patch)
  },

  toggleVersionedDataFile: async (uid, path) => {
    // The set of data files marked "to version" lives in project.config
    // (versionedDataFiles) so it persists and travels with the export. Toggling
    // adds/removes the dataset-relative path; the export then re-includes exactly
    // these via .gitignore !path exceptions.
    const project = get()._projectsRaw.find((p) => p.uid === uid)
    if (!project) return
    const config = (project.config ?? {}) as Record<string, unknown>
    const current = Array.isArray(config.versionedDataFiles)
      ? (config.versionedDataFiles as string[]).filter((p) => typeof p === 'string')
      : []
    const next = current.includes(path)
      ? current.filter((p) => p !== path)
      : [...current, path]
    const newConfig = { ...config, versionedDataFiles: next }
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, config: newConfig } : p
      ),
    }))
    await getStorage().projects.update(uid, { config: newConfig })
    // The .gitignore exceptions derive from this list, so a stale Versioning panel
    // would still show the pre-toggle tree — force it to recompute on next view.
    const { useGitSyncStore } = await import('./git-sync-store')
    useGitSyncStore.getState().markStale()
  },

  toggleExcludedFile: async (uid, path) => {
    // The mirror of versionedDataFiles for NON-data files: a code file is
    // versioned by default; listing its export tree path here excludes it (the
    // export gitignores it and omits it from the tree). Toggling adds/removes it.
    const project = get()._projectsRaw.find((p) => p.uid === uid)
    if (!project) return
    const config = (project.config ?? {}) as Record<string, unknown>
    const current = Array.isArray(config.excludedFiles)
      ? (config.excludedFiles as string[]).filter((p) => typeof p === 'string')
      : []
    const next = current.includes(path)
      ? current.filter((p) => p !== path)
      : [...current, path]
    const newConfig = { ...config, excludedFiles: next }
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, config: newConfig } : p
      ),
    }))
    await getStorage().projects.update(uid, { config: newConfig })
    // Same as versioned data files: the export tree (and its .gitignore) changes,
    // so drop the cached Versioning status.
    const { useGitSyncStore } = await import('./git-sync-store')
    useGitSyncStore.getState().markStale()
  },

  deleteProject: async (uid) => {
    const storage = getStorage()
    await deleteProjectData(storage, uid)
    await storage.projects.delete(uid)
    set((s) => ({
      _projectsRaw: s._projectsRaw.filter((p) => p.uid !== uid),
      projects: s.projects.filter((p) => p.uid !== uid),
      activeProjectUid: s.activeProjectUid === uid ? null : s.activeProjectUid,
      activeProjectName: s.activeProjectUid === uid ? null : s.activeProjectName,
    }))
  },

  // Data source linking
  //
  // `linkedDataSourceRefs` is kept index-aligned with `linkedDataSourceIds`: the
  // ids are local UUIDs stripped from every export, and the pointers are what
  // travels in their place. A database carrying neither lineage nor slug yields
  // an empty pointer rather than shortening the list, so the two stay parallel
  // and unlinking one never shifts another's pointer onto the wrong database.
  linkDataSource: async (projectUid, dataSourceId) => {
    // Dynamic import for the same reason as the workspace store above:
    // data-source-store imports this module, so a static one would be a cycle.
    const { useDataSourceStore } = await import('./data-source-store')
    const pointer = buildPointer(useDataSourceStore.getState().dataSources, dataSourceId) ?? {}
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) => {
        if (p.uid !== projectUid) return p
        const ids = p.linkedDataSourceIds ?? []
        if (ids.includes(dataSourceId)) return p
        return {
          ...p,
          linkedDataSourceIds: [...ids, dataSourceId],
          linkedDataSourceRefs: [...(p.linkedDataSourceRefs ?? []), pointer],
        }
      }),
    }))
    const project = get()._projectsRaw.find((p) => p.uid === projectUid)
    if (project) {
      await getStorage().projects.update(projectUid, {
        linkedDataSourceIds: project.linkedDataSourceIds,
        linkedDataSourceRefs: project.linkedDataSourceRefs,
      })
    }
  },

  unlinkDataSource: (projectUid, dataSourceId) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) => {
        if (p.uid !== projectUid) return p
        const ids = p.linkedDataSourceIds ?? []
        const refs = p.linkedDataSourceRefs ?? []
        const keep = ids.flatMap((id, i) => (id === dataSourceId ? [] : [i]))
        return {
          ...p,
          linkedDataSourceIds: keep.map((i) => ids[i]),
          linkedDataSourceRefs: keep.map((i) => refs[i] ?? {}),
        }
      }),
    }))
    const project = get()._projectsRaw.find((p) => p.uid === projectUid)
    if (project) {
      getStorage().projects.update(projectUid, {
        linkedDataSourceIds: project.linkedDataSourceIds,
        linkedDataSourceRefs: project.linkedDataSourceRefs,
      })
    }
  },

  getProjectLinkedDataSourceIds: (projectUid) => {
    const project = get()._projectsRaw.find((p) => p.uid === projectUid)
    return project?.linkedDataSourceIds ?? []
  },

  // Users (not persisted yet)
  users: [
    { id: 1, username: 'admin', firstName: '', lastName: '', role: 'admin' },
  ],
  addUser: (user) =>
    set((s) => ({
      users: [...s.users, { ...user, id: nextUserId++ }],
    })),
  deleteUser: (id) =>
    set((s) => ({
      users: s.users.filter((u) => u.id !== id),
    })),

  // Active project
  activeProjectUid: null,
  activeProjectName: null,
  openProject: (uid, name) => {
    // Auto-set active workspace if the project belongs to one
    const project = get()._projectsRaw.find((p) => p.uid === uid)
    if (project?.workspaceId && _useWorkspaceStore) {
      const wsState = _useWorkspaceStore.getState()
      if (wsState.activeWorkspaceId !== project.workspaceId) {
        const ws = wsState._workspacesRaw.find((w: Workspace) => w.id === project.workspaceId)
        if (ws) {
          const lang = get().language
          const wsName = ws.name[lang] ?? ws.name['en'] ?? Object.values(ws.name)[0] ?? ''
          // Set workspace directly without calling closeProject (would loop)
          _useWorkspaceStore.setState({ activeWorkspaceId: ws.id, activeWorkspaceName: wsName })
        }
      }
    }
    set({ activeProjectUid: uid, activeProjectName: name })
  },
  closeProject: () =>
    set({ activeProjectUid: null, activeProjectName: null }),

  // Language
  language: (prefs.language as Language) ?? 'en',
  setLanguage: (lang) =>
    set((s) => ({
      language: lang,
      projects: s._projectsRaw.map((p) => projectToItem(p, lang)),
    })),

  // Theme
  darkMode: prefs.darkMode ?? false,
  toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),

  // Editor settings
  editorSettings: prefs.editorSettings ?? defaultEditorSettings,
  updateEditorSettings: (settings) =>
    set((s) => ({
      editorSettings: { ...s.editorSettings, ...settings },
    })),

  // Notifications
  dismissSeedUpdateNotifications: prefs.dismissSeedUpdateNotifications ?? false,
  setDismissSeedUpdateNotifications: (value) => set({ dismissSeedUpdateNotifications: value }),

  // UI state
  sidebarCollapsed: prefs.sidebarCollapsed ?? false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  bottomPanelOpen: false,
  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),

  bottomPanelHeight: 250,
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: height }),
}))

// Persist preferences to localStorage on change
useAppStore.subscribe((state) => {
  savePreferences({
    language: state.language,
    darkMode: state.darkMode,
    editorSettings: state.editorSettings,
    sidebarCollapsed: state.sidebarCollapsed,
    dismissSeedUpdateNotifications: state.dismissSeedUpdateNotifications,
    userFirstName: state.user?.firstName,
    userLastName: state.user?.lastName,
    userEmail: state.user?.email,
    userAffiliation: state.user?.affiliation,
    userProfession: state.user?.profession,
    userOrcid: state.user?.orcid,
  })
})

/** Snapshot the current user as creator provenance for a freshly created entity.
 *  Usable outside React (e.g. inside store actions and Create dialogs). */
export function stampAuthored(): Authored {
  const s = useAppStore.getState()
  return {
    createdById: s.user?.id,
    createdBy: s.getUserDisplayName(),
    createdByDetails: s.getAuthorDetails(),
  }
}

/** Mint a fresh cross-instance lineage identity for a newly created entity.
 *  A brand-new element starts its own lineage (no parent). Duplicates/forks
 *  should instead set parentLineageId to the source's lineageId and mint a new
 *  lineageId themselves — see the import/duplicate paths. */
export function stampLineage(): Lineaged {
  return { lineageId: crypto.randomUUID() }
}
