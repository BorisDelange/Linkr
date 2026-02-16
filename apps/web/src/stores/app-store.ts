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

This project explores whether a **simple logistic regression model**, fitted on variables available within the **first 24 hours** of ICU admission, can effectively discriminate between survivors and non-survivors — using only data from the OMOP Common Data Model.

## Objective

Develop and evaluate a predictive model for **in-hospital mortality** among ICU patients, using demographics and physiological measurements collected during the first 24 hours of stay (H0–H24).

## Data

The dataset is the **MIMIC-IV demo** (version 2.2), a freely available subset of the MIMIC-IV clinical database, mapped to the **OMOP CDM v5.4** format. It contains 100 unique patients with ICU stays at Beth Israel Deaconess Medical Center (Boston, USA).

After applying inclusion criteria (hospital stay $\\geq$ 24 h, at least one measurement in H0–H24), the final cohort comprises **242 ICU visits** from 100 patients, with **13 deaths** (5.4% mortality rate).

## Methods

The analysis pipeline consists of three sequential scripts:

### 1. Cohort extraction (\`01_cohort_extraction.sql\`)

- Select hospital stays with length of stay $\\geq$ 24 hours
- Require at least one recorded measurement in the H0–H24 window
- Compute demographics (age, sex), length of stay, and in-hospital mortality flag (death occurring between admission and discharge + 1 day)

### 2. Feature engineering (\`02_feature_engineering.py\`)

Extract and aggregate measurements from the first 24 hours:

| Category | Variables | Aggregation |
|---|---|---|
| **Vital signs** (7) | Heart rate, SBP, DBP, MBP, respiratory rate, SpO$_2$, temperature | Mean, min, max |
| **Laboratory** (15) | Hemoglobin, hematocrit, platelets, WBC, Na, K, Cl, HCO$_3$, creatinine, BUN, glucose, anion gap, Ca, Mg, phosphate | First value |
| **Neurological** (3) | GCS eye, verbal, motor | Minimum |

The OMOP long-format data is pivoted into a **one-row-per-visit wide dataset** (242 rows $\\times$ 45 columns).

### 3. Statistical analysis (\`03_analysis.R\`)

- **Descriptive statistics** (Table 1): comparison of survivors vs. non-survivors using Wilcoxon rank-sum tests
- **Logistic regression**: features with < 30% missing data are selected (16 / 40 features), missing values imputed by median, binary outcome modeled with \`glm(..., family = binomial)\`
- **Evaluation**: ROC curve and AUC, confusion matrix at threshold 0.5

## Results

### Population characteristics

|  | Survivors (n = 229) | Non-survivors (n = 13) | p-value |
|---|---|---|---|
| Age, years | 62.1 (14.7) | 70.1 (11.9) | 0.048 |
| Length of stay, hours | 180.4 (157.3) | 247.8 (185.5) | 0.085 |
| Creatinine, mg/dL | 1.6 (1.9) | 2.1 (1.5) | 0.014 |
| Potassium, mEq/L | 4.3 (0.8) | 5.0 (0.7) | 0.001 |
| Glucose, mg/dL | 165.6 (120.4) | 181.8 (47.8) | 0.018 |
| BUN, mg/dL | 26.1 (21.2) | 39.8 (23.4) | 0.014 |

Values are mean (SD).

Non-survivors were significantly **older** (70.1 vs. 62.1 years, p = 0.048) and presented with higher **creatinine** (p = 0.014), **potassium** (p = 0.001), **glucose** (p = 0.018), and **BUN** (p = 0.014) levels at admission.

### Model performance

The logistic regression model achieved an **AUC of 0.923**, indicating excellent discrimination. Significant predictors at the $\\alpha$ = 0.01 level were:

- **Sex** (male, OR increased, p = 0.008)
- **Age** (p = 0.009)
- **Creatinine** (p = 0.003)

Confusion matrix at threshold 0.5:

|  | Predicted alive | Predicted dead |
|---|---|---|
| **Actually alive** | 228 | 1 |
| **Actually dead** | 10 | 3 |

Sensitivity: 23.1% — Specificity: 99.6% — PPV: 75.0%

## Limitations

- **Small sample size**: 100 patients / 13 deaths limits statistical power and generalizability. The high AUC may reflect overfitting.
- **Demo dataset**: MIMIC-IV demo is a convenience sample, not representative of the full MIMIC-IV cohort.
- **No external validation**: the model is evaluated on the training set only (no train/test split given the small sample).
- **Single-center data**: results from Beth Israel Deaconess Medical Center may not transfer to other ICU populations.
- **Simple model**: logistic regression was chosen for interpretability; ensemble methods or neural networks might improve sensitivity.

## References

1. Johnson, A. et al. *MIMIC-IV, a freely accessible electronic health record dataset.* Sci Data 10, 1 (2023).
2. Knaus, W.A. et al. *APACHE II: a severity of disease classification system.* Crit Care Med 13, 818–829 (1985).
3. Le Gall, J.R. et al. *A new Simplified Acute Physiology Score (SAPS II).* JAMA 270, 2957–2963 (1993).
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
