import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { Project, Language, TodoItem, ProjectStatus, ProjectBadge } from '@/types'

interface AuthUser {
  id: number
  username: string
  email: string
  role: string
}

export interface ProjectItem {
  uid: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

export interface ManagedUser {
  id: number
  username: string
  email: string
  role: string
}

export interface EditorSettings {
  fontSize: number
  wordWrap: 'on' | 'off'
  minimap: boolean
  lineNumbers: 'on' | 'off' | 'relative'
  tabSize: number
  theme: 'auto' | 'vs' | 'vs-dark'
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

// --- Demo seed ---

const SEED_KEY = 'linkr-seeded'
const DEMO_UID = '00000000-0000-0000-0000-000000000001'

function createDemoProject(): Project {
  return {
    uid: DEMO_UID,
    name: { en: 'MIMIC-IV Demo', fr: 'Démo MIMIC-IV' },
    description: {
      en: 'Demonstration project with MIMIC-IV data',
      fr: 'Projet de démonstration avec les données MIMIC-IV',
    },
    shortDescription: {},
    config: {},
    ownerId: 1,
    status: 'active',
    badges: [
      { id: 'b1', label: 'ICU', color: 'red' },
      { id: 'b2', label: 'Research', color: 'blue' },
    ],
    todos: [],
    notes: '',
    readme: '## Overview\n\nThis project uses the **MIMIC-IV** clinical database to explore ICU patient outcomes.\n\n### Objectives\n\n- Analyze patient demographics and admission patterns\n- Build patient-level dashboards for clinical review\n- Run cohort analyses on sepsis patients\n\n### Data\n\nThe primary data source is a DuckDB instance loaded with MIMIC-IV OMOP CDM tables (3,421 patients, 12,847 visits).\n',
    createdAt: '2026-02-10T00:00:00.000Z',
    updatedAt: '2026-02-10T00:00:00.000Z',
  }
}

// --- Store ---

interface AppState {
  // Auth
  user: AuthUser | null
  login: (user: AuthUser) => void
  logout: () => void

  // Projects
  _projectsRaw: Project[]
  projects: ProjectItem[]
  projectsLoaded: boolean
  loadProjects: () => Promise<void>
  addProject: (name: string, description: string) => Promise<string>
  updateProject: (uid: string, name: string, description: string) => Promise<void>
  updateProjectTodos: (uid: string, todos: TodoItem[]) => void
  updateProjectNotes: (uid: string, notes: string) => void
  updateProjectReadme: (uid: string, readme: string) => void
  restoreReadmeVersion: (uid: string, snapshotId: string) => void
  updateProjectStatus: (uid: string, status: ProjectStatus) => void
  updateProjectBadges: (uid: string, badges: ProjectBadge[]) => void
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
  user: { id: 1, username: 'admin', email: 'admin@linkr.local', role: 'admin' },
  login: (user) => set({ user }),
  logout: () => set({ user: null }),

  // Projects
  _projectsRaw: [],
  projects: [],
  projectsLoaded: false,

  loadProjects: async () => {
    const storage = getStorage()
    let projects = await storage.projects.getAll()

    // Seed demo project on first launch
    if (projects.length === 0 && !localStorage.getItem(SEED_KEY)) {
      const demo = createDemoProject()
      await storage.projects.create(demo)
      localStorage.setItem(SEED_KEY, '1')
      projects = [demo]
    }

    const lang = get().language
    set({
      _projectsRaw: projects,
      projects: projects.map((p) => projectToItem(p, lang)),
      projectsLoaded: true,
    })
  },

  addProject: async (name, description) => {
    const uid = crypto.randomUUID()
    const now = new Date().toISOString()
    const lang = get().language
    const project: Project = {
      uid,
      name: { [lang]: name },
      description: { [lang]: description },
      shortDescription: {},
      config: {},
      ownerId: get().user?.id ?? 0,
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
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, notes } : p
      ),
    }))
    getStorage().projects.update(uid, { notes })
  },

  updateProjectReadme: (uid, readme) => {
    const snapshot = {
      id: `rs-${Date.now()}`,
      content: readme,
      savedAt: new Date().toISOString(),
    }
    let readmeHistory: Project['readmeHistory']
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) => {
        if (p.uid !== uid) return p
        readmeHistory = [...(p.readmeHistory ?? []), snapshot]
        return { ...p, readme, readmeHistory }
      }),
    }))
    getStorage().projects.update(uid, { readme, readmeHistory: readmeHistory! })
  },

  restoreReadmeVersion: (uid, snapshotId) => {
    const project = get()._projectsRaw.find((p) => p.uid === uid)
    const snapshot = project?.readmeHistory?.find((h) => h.id === snapshotId)
    if (!snapshot) return
    const newSnapshot = {
      id: `rs-${Date.now()}`,
      content: snapshot.content,
      savedAt: new Date().toISOString(),
    }
    let readmeHistory: Project['readmeHistory']
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) => {
        if (p.uid !== uid) return p
        readmeHistory = [...(p.readmeHistory ?? []), newSnapshot]
        return { ...p, readme: snapshot.content, readmeHistory }
      }),
    }))
    getStorage().projects.update(uid, { readme: snapshot.content, readmeHistory: readmeHistory! })
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

  deleteProject: async (uid) => {
    await getStorage().projects.delete(uid)
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
    { id: 1, username: 'admin', email: 'admin@linkr.local', role: 'admin' },
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
  openProject: (uid, name) =>
    set({ activeProjectUid: uid, activeProjectName: name }),
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
  })
})
