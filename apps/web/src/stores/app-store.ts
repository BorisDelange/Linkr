import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { slugifyId } from '@/lib/slugify-id'
import type { Project, Workspace, Organization, Language, TodoItem, ProjectStatus, ProjectBadge, OrganizationInfo, CatalogVisibility } from '@/types'

// Lazy reference to break circular dependency with workspace-store at module init time.
// Populated via registerWorkspaceStore() called from workspace-store.ts after it's created.
let _useWorkspaceStore: any = null
export function registerWorkspaceStore(store: any) {
  _useWorkspaceStore = store
}

interface AuthUser {
  id: number
  username: string
  firstName: string
  lastName: string
  role: string
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
  userFirstName?: string
  userLastName?: string
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
const DEMO_ACTIVITY_UID = '00000000-0000-0000-0000-000000000005'
const DEMO_WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const DEMO_ORG_ID = '00000000-0000-0000-0000-000000000020'
const DEMO_DATASOURCE_ID = '00000000-0000-0000-0000-000000000002'

function createDemoOrganization(): Organization {
  return {
    id: DEMO_ORG_ID,
    name: 'Demo Hospital',
    type: 'hospital',
    createdAt: '2026-02-10T00:00:00.000Z',
    updatedAt: '2026-02-10T00:00:00.000Z',
  }
}

function createDemoWorkspace(): Workspace {
  return {
    id: DEMO_WORKSPACE_ID,
    name: {
      en: 'Demo ICU Research',
      fr: 'Recherche Réanimation Demo',
    },
    description: {
      en: 'Retrospective studies on ICU patient outcomes using the MIMIC-IV demo dataset.',
      fr: 'Études rétrospectives sur le devenir des patients de réanimation à partir du jeu de données MIMIC-IV demo.',
    },
    organizationId: DEMO_ORG_ID,
    createdAt: '2026-02-10T00:00:00.000Z',
    updatedAt: '2026-02-10T00:00:00.000Z',
  }
}

function createDemoProject(): Project {
  return {
    uid: DEMO_UID,
    projectId: 'icu-mortality-prediction',
    workspaceId: DEMO_WORKSPACE_ID,
    name: { en: 'ICU Mortality Prediction', fr: 'Prédiction de mortalité en réanimation' },
    description: {
      en: 'Predict in-hospital mortality from the first 24 hours of ICU stay using MIMIC-IV demo data (100 patients, OMOP CDM).',
      fr: 'Prédire la mortalité hospitalière à partir des 24 premières heures de séjour en réanimation avec les données MIMIC-IV demo (100 patients, OMOP CDM).',
    },
    shortDescription: {},
    config: {},
    ownerId: 1,
    status: 'active',
    badges: [
      { id: 'b1', label: 'ICU', color: 'red' },
    ],
    todos: [],
    notes: '',
    readme: `# Early Prediction of In-Hospital Mortality in the ICU Using First-24-Hour Data

## Background

Mortality prediction in the intensive care unit (ICU) is central to clinical decision-making, resource allocation, and benchmarking of care quality. Established severity scores — APACHE II, SAPS II, SOFA — have been widely adopted but present well-known limitations: they were developed on historical cohorts, rely on fixed variable sets, and use pre-defined weighting schemes that do not adapt to local case-mix. Several studies have shown that logistic regression and machine learning models trained on routinely collected electronic health record (EHR) data can match or outperform these traditional scores.

This project explores whether predictive models fitted on variables available within the **first 24 hours** of ICU admission can effectively discriminate between survivors and non-survivors — using only data from the OMOP Common Data Model.

## Objective

Develop and evaluate predictive models for **in-hospital mortality** among ICU patients, using demographics and physiological measurements collected during the first 24 hours of stay (H0–H24).

## Data

The dataset is the **MIMIC-IV demo** (version 2.2), a freely available subset of the MIMIC-IV clinical database, mapped to the **OMOP CDM v5.4** format. It contains 100 unique patients with ICU stays at Beth Israel Deaconess Medical Center (Boston, USA).

After applying inclusion criteria (hospital stay $\\geq$ 24 h, at least one measurement in H0–H24), the final cohort comprises **242 ICU visits** from 100 patients, with **13 deaths** (5.4% mortality rate).

## Scripts

The project contains two **self-contained study notebooks** and three **example scripts** (one per file type).

### 1. Exploratory Data Analysis (\`01_eda_mortality.ipynb\`)

**Self-contained** Jupyter notebook performing the full EDA pipeline:

- OMOP concept exploration (domains, vocabularies, available measurements)
- Cohort extraction via SQL (eligible visits $\\geq$ 24h, mortality flag, demographics)
- Feature engineering (H0–H24 measurements: vitals mean/min/max, labs first value, GCS worst)
- Wide-format dataset export (one row per visit, ~45 features)
- Cohort overview: demographics, age/sex distributions, admission timeline
- Feature distributions by outcome (vitals, labs, GCS)
- Missing data analysis and patterns by outcome
- Correlation matrix and multicollinearity detection
- Table 1 with descriptive statistics
- Univariate associations (point-biserial correlation)
- Outlier detection with clinical plausibility ranges

### 2. Machine Learning Pipeline (\`02_ml_mortality.qmd\`)

**Self-contained** Quarto R report with full ML pipeline:

- Cohort extraction & feature engineering (same as notebook 1)
- Data preparation: feature selection, median imputation
- Train/test split (75/25 stratified)
- Logistic regression (baseline) with odds ratios
- Decision tree (rpart)
- Model comparison: ROC curves, confusion matrix
- Calibration analysis
- Feature importance (standardized coefficients + tree importance)
- Threshold analysis (sensitivity/specificity/F1 trade-offs)

### 3–5. Example scripts

Standalone examples demonstrating each file type (each can be run independently):

| Script | Language | Description |
|---|---|---|
| \`03_example.sql\` | SQL | Cohort extraction from OMOP CDM tables |
| \`04_example.py\` | Python | Cohort + feature engineering + CSV export (\`sql_query()\` + pandas) |
| \`05_example.R\` | R | Cohort + feature engineering + statistics + logistic regression (\`sql_query()\`) |

## Features extracted

| Category | Variables | Aggregation |
|---|---|---|
| **Vital signs** (7) | Heart rate, SBP, DBP, MBP, respiratory rate, SpO$_2$, temperature | Mean, min, max |
| **Laboratory** (15) | Hemoglobin, hematocrit, platelets, WBC, Na, K, Cl, HCO$_3$, creatinine, BUN, glucose, anion gap, Ca, Mg, phosphate | First value |
| **Neurological** (3) | GCS eye, verbal, motor | Minimum |

The OMOP long-format data is pivoted into a **one-row-per-visit wide dataset** (242 rows $\\times$ ~45 columns).

## Limitations

- **Small sample size**: 100 patients / 13 deaths limits statistical power and generalizability
- **Demo dataset**: MIMIC-IV demo is a convenience sample
- **Single-center data**: Beth Israel Deaconess Medical Center only
- **H0–H24 only**: no time-series modeling, no features after 24h
- **Median imputation**: simple approach, no multiple imputation
- **No external validation**: single-center, no temporal split

## References

1. Johnson, A. et al. *MIMIC-IV, a freely accessible electronic health record dataset.* Sci Data 10, 1 (2023).
2. Knaus, W.A. et al. *APACHE II: a severity of disease classification system.* Crit Care Med 13, 818–829 (1985).
3. Le Gall, J.R. et al. *A new Simplified Acute Physiology Score (SAPS II).* JAMA 270, 2957–2963 (1993).
`,
    createdAt: '2026-02-10T00:00:00.000Z',
    updatedAt: '2026-02-10T00:00:00.000Z',
  }
}

function createDemoActivityProject(): Project {
  return {
    uid: DEMO_ACTIVITY_UID,
    projectId: 'icu-activity-dashboard',
    workspaceId: DEMO_WORKSPACE_ID,
    name: {
      en: 'ICU Activity Dashboard',
      fr: 'Tableau de bord d\'activité de réanimation',
    },
    description: {
      en: 'ICU activity indicators extracted from MIMIC-IV demo data: demographics, admissions, mechanical ventilation, infections, and procedures.',
      fr: 'Indicateurs d\'activité de réanimation extraits des données MIMIC-IV demo : démographie, admissions, ventilation mécanique, infections et procédures.',
    },
    shortDescription: {},
    config: {},
    ownerId: 1,
    status: 'active',
    badges: [
      { id: 'b1', label: 'ICU', color: 'red' },
      { id: 'b2', label: 'Dashboard', color: 'blue' },
    ],
    todos: [],
    notes: '',
    linkedDataSourceIds: [DEMO_DATASOURCE_ID],
    readme: `# ICU Activity Dashboard

## Overview

This project provides an **ICU activity monitoring dashboard** built from the MIMIC-IV demo database (100 patients, OMOP CDM format). It extracts key clinical indicators from routine electronic health record data and presents them as a set of interactive visualizations.

## Data

The dataset is extracted from the **MIMIC-IV Demo** mapped to **OMOP CDM v5.4**. The extraction pipeline:

1. **Identifies ICU stays** from \`visit_detail\` + \`care_site\` (172 stays across 7 ICU units)
2. **Joins demographics** (age, sex, race) from \`person\`
3. **Extracts measurements** (vitals, labs, ventilation parameters) from \`measurement\`
4. **Detects events**: mechanical ventilation, infections, procedures from OMOP clinical tables
5. **Outputs a long-typed CSV** with stay-level and event-level rows

## Indicator Domains

| Domain | Key Indicators |
|---|---|
| **Demographics** | Age distribution, sex ratio, mortality rate (ICU / hospital) |
| **Admissions & Flow** | Admission timeline, length of stay, ICU unit distribution, readmissions <48h |
| **Mechanical Ventilation** | Ventilation rate, duration, tidal volume/PBW, PEEP, FiO₂ |
| **Infections** | Infection types (sepsis, pneumonia, UTI), pathogen distribution |
| **Procedures** | CVC, PICC, arterial lines, tracheostomy, extubation |

## Scripts

| Script | Description |
|---|---|
| \`01_extract_icu_data.sql\` | SQL queries to identify ICU stays and extract clinical data from OMOP tables |
| \`02_build_dataset.py\` | Python pipeline to build the wide-format analytical dataset |

## Key Figures (MIMIC-IV Demo)

- **172 ICU stays** from **100 patients**
- **7 ICU units**: MICU, SICU, CVICU, CCU, TSICU, MICU/SICU, Neuro SICU
- **43% mechanically ventilated** (median 25.4h)
- **7.6% ICU mortality**, 13.4% hospital mortality
- **23% readmissions** within 48h
`,
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
  updateUser: (changes: Partial<Pick<AuthUser, 'firstName' | 'lastName'>>) => void
  /** Get display name: "First Last", or username if no name set. */
  getUserDisplayName: () => string

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
  user: { id: 1, username: 'admin', firstName: prefs.userFirstName ?? '', lastName: prefs.userLastName ?? '', role: 'admin' },
  login: (user) => set({ user }),
  logout: () => set({ user: null }),
  updateUser: (changes) => set((s) => {
    if (!s.user) return s
    return { user: { ...s.user, ...changes } }
  }),
  getUserDisplayName: () => {
    const u = get().user
    if (!u) return ''
    const full = `${u.firstName} ${u.lastName}`.trim()
    return full || u.username
  },

  // Projects
  _projectsRaw: [],
  projects: [],
  projectsLoaded: false,

  loadProjects: async () => {
    const storage = getStorage()
    let projects = await storage.projects.getAll()

    // Seed demo workspace + project on first launch
    if (projects.length === 0 && !localStorage.getItem(SEED_KEY)) {
      try {
        const demoOrg = createDemoOrganization()
        await storage.organizations.create(demoOrg)
        const demoWs = createDemoWorkspace()
        await storage.workspaces.create(demoWs)
        const demo = createDemoProject()
        await storage.projects.create(demo)
        const demoActivity = createDemoActivityProject()
        await storage.projects.create(demoActivity)
        projects = [demo, demoActivity]
        // Reload org + workspace stores so they pick up the seeded data
        const { useOrganizationStore } = await import('./organization-store')
        useOrganizationStore.getState().loadOrganizations()
        const { useWorkspaceStore } = await import('./workspace-store')
        useWorkspaceStore.getState().loadWorkspaces()
      } catch {
        // Demo data may already exist in IndexedDB from a previous session
      }
      localStorage.setItem(SEED_KEY, '1')
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
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, notes } : p
      ),
    }))
    getStorage().projects.update(uid, { notes })
  },

  updateProjectReadme: (uid, readme) => {
    set((s) => ({
      _projectsRaw: s._projectsRaw.map((p) =>
        p.uid === uid ? { ...p, readme } : p
      ),
    }))
    getStorage().projects.update(uid, { readme })
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
    userFirstName: state.user?.firstName,
    userLastName: state.user?.lastName,
  })
})
