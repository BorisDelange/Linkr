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
  /** The source code that was executed. */
  code?: string
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

// Bump this version whenever default demo file content changes.
// On load, if the user's stored files still have a previous version,
// the default file contents are silently updated in IndexedDB.
const DEMO_FILES_VERSION = 3
const DEMO_FILES_VERSION_KEY = 'linkr-demo-files-version'

// Default demo scripts are loaded from public/data/demo-scripts/ at seed time.
// These inline versions serve as fallback when fetching fails.
const DEMO_SQL = `-- 01_cohort_extraction.sql
-- Mortality prediction — Step 1: Cohort extraction
-- Selects hospital stays >= 24h with measurements. Creates VIEW cohort.

CREATE OR REPLACE VIEW eligible_visits AS
SELECT
    v.visit_occurrence_id, v.person_id, v.visit_concept_id,
    v.visit_start_date, v.visit_start_datetime::TIMESTAMP AS visit_start_datetime,
    v.visit_end_date, v.visit_end_datetime::TIMESTAMP AS visit_end_datetime,
    v.discharge_to_concept_id,
    EXTRACT(EPOCH FROM (v.visit_end_datetime::TIMESTAMP - v.visit_start_datetime::TIMESTAMP)) / 3600 AS los_hours
FROM visit_occurrence v
WHERE EXTRACT(EPOCH FROM (v.visit_end_datetime::TIMESTAMP - v.visit_start_datetime::TIMESTAMP)) / 3600 >= 24;

CREATE OR REPLACE VIEW visit_mortality AS
SELECT ev.*,
    CASE WHEN d.death_date IS NOT NULL
         AND d.death_date BETWEEN ev.visit_start_date AND ev.visit_end_date + INTERVAL '1 day'
         THEN 1 ELSE 0 END AS in_hospital_death
FROM eligible_visits ev
LEFT JOIN death d ON ev.person_id = d.person_id;

CREATE OR REPLACE VIEW cohort AS
SELECT vm.visit_occurrence_id, vm.person_id, vm.visit_start_datetime,
    EXTRACT(YEAR FROM vm.visit_start_date) - p.year_of_birth AS age,
    p.gender_source_value AS sex, vm.los_hours, vm.in_hospital_death
FROM visit_mortality vm
JOIN person p ON vm.person_id = p.person_id
WHERE EXISTS (
    SELECT 1 FROM measurement m
    WHERE m.visit_occurrence_id = vm.visit_occurrence_id
      AND m.value_as_number IS NOT NULL
      AND m.measurement_datetime::TIMESTAMP >= vm.visit_start_datetime
      AND m.measurement_datetime::TIMESTAMP <= vm.visit_start_datetime + INTERVAL '24 hours'
);

SELECT COUNT(*) AS n_visits, COUNT(DISTINCT person_id) AS n_patients,
    SUM(in_hospital_death) AS n_deaths,
    ROUND(100.0 * SUM(in_hospital_death) / COUNT(*), 1) AS mortality_pct,
    ROUND(AVG(age), 1) AS mean_age, ROUND(AVG(los_hours), 1) AS mean_los_hours
FROM cohort;
`

