import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { apiRequest, isServerMode } from '@/lib/api-client'
import { deleteProjectData } from '@/lib/entity-io'
import { slugifyId } from '@/lib/slugify-id'
import { setLocalized, toLocalized, isShellHtml } from '@/lib/localized'
import { seedWorkspaces, isSeeded } from '@/lib/seed-loader'
import type { Project, Workspace, Language, LocalizedString, TodoItem, ProjectStatus, ProjectBadge, OrganizationInfo, CatalogVisibility, AuthorDetails, Authored } from '@/types'

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
  affiliation?: string
  profession?: string
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

export interface EditorSettings {
  fontSize: number
  wordWrap: 'on' | 'off'
  minimap: boolean
  lineNumbers: 'on' | 'off' | 'relative'
  tabSize: number
  theme: 'auto' | 'linkr-light' | 'linkr-dark' | 'vs' | 'vs-dark'
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
  userAffiliation?: string
  userProfession?: string
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
  return {
    uid: project.uid,
    name: project.name[lang] ?? project.name['en'] ?? Object.values(project.name)[0] ?? '',
    description: project.description[lang] ?? project.description['en'] ?? Object.values(project.description)[0] ?? '',
    createdAt: project.createdAt.split('T')[0],
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
  updateUser: (changes: Partial<Pick<AuthUser, 'firstName' | 'lastName' | 'affiliation' | 'profession' | 'orcid'>>) => void
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

  restoreReadmeVersion: (uid: string, snapshotId: string) => void
  updateProjectStatus: (uid: string, status: ProjectStatus) => void
  updateProjectBadges: (uid: string, badges: ProjectBadge[]) => void
  updateProjectOrganization: (uid: string, org: OrganizationInfo | undefined) => void
  updateProjectCatalogVisibility: (uid: string, visibility: CatalogVisibility) => void
  getWorkspaceProjects: (workspaceId: string) => ProjectItem[]
  deleteProject: (uid: string) => Promise<void>

  // Data source linking (app-level databases ↔ projects)
  linkDataSource: (projectUid: string, dataSourceId: string) => void
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
  theme: 'auto',
  autoSave: false,
  autoSaveDelay: 1000,
}

const prefs = loadPreferences()

let nextUserId = 2

export const useAppStore = create<AppState>((set, get) => ({
  user: { id: 1, username: 'admin', firstName: prefs.userFirstName ?? '', lastName: prefs.userLastName ?? '', role: 'admin', affiliation: prefs.userAffiliation ?? '', profession: prefs.userProfession ?? '', orcid: prefs.userOrcid ?? '' },
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
    const details: AuthorDetails = {}
    if (u.firstName?.trim()) details.firstName = u.firstName.trim()
    if (u.lastName?.trim()) details.lastName = u.lastName.trim()
    if (u.affiliation?.trim()) details.affiliation = u.affiliation.trim()
    if (u.profession?.trim()) details.profession = u.profession.trim()
    if (u.orcid?.trim()) details.orcid = u.orcid.trim()
    return details
  },

  // Projects
  _projectsRaw: [],
  projects: [],
  projectsLoaded: false,

  loadProjects: async () => {
    const storage = getStorage()
    let projects = await storage.projects.getAll()

    // Seed workspaces from public/data/seed/ on first launch only (never re-seed)
    const workspaces = await storage.workspaces.getAll()
    if (projects.length === 0 && workspaces.length === 0 && !isSeeded()) {
      try {
        await seedWorkspaces()
        projects = await storage.projects.getAll()

        const { useOrganizationStore } = await import('./organization-store')
        useOrganizationStore.getState().loadOrganizations()
        const { useWorkspaceStore } = await import('./workspace-store')
        useWorkspaceStore.getState().loadWorkspaces()
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

    // Migration: assign projectId to projects that don't have one
    const usedIds = new Set(projects.filter(p => p.projectId).map(p => p.projectId!))
    for (const p of projects) {
      if (p.projectId) continue
      const name = typeof p.name === 'string' ? p.name : (p.name.en || p.name.fr || Object.values(p.name)[0] || 'project')
      let candidate = slugifyId(name) || 'project'
      if (candidate.length < 2) candidate = `project-${candidate}`
      let id = candidate
      let suffix = 2
      while (usedIds.has(id)) { id = `${candidate}-${suffix++}` }
      p.projectId = id
      usedIds.add(id)
      storage.projects.update(p.uid, { projectId: id }).catch(() => {})
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
      projectId: projectId || undefined,
      workspaceId,
      name: { [lang]: name },
      description: { [lang]: description },
      shortDescription: {},
      config: {},
      ownerId: get().user?.id ?? 0,
      ...stampAuthored(),
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

  updateProjectOrganization: (uid, organization) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, organization } : p
      ),
    }))
    getStorage().projects.update(uid, { organization })
  },

  updateProjectCatalogVisibility: (uid, catalogVisibility) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, catalogVisibility } : p
      ),
    }))
    getStorage().projects.update(uid, { catalogVisibility })
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
  linkDataSource: (projectUid, dataSourceId) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) => {
        if (p.uid !== projectUid) return p
        const ids = p.linkedDataSourceIds ?? []
        if (ids.includes(dataSourceId)) return p
        return { ...p, linkedDataSourceIds: [...ids, dataSourceId] }
      }),
    }))
    const project = get()._projectsRaw.find((p) => p.uid === projectUid)
    if (project) {
      getStorage().projects.update(projectUid, { linkedDataSourceIds: project.linkedDataSourceIds })
    }
  },

  unlinkDataSource: (projectUid, dataSourceId) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) => {
        if (p.uid !== projectUid) return p
        const ids = p.linkedDataSourceIds ?? []
        return { ...p, linkedDataSourceIds: ids.filter((id) => id !== dataSourceId) }
      }),
    }))
    const project = get()._projectsRaw.find((p) => p.uid === projectUid)
    if (project) {
      getStorage().projects.update(projectUid, { linkedDataSourceIds: project.linkedDataSourceIds })
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
    userAffiliation: state.user?.affiliation,
    userProfession: state.user?.profession,
    userOrcid: state.user?.orcid,
  })
})

/** Snapshot the current user as creator provenance for a freshly created entity.
 *  Usable outside React (e.g. inside store actions and Create dialogs). */
export function stampAuthored(): Authored {
  const s = useAppStore.getState()
  return { createdBy: s.getUserDisplayName(), createdByDetails: s.getAuthorDetails() }
}