const DEMO_PY = [
  '# 02_feature_engineering.py',
  '# Mortality prediction — Step 2: Feature engineering',
  '# Extracts H0-H24 measurements, pivots OMOP long -> wide, exports CSV.',
  '#',
  '# Uses sql_query(sql) which is automatically available in LinkR.',
  '# It queries the active DuckDB connection and returns a pandas DataFrame.',
  '# Usage: df = await sql_query("SELECT * FROM person LIMIT 10")',
  '',
  'import pandas as pd',
  '',
  '# Measurements to extract (concept_id -> column prefix)',
  'VITALS = {',
  '    3027018: "hr", 3004249: "sbp", 3012888: "dbp", 3027598: "mbp",',
  '    3024171: "resp_rate", 40762499: "spo2", 3020891: "temp",',
  '}',
  'LABS = {',
  '    3000963: "hemoglobin", 3023314: "hematocrit", 3024929: "platelets",',
  '    3003282: "wbc", 3019550: "sodium", 3023103: "potassium",',
  '    3014576: "chloride", 3016293: "bicarbonate", 3016723: "creatinine",',
  '    3013682: "bun", 3004501: "glucose", 3037278: "anion_gap",',
  '    3015377: "calcium", 3012095: "magnesium", 3011904: "phosphate",',
  '}',
  'NEURO = {3016335: "gcs_eye", 3009094: "gcs_verbal", 3008223: "gcs_motor"}',
  'ALL_MEASUREMENTS = {**VITALS, **LABS, **NEURO}',
  '',
  '# Step 1: Extract measurements in H0-H24',
  'concept_ids = ", ".join(str(cid) for cid in ALL_MEASUREMENTS.keys())',
  'measurements_h24 = await sql_query(f"""',
  '    SELECT m.visit_occurrence_id, m.measurement_concept_id,',
  '           m.value_as_number, m.measurement_datetime::TIMESTAMP AS measurement_datetime,',
  '           c.visit_start_datetime',
  '    FROM measurement m',
  '    JOIN cohort c ON m.visit_occurrence_id = c.visit_occurrence_id',
  '    WHERE m.measurement_concept_id IN ({concept_ids})',
  '      AND m.value_as_number IS NOT NULL',
  '      AND m.measurement_datetime::TIMESTAMP >= c.visit_start_datetime',
  "      AND m.measurement_datetime::TIMESTAMP <= c.visit_start_datetime + INTERVAL '24 hours'",
  '""")',
  'print(f"Measurements in H0-H24: {len(measurements_h24)} rows")',
  '',
  '# Step 2: Aggregate (vitals: mean/min/max, labs: first, neuro: min)',
  'measurements_h24["feature"] = measurements_h24["measurement_concept_id"].map(ALL_MEASUREMENTS)',
  'vitals_ids, labs_ids, neuro_ids = set(VITALS), set(LABS), set(NEURO)',
  'aggregated_rows = []',
  'for (visit_id, feature), group in measurements_h24.groupby(["visit_occurrence_id", "feature"]):',
  '    cid = group["measurement_concept_id"].iloc[0]',
  '    values = group.sort_values("measurement_datetime")["value_as_number"]',
  '    if cid in vitals_ids:',
  '        for agg, fn in [("mean", values.mean), ("min", values.min), ("max", values.max)]:',
  '            aggregated_rows.append({"visit_occurrence_id": visit_id, "col": f"{feature}_{agg}", "val": fn()})',
  '    elif cid in neuro_ids:',
  '        aggregated_rows.append({"visit_occurrence_id": visit_id, "col": f"{feature}_min", "val": values.min()})',
  '    elif cid in labs_ids:',
  '        aggregated_rows.append({"visit_occurrence_id": visit_id, "col": f"{feature}_first", "val": values.iloc[0]})',
  '',
  'agg_df = pd.DataFrame(aggregated_rows)',
  '',
  '# Step 3: Pivot to wide format',
  'wide = agg_df.pivot_table(index="visit_occurrence_id", columns="col", values="val", aggfunc="first").reset_index()',
  '',
  '# Step 4: Merge with cohort demographics',
  'cohort_df = await sql_query("SELECT visit_occurrence_id, person_id, age, sex, los_hours, in_hospital_death FROM cohort")',
  'dataset = cohort_df.merge(wide, on="visit_occurrence_id", how="left")',
  'id_cols = ["visit_occurrence_id", "person_id"]',
  'demo_cols = ["age", "sex", "los_hours"]',
  'outcome_cols = ["in_hospital_death"]',
  'feature_cols = sorted([c for c in dataset.columns if c not in id_cols + demo_cols + outcome_cols])',
  'dataset = dataset[id_cols + demo_cols + outcome_cols + feature_cols]',
  '',
  'print(f"\\nFinal dataset: {dataset.shape[0]} rows x {dataset.shape[1]} columns")',
  'print(f"Deaths: {int(dataset[\'in_hospital_death\'].sum())} / {len(dataset)}")',
  '',
  '# Step 5: Export CSV',
  'dataset.to_csv("data/datasets/mortality_dataset.csv", index=False)',
  'print("\\nDataset saved to data/datasets/mortality_dataset.csv")',
].join('\n')

const DEMO_R = [
  '# 03_analysis.R',
  '# Mortality prediction — Step 3: Statistical analysis & logistic regression',
  '',
  '# 1. Load data',
  'df <- read.csv("data/datasets/mortality_dataset.csv", stringsAsFactors = FALSE)',
  'cat(sprintf("Dataset: %d rows x %d columns\\n", nrow(df), ncol(df)))',
  'cat(sprintf("Mortality: %d / %d (%.1f%%)\\n\\n", sum(df$in_hospital_death), nrow(df), 100 * mean(df$in_hospital_death)))',
  '',
  '# 2. Descriptive statistics (Table 1)',
  'alive <- df[df$in_hospital_death == 0, ]',
  'dead  <- df[df$in_hospital_death == 1, ]',
  '',
  'describe <- function(var, label = var) {',
  '  a <- alive[[var]]; d <- dead[[var]]',
  '  a <- a[!is.na(a)]; d <- d[!is.na(d)]',
  '  p <- tryCatch(wilcox.test(a, d)$p.value, error = function(e) NA)',
  '  cat(sprintf("%-25s  Alive: %.1f (%.1f)  |  Dead: %.1f (%.1f)  |  p=%.3f\\n",',
  '      label, mean(a), sd(a), mean(d), sd(d), p))',
  '}',
  '',
  'cat("Demographics:\\n")',
  'describe("age", "Age (years)")',
  'describe("los_hours", "Length of stay (h)")',
  '',
  'cat("\\nLaboratory (first value):\\n")',
  'for (v in c("hemoglobin", "creatinine", "potassium", "sodium", "glucose", "bun")) {',
  '  col <- paste0(v, "_first")',
  '  if (col %in% names(df)) describe(col, v)',
  '}',
  '',
  '# 3. Logistic regression',
  'feature_cols <- setdiff(names(df), c("visit_occurrence_id", "person_id", "sex", "los_hours", "in_hospital_death"))',
  'missing_pct <- sapply(df[feature_cols], function(x) mean(is.na(x)))',
  'selected <- names(missing_pct[missing_pct < 0.30])',
  'cat(sprintf("\\nFeatures with <30%% missing: %d / %d\\n", length(selected), length(feature_cols)))',
  '',
  'model_df <- df[, c("in_hospital_death", "sex", selected)]',
  'model_df$sex_male <- as.integer(model_df$sex == "M")',
  'model_df$sex <- NULL',
  'for (col in selected) {',
  '  nas <- is.na(model_df[[col]])',
  '  if (any(nas)) model_df[[col]][nas] <- median(model_df[[col]], na.rm = TRUE)',
  '}',
  '',
  'formula <- as.formula(paste("in_hospital_death ~", paste(c("sex_male", selected), collapse = " + ")))',
  'model <- glm(formula, data = model_df, family = binomial)',
  'print(summary(model))',
  '',
  '# 4. Model evaluation',
  'pred_prob <- predict(model, type = "response")',
  'thresholds <- seq(0, 1, by = 0.01)',
  'roc <- data.frame(',
  '  tpr = sapply(thresholds, function(t) sum(pred_prob >= t & model_df$in_hospital_death == 1) / max(sum(model_df$in_hospital_death == 1), 1)),',
  '  fpr = sapply(thresholds, function(t) sum(pred_prob >= t & model_df$in_hospital_death == 0) / max(sum(model_df$in_hospital_death == 0), 1))',
  ')',
  'roc <- roc[order(roc$fpr, roc$tpr), ]',
  'auc <- abs(sum(diff(roc$fpr) * (head(roc$tpr, -1) + tail(roc$tpr, -1)) / 2))',
  'cat(sprintf("\\nAUC-ROC: %.3f\\n", auc))',
  '',
  'cm <- table(Predicted = as.integer(pred_prob >= 0.5), Actual = model_df$in_hospital_death)',
  'cat("\\nConfusion matrix (threshold = 0.5):\\n")',
  'print(cm)',
  '',
  '# 5. ROC curve plot',
  'plot(roc$fpr, roc$tpr, type = "l", col = "steelblue", lwd = 2,',
  '     xlab = "False Positive Rate", ylab = "True Positive Rate",',
  '     main = sprintf("ROC Curve (AUC = %.3f)", auc))',
  'abline(0, 1, lty = 2, col = "gray50")',
  'cat("\\nDone.\\n")',
].join('\n')

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
    name: '01_cohort_extraction.sql',
    type: 'file',
    parentId: 'folder-1',
    language: 'sql',
    content: DEMO_SQL,
    createdAt: '2026-02-10',
  },
  {
    id: 'file-2',
    projectUid: '',
    name: '02_feature_engineering.py',
    type: 'file',
    parentId: 'folder-1',
    language: 'python',
    content: DEMO_PY,
    createdAt: '2026-02-10',
  },
  {
    id: 'file-3',
    projectUid: '',
    name: '03_analysis.R',
    type: 'file',
    parentId: 'folder-1',
    language: 'r',
    content: DEMO_R,
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
        // Migrate stale default demo files when DEMO_FILES_VERSION changes
        const storedVersion = parseInt(localStorage.getItem(DEMO_FILES_VERSION_KEY) ?? '0', 10)
        if (storedVersion < DEMO_FILES_VERSION) {
          const defaultById = new Map(defaultFiles.filter((f) => f.type === 'file').map((f) => [f.id, f]))
          for (const f of stored) {
            const defaultFile = defaultById.get(f.id)
            if (defaultFile && f.type === 'file' && defaultFile.content !== f.content) {
              f.content = defaultFile.content
              storage.ideFiles.update(f.id, { content: f.content }).catch(() => {})
            }
          }
          localStorage.setItem(DEMO_FILES_VERSION_KEY, String(DEMO_FILES_VERSION))
        }

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
        localStorage.setItem(DEMO_FILES_VERSION_KEY, String(DEMO_FILES_VERSION))
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
    const { editorSettings } = useAppStore.getState()
    // Only persist to IndexedDB when autoSave is enabled.
    // Otherwise, content stays in-memory only until explicit saveFile().
    if (editorSettings.autoSave) {
      const existingTimer = _contentSaveTimers.get(id)
      if (existingTimer) clearTimeout(existingTimer)
      _contentSaveTimers.set(id, setTimeout(() => {
        _contentSaveTimers.delete(id)
        getStorage().ideFiles.update(id, { content }).then(() => {
          _savedContent.set(id, content)
          useFileStore.setState((s) => ({ _dirtyVersion: s._dirtyVersion + 1 }))
        }).catch(() => {})
      }, editorSettings.autoSaveDelay))
    }
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
    set((s) => {
      const exists = s.outputTabs.some((t) => t.id === tab.id)
      if (exists) {
        return {
          outputTabs: s.outputTabs.map((t) => (t.id === tab.id ? tab : t)),
          activeOutputTab: tab.id,
        }
      }
      return {
        outputTabs: [...s.outputTabs, tab],
        activeOutputTab: tab.id,
        outputTabOrder: [...s.outputTabOrder, tab.id],
      }
    }),

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
