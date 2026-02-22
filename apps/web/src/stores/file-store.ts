import { create } from 'zustand'
import type { IdeFile } from '@/types'
import { getStorage } from '@/lib/storage'
import { useAppStore } from '@/stores/app-store'

export type FileNode = IdeFile

export interface OutputTab {
  id: string
  label: string
  type: 'figure' | 'table' | 'text' | 'html' | 'markdown'
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

let undoCounter = 0

/** Generate a unique ID for files and folders. */
function newFileId(type: 'file' | 'folder'): string {
  return `${type}-${crypto.randomUUID().slice(0, 8)}`
}

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
    csv: 'plaintext',
    tsv: 'plaintext',
    txt: 'plaintext',
    ipynb: 'json',
    qmd: 'markdown',
    rmd: 'markdown',
  }
  return map[ext ?? ''] ?? 'plaintext'
}

// Bump this version whenever default demo file content changes.
// On load, if the user's stored files still have a previous version,
// the default file contents are silently updated in IndexedDB.
const DEMO_FILES_VERSION = 4
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
  '# Uses sql_query(sql) which is automatically available in Linkr.',
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

const DEMO_IPYNB = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python', version: '3.12.0' } },
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Mortality Prediction — Exploratory Data Analysis\n', '\n', 'This notebook explores the OMOP CDM data and the wide-format dataset.\n', '\n', '**Prerequisites:** Run `01_cohort_extraction.sql` and `02_feature_engineering.py` first.\n', '\n', '**Note:** `sql_query(sql)` is automatically available in Linkr notebooks.'] },
    { cell_type: 'code', metadata: {}, source: ['import pandas as pd\n', 'import numpy as np\n', 'import matplotlib\n', "matplotlib.use('agg')\n", 'import matplotlib.pyplot as plt\n', 'import matplotlib.ticker as mticker\n', '\n', "pd.set_option('display.max_columns', 50)\n", "pd.set_option('display.max_rows', 100)"], outputs: [], execution_count: null },
    { cell_type: 'markdown', metadata: {}, source: ['## 1. OMOP Concept Exploration\n', '\n', 'Browse the concept table to understand what data is available.'] },
    { cell_type: 'code', metadata: {}, source: ['# How many concepts per domain?\n', 'domain_counts = await sql_query("""\n', '    SELECT domain_id, COUNT(*) AS n_concepts\n', '    FROM concept\n', '    WHERE invalid_reason IS NULL\n', '    GROUP BY domain_id\n', '    ORDER BY n_concepts DESC\n', '""")\n', 'domain_counts'], outputs: [], execution_count: null },
    { cell_type: 'code', metadata: {}, source: ['# Measurement concepts with data\n', 'measurement_concepts = await sql_query("""\n', '    SELECT c.concept_id, c.concept_name, c.vocabulary_id,\n', '           COUNT(*) AS n_records,\n', '           COUNT(DISTINCT m.person_id) AS n_patients,\n', '           ROUND(AVG(m.value_as_number), 2) AS mean_value\n', '    FROM measurement m\n', '    JOIN concept c ON m.measurement_concept_id = c.concept_id\n', '    WHERE m.value_as_number IS NOT NULL\n', '    GROUP BY c.concept_id, c.concept_name, c.vocabulary_id\n', '    HAVING COUNT(*) >= 100\n', '    ORDER BY n_records DESC\n', '    LIMIT 40\n', '""")\n', 'print(f"Measurement concepts with ≥100 records: {len(measurement_concepts)}")\n', 'measurement_concepts'], outputs: [], execution_count: null },
    { cell_type: 'markdown', metadata: {}, source: ['## 2. Cohort Overview'] },
    { cell_type: 'code', metadata: {}, source: ['cohort = await sql_query("SELECT * FROM cohort")\n', 'print(f"Cohort: {len(cohort)} visits, {cohort[\'person_id\'].nunique()} unique patients")\n', 'print(f"Mortality: {cohort[\'in_hospital_death\'].sum()} deaths "\n', '      f"({100 * cohort[\'in_hospital_death\'].mean():.1f}%)")\n', 'print(f"\\nAge: {cohort[\'age\'].mean():.1f} ± {cohort[\'age\'].std():.1f} years")\n', 'print(f"LOS: {cohort[\'los_hours\'].median():.0f}h median")\n', 'print(f"\\nSex distribution:")\n', "print(cohort['sex'].value_counts().to_string())"], outputs: [], execution_count: null },
    { cell_type: 'code', metadata: {}, source: ['# Age distribution by sex\n', 'fig, axes = plt.subplots(1, 3, figsize=(15, 4))\n', "for sex, color in [('M', '#4C78A8'), ('F', '#E45756')]:\n", "    subset = cohort[cohort['sex'] == sex]\n", "    axes[0].hist(subset['age'], bins=20, alpha=0.6, label=sex, color=color, edgecolor='white')\n", "axes[0].set_xlabel('Age (years)'); axes[0].set_ylabel('Count'); axes[0].set_title('Age by Sex'); axes[0].legend()\n", '\n', "axes[1].hist(cohort['los_hours'], bins=50, color='#72B7B2', edgecolor='white')\n", "axes[1].set_xlabel('LOS (hours)'); axes[1].set_title('Length of Stay'); axes[1].set_yscale('log')\n", '\n', "cohort['age_group'] = pd.cut(cohort['age'], bins=[0,40,50,60,70,80,120], labels=['<40','40-49','50-59','60-69','70-79','≥80'])\n", "cohort.groupby('age_group', observed=True)['in_hospital_death'].mean().mul(100).plot(kind='bar', ax=axes[2], color='#F58518', edgecolor='white')\n", "axes[2].set_xlabel('Age Group'); axes[2].set_ylabel('Mortality (%)'); axes[2].set_title('Mortality by Age')\n", "axes[2].tick_params(axis='x', rotation=0)\n", 'plt.tight_layout(); plt.show()'], outputs: [], execution_count: null },
    { cell_type: 'markdown', metadata: {}, source: ['## 3. Feature Distributions'] },
    { cell_type: 'code', metadata: {}, source: ["df = pd.read_csv('data/datasets/mortality_dataset.csv')\n", "print(f\"Dataset: {df.shape[0]} rows × {df.shape[1]} columns\")\n", "df.describe().round(2)"], outputs: [], execution_count: null },
    { cell_type: 'code', metadata: {}, source: ['# Vital signs distribution by outcome\n', "vitals_cols = [c for c in df.columns if any(c.startswith(v) for v in ['hr_','sbp_','dbp_','resp_rate_','spo2_','temp_']) and c.endswith('_mean')]\n", 'n = len(vitals_cols)\n', 'fig, axes = plt.subplots(2, (n+1)//2, figsize=(16, 7))\n', 'axes = axes.flatten()\n', "alive = df[df['in_hospital_death'] == 0]\n", "dead = df[df['in_hospital_death'] == 1]\n", 'for i, col in enumerate(vitals_cols):\n', "    axes[i].hist(alive[col].dropna(), bins=30, alpha=0.6, color='#4C78A8', label='Alive', density=True, edgecolor='white')\n", "    axes[i].hist(dead[col].dropna(), bins=30, alpha=0.6, color='#E45756', label='Dead', density=True, edgecolor='white')\n", "    axes[i].set_title(col.replace('_mean','').upper())\n", '    if i == 0: axes[i].legend()\n', 'for j in range(i+1, len(axes)): axes[j].set_visible(False)\n', "plt.suptitle('Vital Signs (H0-H24 Mean) by Outcome', y=1.02)\n", 'plt.tight_layout(); plt.show()'], outputs: [], execution_count: null },
    { cell_type: 'code', metadata: {}, source: ['# Lab values distribution by outcome\n', "labs_cols = [c for c in df.columns if c.endswith('_first')]\n", 'n = len(labs_cols); ncols = 4; nrows = (n+ncols-1)//ncols\n', 'fig, axes = plt.subplots(nrows, ncols, figsize=(16, 3.5*nrows))\n', 'axes = axes.flatten()\n', 'for i, col in enumerate(labs_cols):\n', "    axes[i].hist(alive[col].dropna(), bins=30, alpha=0.6, color='#4C78A8', label='Alive', density=True, edgecolor='white')\n", "    axes[i].hist(dead[col].dropna(), bins=30, alpha=0.6, color='#E45756', label='Dead', density=True, edgecolor='white')\n", "    axes[i].set_title(col.replace('_first','').title())\n", '    if i == 0: axes[i].legend()\n', 'for j in range(i+1, len(axes)): axes[j].set_visible(False)\n', "plt.suptitle('Lab Values (First in H0-H24) by Outcome', y=1.02)\n", 'plt.tight_layout(); plt.show()'], outputs: [], execution_count: null },
    { cell_type: 'markdown', metadata: {}, source: ['## 4. Missing Data Analysis'] },
    { cell_type: 'code', metadata: {}, source: ["id_cols = ['visit_occurrence_id', 'person_id']\n", "feature_cols = [c for c in df.columns if c not in id_cols + ['sex', 'in_hospital_death']]\n", 'missing = df[feature_cols].isnull().mean().sort_values(ascending=False) * 100\n', '\n', 'fig, ax = plt.subplots(figsize=(12, 5))\n', "colors = ['#E45756' if v >= 30 else '#F58518' if v >= 10 else '#4C78A8' for v in missing.values]\n", "ax.barh(range(len(missing)), missing.values, color=colors, edgecolor='white')\n", 'ax.set_yticks(range(len(missing))); ax.set_yticklabels(missing.index, fontsize=8)\n', "ax.set_xlabel('Missing (%)'); ax.set_title('Missing Data by Feature')\n", "ax.axvline(x=30, color='red', linestyle='--', alpha=0.5, label='30% threshold')\n", 'ax.legend(); ax.invert_yaxis()\n', 'plt.tight_layout(); plt.show()'], outputs: [], execution_count: null },
    { cell_type: 'markdown', metadata: {}, source: ['## 5. Correlation Analysis'] },
    { cell_type: 'code', metadata: {}, source: ["numeric_cols = [c for c in feature_cols if df[c].dtype in ['float64', 'int64']]\n", 'corr = df[numeric_cols].corr()\n', 'fig, ax = plt.subplots(figsize=(14, 12))\n', "im = ax.imshow(corr.values, cmap='RdBu_r', vmin=-1, vmax=1, aspect='auto')\n", 'ax.set_xticks(range(len(numeric_cols))); ax.set_yticks(range(len(numeric_cols)))\n', 'ax.set_xticklabels(numeric_cols, rotation=90, fontsize=7)\n', 'ax.set_yticklabels(numeric_cols, fontsize=7)\n', "ax.set_title('Feature Correlation Matrix')\n", 'plt.colorbar(im, ax=ax, shrink=0.8)\n', 'plt.tight_layout(); plt.show()'], outputs: [], execution_count: null },
    { cell_type: 'markdown', metadata: {}, source: ['## 6. Outcome Analysis'] },
    { cell_type: 'code', metadata: {}, source: ['# Table 1: descriptive stats by outcome\n', 'table1_rows = []\n', 'for col in numeric_cols:\n', '    a = alive[col].dropna(); d = dead[col].dropna()\n', '    table1_rows.append({\n', "        'Variable': col,\n", "        'Alive (mean ± SD)': f\"{a.mean():.1f} ± {a.std():.1f}\",\n", "        'Dead (mean ± SD)': f\"{d.mean():.1f} ± {d.std():.1f}\",\n", "        'Alive median [IQR]': f\"{a.median():.1f} [{a.quantile(0.25):.1f}–{a.quantile(0.75):.1f}]\",\n", "        'Dead median [IQR]': f\"{d.median():.1f} [{d.quantile(0.25):.1f}–{d.quantile(0.75):.1f}]\",\n", '    })\n', 'table1 = pd.DataFrame(table1_rows)\n', 'print("Table 1: Patient Characteristics by Outcome")\n', 'print("=" * 100)\n', 'print(table1.to_string(index=False))'], outputs: [], execution_count: null },
    { cell_type: 'code', metadata: {}, source: ['# Correlation with outcome\n', 'from scipy import stats\n', 'outcome_corr = []\n', 'for col in numeric_cols:\n', "    valid = df[[col, 'in_hospital_death']].dropna()\n", '    if len(valid) > 10:\n', "        r, p = stats.pointbiserialr(valid['in_hospital_death'], valid[col])\n", "        outcome_corr.append({'Feature': col, 'r': round(r, 3), 'p-value': round(p, 4)})\n", "outcome_corr_df = pd.DataFrame(outcome_corr).sort_values('r', key=abs, ascending=False)\n", '\n', 'fig, ax = plt.subplots(figsize=(10, 6))\n', "colors = ['#E45756' if r > 0 else '#4C78A8' for r in outcome_corr_df['r']]\n", "ax.barh(range(len(outcome_corr_df)), outcome_corr_df['r'].values, color=colors, edgecolor='white')\n", 'ax.set_yticks(range(len(outcome_corr_df)))\n', "ax.set_yticklabels(outcome_corr_df['Feature'].values, fontsize=8)\n", "ax.set_xlabel('Point-biserial Correlation')\n", "ax.set_title('Feature Correlation with In-Hospital Mortality')\n", "ax.axvline(x=0, color='black', linewidth=0.5); ax.invert_yaxis()\n", 'plt.tight_layout(); plt.show()'], outputs: [], execution_count: null },
    { cell_type: 'code', metadata: {}, source: ['# Box plots: key features by outcome\n', "key_features = [c for c in ['age','hr_mean','sbp_mean','resp_rate_mean','creatinine_first','bun_first','wbc_first'] if c in df.columns]\n", 'n = len(key_features); ncols = 4; nrows = (n+ncols-1)//ncols\n', 'fig, axes = plt.subplots(nrows, ncols, figsize=(16, 4*nrows))\n', 'axes = axes.flatten()\n', 'for i, col in enumerate(key_features):\n', "    bp = axes[i].boxplot([alive[col].dropna(), dead[col].dropna()], labels=['Alive','Dead'], patch_artist=True, widths=0.5)\n", "    bp['boxes'][0].set_facecolor('#4C78A8'); bp['boxes'][1].set_facecolor('#E45756')\n", "    for b in bp['boxes']: b.set_alpha(0.7)\n", "    axes[i].set_title(col.replace('_mean','').replace('_first','').replace('_',' ').title())\n", 'for j in range(i+1, len(axes)): axes[j].set_visible(False)\n', "plt.suptitle('Feature Distributions by Outcome', y=1.02)\n", 'plt.tight_layout(); plt.show()'], outputs: [], execution_count: null },
    { cell_type: 'markdown', metadata: {}, source: ['## 7. Data Cleaning Summary\n', '\n', '- **Missing values**: Features with > 30% missing excluded. Remaining NAs imputed with median.\n', '- **Multicollinearity**: Pairs with |r| > 0.85 flagged for review.\n', '- **Outliers**: Clinical plausibility checks (no automatic removal).\n', '- **Class imbalance**: Stratified train/test split.\n', '\n', 'See `05_ml_mortality.qmd` for the full modeling pipeline.'] },
    { cell_type: 'code', metadata: {}, source: ['# Outlier detection: physiologically implausible values\n', "PLAUSIBLE_RANGES = {'hr_mean': (20,300), 'sbp_mean': (40,300), 'temp_mean': (30,45),\n", "    'resp_rate_mean': (4,60), 'spo2_mean': (50,100), 'sodium_first': (100,180),\n", "    'potassium_first': (1.5,10), 'creatinine_first': (0.1,30)}\n", '\n', "print(f\"{'Feature':<25} {'Range':>15} {'N outliers':>12} {'%':>8}\")\n", 'print("-" * 62)\n', 'for col, (lo, hi) in PLAUSIBLE_RANGES.items():\n', '    if col in df.columns:\n', '        vals = df[col].dropna()\n', '        n_out = ((vals < lo) | (vals > hi)).sum()\n', '        pct = 100 * n_out / len(vals) if len(vals) > 0 else 0\n', '        print(f"{col:<25} {f\\"[{lo}, {hi}]\\":>15} {n_out:>12} {pct:>7.1f}%")'], outputs: [], execution_count: null },
    { cell_type: 'code', metadata: {}, source: ['usable = [c for c in numeric_cols if df[c].isnull().mean() < 0.30]\n', 'print(f"\\nEDA complete. {df.shape[0]} visits, {len(usable)} usable features.")\n', 'print("Next step: Run 05_ml_mortality.qmd for the modeling pipeline.")'], outputs: [], execution_count: null },
  ],
}, null, 2)

const DEMO_QMD = [
  '---',
  'title: "Mortality Prediction — Machine Learning Pipeline"',
  'format: html',
  '---',
  '',
  '# Mortality Prediction — Machine Learning Pipeline',
  '',
  'Full ML pipeline: data prep, train/test split, logistic regression,',
  'gradient boosting, evaluation, calibration, feature importance, SHAP, LIME.',
  '',
  '**Prerequisites:** Run scripts 01–02 first, review 04_eda_mortality.ipynb.',
  '',
  '```{python}',
  'import pandas as pd',
  'import numpy as np',
  'import matplotlib',
  "matplotlib.use('agg')",
  'import matplotlib.pyplot as plt',
  'np.random.seed(42)',
  '```',
  '',
  '## 1. Data Preparation',
  '',
  '```{python}',
  "df = pd.read_csv('data/datasets/mortality_dataset.csv')",
  'print(f"Dataset: {df.shape[0]} rows × {df.shape[1]} columns")',
  'print(f"Mortality: {df[\'in_hospital_death\'].sum()} / {len(df)} ({100*df[\'in_hospital_death\'].mean():.1f}%)")',
  '',
  "id_cols = ['visit_occurrence_id', 'person_id']",
  "target_col = 'in_hospital_death'",
  'exclude_cols = id_cols + [target_col, \'sex\']',
  'numeric_features = [c for c in df.columns if c not in exclude_cols and df[c].dtype in [\'float64\',\'int64\',\'float32\']]',
  'missing_pct = df[numeric_features].isnull().mean()',
  'usable_features = list(missing_pct[missing_pct < 0.30].index)',
  'print(f"Usable features (<30% missing): {len(usable_features)}")',
  '',
  'X = df[usable_features].copy()',
  "X['sex_male'] = (df['sex'] == 'M').astype(int)",
  'y = df[target_col].values',
  'for col in usable_features:',
  '    mask = X[col].isnull()',
  '    if mask.any(): X.loc[mask, col] = X[col].median()',
  'feature_names = list(X.columns)',
  'print(f"Model matrix: {X.shape[0]} × {X.shape[1]}")',
  '```',
  '',
  '## 2. Train/Test Split',
  '',
  '```{python}',
  'from sklearn.model_selection import train_test_split',
  'X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, random_state=42, stratify=y)',
  'print(f"Train: {len(X_train)} ({100*y_train.mean():.1f}% mort.) | Test: {len(X_test)} ({100*y_test.mean():.1f}% mort.)")',
  '```',
  '',
  '## 3. Logistic Regression',
  '',
  '```{python}',
  'from sklearn.linear_model import LogisticRegression',
  'from sklearn.preprocessing import StandardScaler',
  'from sklearn.metrics import roc_auc_score, classification_report, confusion_matrix, roc_curve, precision_recall_curve, average_precision_score, brier_score_loss',
  '',
  'scaler = StandardScaler()',
  'X_train_scaled = scaler.fit_transform(X_train)',
  'X_test_scaled = scaler.transform(X_test)',
  "lr = LogisticRegression(max_iter=1000, random_state=42, class_weight='balanced')",
  'lr.fit(X_train_scaled, y_train)',
  'lr_proba_test = lr.predict_proba(X_test_scaled)[:, 1]',
  'lr_pred_test = lr.predict(X_test_scaled)',
  'print(f"Logistic Regression — AUC-ROC: {roc_auc_score(y_test, lr_proba_test):.3f}")',
  'print(classification_report(y_test, lr_pred_test, target_names=["Alive", "Dead"]))',
  '```',
  '',
  '## 4. Gradient Boosting',
  '',
  '```{python}',
  'from sklearn.ensemble import GradientBoostingClassifier',
  'from sklearn.model_selection import cross_val_score',
  '',
  'gb = GradientBoostingClassifier(n_estimators=200, max_depth=4, learning_rate=0.1, subsample=0.8, min_samples_leaf=20, random_state=42)',
  'gb.fit(X_train, y_train)',
  'gb_proba_test = gb.predict_proba(X_test)[:, 1]',
  'gb_pred_test = gb.predict(X_test)',
  'print(f"Gradient Boosting — AUC-ROC: {roc_auc_score(y_test, gb_proba_test):.3f}")',
  'print(classification_report(y_test, gb_pred_test, target_names=["Alive", "Dead"]))',
  'cv = cross_val_score(gb, X_train, y_train, cv=5, scoring="roc_auc")',
  'print(f"5-fold CV AUC: {cv.mean():.3f} ± {cv.std():.3f}")',
  '```',
  '',
  '## 5. Model Comparison',
  '',
  '```{python}',
  'fig, axes = plt.subplots(1, 3, figsize=(16, 5))',
  'for name, proba, color in [("Logistic Regression", lr_proba_test, "#4C78A8"), ("Gradient Boosting", gb_proba_test, "#E45756")]:',
  '    fpr, tpr, _ = roc_curve(y_test, proba)',
  '    axes[0].plot(fpr, tpr, color=color, lw=2, label=f"{name} (AUC={roc_auc_score(y_test, proba):.3f})")',
  '    prec, rec, _ = precision_recall_curve(y_test, proba)',
  '    axes[1].plot(rec, prec, color=color, lw=2, label=f"{name} (AP={average_precision_score(y_test, proba):.3f})")',
  'axes[0].plot([0,1],[0,1],"k--",alpha=0.3); axes[0].set_xlabel("FPR"); axes[0].set_ylabel("TPR"); axes[0].set_title("ROC"); axes[0].legend(fontsize=8)',
  'axes[1].set_xlabel("Recall"); axes[1].set_ylabel("Precision"); axes[1].set_title("Precision-Recall"); axes[1].legend(fontsize=8)',
  'cm = confusion_matrix(y_test, gb_pred_test)',
  'im = axes[2].imshow(cm, cmap="Blues")',
  'for i in range(2):',
  '    for j in range(2):',
  '        axes[2].text(j, i, str(cm[i,j]), ha="center", va="center", fontsize=16, color="white" if cm[i,j] > cm.max()/2 else "black")',
  'axes[2].set_xticks([0,1]); axes[2].set_yticks([0,1]); axes[2].set_xticklabels(["Alive","Dead"]); axes[2].set_yticklabels(["Alive","Dead"])',
  'axes[2].set_xlabel("Predicted"); axes[2].set_ylabel("Actual"); axes[2].set_title("Confusion Matrix (GB)")',
  'plt.tight_layout(); plt.show()',
  '```',
  '',
  '## 6. Calibration',
  '',
  '```{python}',
  'from sklearn.calibration import calibration_curve',
  'fig, axes = plt.subplots(1, 2, figsize=(13, 5))',
  'for ax_idx, (name, proba, color) in enumerate([("Logistic Regression", lr_proba_test, "#4C78A8"), ("Gradient Boosting", gb_proba_test, "#E45756")]):',
  "    fraction_pos, mean_predicted = calibration_curve(y_test, proba, n_bins=10, strategy='uniform')",
  '    axes[ax_idx].plot(mean_predicted, fraction_pos, "s-", color=color, label="Model")',
  '    axes[ax_idx].plot([0,1],[0,1],"k--",alpha=0.3); axes[ax_idx].set_title(f"Calibration — {name}")',
  '    axes[ax_idx].set_xlabel("Predicted"); axes[ax_idx].set_ylabel("Observed"); axes[ax_idx].legend()',
  'plt.tight_layout(); plt.show()',
  '```',
  '',
  '## 7. Feature Importance',
  '',
  '```{python}',
  'from sklearn.inspection import permutation_importance',
  'importances = gb.feature_importances_',
  'importance_df = pd.DataFrame({"Feature": feature_names, "Importance": importances}).sort_values("Importance", ascending=False)',
  '',
  'perm = permutation_importance(gb, X_test, y_test, n_repeats=10, random_state=42, scoring="roc_auc")',
  'perm_df = pd.DataFrame({"Feature": feature_names, "Importance": perm.importances_mean, "Std": perm.importances_std}).sort_values("Importance", ascending=False)',
  '',
  'fig, axes = plt.subplots(1, 2, figsize=(16, 7))',
  'top_n = min(20, len(importance_df))',
  'top = importance_df.head(top_n)',
  'axes[0].barh(range(top_n), top["Importance"].values, color="#72B7B2", edgecolor="white")',
  'axes[0].set_yticks(range(top_n)); axes[0].set_yticklabels(top["Feature"].values, fontsize=9)',
  'axes[0].set_xlabel("Impurity-based Importance"); axes[0].set_title("Built-in Feature Importance"); axes[0].invert_yaxis()',
  'top = perm_df.head(top_n)',
  'axes[1].barh(range(top_n), top["Importance"].values, color="#F58518", xerr=top["Std"].values, edgecolor="white", capsize=3)',
  'axes[1].set_yticks(range(top_n)); axes[1].set_yticklabels(top["Feature"].values, fontsize=9)',
  'axes[1].set_xlabel("Permutation Importance (ΔAUC)"); axes[1].set_title("Permutation Importance"); axes[1].invert_yaxis()',
  'plt.tight_layout(); plt.show()',
  '```',
  '',
  '## 8. SHAP Analysis',
  '',
  '```{python}',
  'import shap',
  'explainer = shap.TreeExplainer(gb)',
  'shap_values = explainer.shap_values(X_test)',
  '```',
  '',
  '```{python}',
  '# Summary plot (beeswarm)',
  'fig, ax = plt.subplots(figsize=(10, 8))',
  'shap.summary_plot(shap_values, X_test, feature_names=feature_names, show=False, max_display=20)',
  "plt.title('SHAP Summary — Feature Impact on Mortality')",
  'plt.tight_layout(); plt.show()',
  '```',
  '',
  '```{python}',
  '# SHAP dependence plots for top 4 features',
  'shap_abs = np.abs(shap_values).mean(axis=0)',
  'top4 = np.argsort(shap_abs)[-4:][::-1]',
  'fig, axes = plt.subplots(2, 2, figsize=(14, 10))',
  'for idx, feat_idx in enumerate(top4):',
  '    shap.dependence_plot(feat_idx, shap_values, X_test, feature_names=feature_names, ax=axes[idx//2, idx%2], show=False)',
  "plt.suptitle('SHAP Dependence — Top 4 Features', y=1.02)",
  'plt.tight_layout(); plt.show()',
  '```',
  '',
  '```{python}',
  '# Waterfall: highest-risk patient',
  'high_risk = np.argmax(gb_proba_test)',
  'print(f"Highest-risk patient: P={gb_proba_test[high_risk]:.3f}, Actual: {\'Dead\' if y_test[high_risk] else \'Alive\'}")',
  'fig, ax = plt.subplots(figsize=(10, 6))',
  'shap.waterfall_plot(shap.Explanation(values=shap_values[high_risk], base_values=explainer.expected_value, data=X_test.iloc[high_risk].values, feature_names=feature_names), show=False, max_display=15)',
  'plt.tight_layout(); plt.show()',
  '```',
  '',
  '## 9. LIME Explanations',
  '',
  '```{python}',
  'import lime.lime_tabular',
  'lime_explainer = lime.lime_tabular.LimeTabularExplainer(X_train.values, feature_names=feature_names, class_names=["Alive","Dead"], mode="classification", random_state=42)',
  '',
  'print(f"LIME — Highest risk patient (P={gb_proba_test[high_risk]:.3f})")',
  'lime_exp = lime_explainer.explain_instance(X_test.iloc[high_risk].values, gb.predict_proba, num_features=15, top_labels=1)',
  'print("\\nFeature contributions (positive = ↑ risk):")',
  'for feat, weight in lime_exp.as_list(label=1):',
  '    print(f"  {feat:<45} {weight:>+.4f}")',
  '',
  'fig = lime_exp.as_pyplot_figure(label=1)',
  'fig.set_size_inches(10, 6)',
  "plt.title(f'LIME — Highest Risk (P={gb_proba_test[high_risk]:.3f})')",
  'plt.tight_layout(); plt.show()',
  '```',
  '',
  '## 10. Summary',
  '',
  '```{python}',
  'print("=" * 70)',
  'print("STUDY SUMMARY — IN-HOSPITAL MORTALITY PREDICTION")',
  'print("=" * 70)',
  'print(f"""',
  'COHORT: {len(df)} visits, {df["person_id"].nunique()} patients, {int(df["in_hospital_death"].sum())} deaths ({100*df["in_hospital_death"].mean():.1f}%)',
  'FEATURES: {len(feature_names)} (clinical + sex)',
  'SPLIT: {len(X_train)} train / {len(X_test)} test (stratified)',
  '',
  'RESULTS:',
  '  Logistic Regression  AUC-ROC: {roc_auc_score(y_test, lr_proba_test):.3f}',
  '  Gradient Boosting    AUC-ROC: {roc_auc_score(y_test, gb_proba_test):.3f}',
  '',
  'TOP PREDICTORS (permutation importance):""")',
  'for _, row in perm_df.head(10).iterrows():',
  '    print(f"  {row[\'Feature\']:<30} {row[\'Importance\']:.4f}")',
  'print(f"""',
  'LIMITATIONS:',
  '  - Single-center (MIMIC-IV)',
  '  - H0-H24 only, median imputation',
  '  - No external/temporal validation""")',
  '```',
].join('\n')

/** Generate default demo files with unique IDs for a given project. */
function createDefaultFiles(projectUid: string): FileNode[] {
  const folderId = newFileId('folder')
  return [
    {
      id: folderId,
      projectUid,
      name: 'scripts',
      type: 'folder',
      parentId: null,
      createdAt: '2026-02-10',
    },
    {
      id: newFileId('file'),
      projectUid,
      name: '01_cohort_extraction.sql',
      type: 'file',
      parentId: folderId,
      language: 'sql',
      content: DEMO_SQL,
      createdAt: '2026-02-10',
    },
    {
      id: newFileId('file'),
      projectUid,
      name: '02_feature_engineering.py',
      type: 'file',
      parentId: folderId,
      language: 'python',
      content: DEMO_PY,
      createdAt: '2026-02-10',
    },
    {
      id: newFileId('file'),
      projectUid,
      name: '03_analysis.R',
      type: 'file',
      parentId: folderId,
      language: 'r',
      content: DEMO_R,
      createdAt: '2026-02-10',
    },
    {
      id: newFileId('file'),
      projectUid,
      name: '04_eda_mortality.ipynb',
      type: 'file',
      parentId: folderId,
      language: 'json',
      content: DEMO_IPYNB,
      createdAt: '2026-02-22',
    },
    {
      id: newFileId('file'),
      projectUid,
      name: '05_ml_mortality.qmd',
      type: 'file',
      parentId: folderId,
      language: 'markdown',
      content: DEMO_QMD,
      createdAt: '2026-02-22',
    },
  ]
}

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


// Per-file debounce timers for content saves
const _contentSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Snapshot of last saved content (from IDB or explicit save)
const _savedContent = new Map<string, string>()

const MAX_UNDO = 50

export const useFileStore = create<FileState>((set, get) => ({
  files: [],
  expandedFolders: [],
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
        const versionKey = `${DEMO_FILES_VERSION_KEY}:${projectUid}`
        const storedVersion = parseInt(localStorage.getItem(versionKey) ?? '0', 10)
        if (storedVersion < DEMO_FILES_VERSION) {
          // Match demo files by name (not ID, since IDs are now unique per project)
          const demoRef = createDefaultFiles(projectUid)
          const demoByName = new Map(demoRef.filter((f) => f.type === 'file').map((f) => [f.name, f]))
          for (const f of stored) {
            const demoFile = demoByName.get(f.name)
            if (demoFile && f.type === 'file' && demoFile.content !== f.content) {
              f.content = demoFile.content
              storage.ideFiles.update(f.id, { content: f.content }).catch(() => {})
            }
          }
          localStorage.setItem(versionKey, String(DEMO_FILES_VERSION))
        }

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
        // Seed with defaults (unique IDs per project)
        const seeded = createDefaultFiles(projectUid)
        // Populate saved content snapshots
        for (const f of seeded) {
          if (f.type === 'file' && f.content !== undefined) {
            _savedContent.set(f.id, f.content)
          }
        }
        const rootFolders = seeded
          .filter((f) => f.type === 'folder' && f.parentId === null)
          .map((f) => f.id)
        set({
          files: seeded,
          activeProjectUid: projectUid,
          selectedFileId: null,
          openFileIds: [],
          expandedFolders: rootFolders,
          _dirtyVersion: 0,
        })
        // Persist seeds
        for (const f of seeded) {
          await storage.ideFiles.create(f)
        }
        const versionKey = `${DEMO_FILES_VERSION_KEY}:${projectUid}`
        localStorage.setItem(versionKey, String(DEMO_FILES_VERSION))
      }
    } catch {
      // Storage not ready — use defaults
      const seeded = createDefaultFiles(projectUid)
      const rootFolders = seeded
        .filter((f) => f.type === 'folder' && f.parentId === null)
        .map((f) => f.id)
      set({
        files: seeded,
        activeProjectUid: projectUid,
        selectedFileId: null,
        openFileIds: [],
        expandedFolders: rootFolders,
      })
    }
  },

  createFile: (name, parentId, language) => {
    const projectUid = get().activeProjectUid ?? ''
    const id = newFileId('file')
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
      openFileIds: s.openFileIds.includes(id) ? s.openFileIds : [...s.openFileIds, id],
    }))
    // Persist
    getStorage().ideFiles.create(node).catch((err) => console.error('[file-store] Failed to persist file:', node.id, err))

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
    const id = newFileId('folder')
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
    getStorage().ideFiles.create(node).catch((err) => console.error('[file-store] Failed to persist folder:', node.id, err))

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
    const newId = newFileId('file')
    const nameParts = original.name.split('.')
    const ext = nameParts.length > 1 ? `.${nameParts.pop()}` : ''
    const baseName = nameParts.join('.')
    const siblings = state.files.filter((f) => f.parentId === original.parentId)
    const siblingNames = new Set(siblings.map((f) => f.name))
    let newName = `${baseName} (copy)${ext}`
    let counter = 2
    while (siblingNames.has(newName)) {
      newName = `${baseName} (copy ${counter})${ext}`
      counter++
    }
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
      descriptionKey: 'files.duplicate',
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
      const execTabId = '__exec_console__'
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
  clearExecutionResults: () =>
    set(() => ({
      executionResults: [],
    })),
  clearExecutionResultsByLanguage: (lang) =>
    set((s) => {
      const remaining = s.executionResults.filter((r) => r.language !== lang)
      const tabId = '__exec_console__'
      if (remaining.length === 0) {
        const activeTab = s.activeOutputTab === tabId
          ? (s.outputTabs[s.outputTabs.length - 1]?.id ?? null)
          : s.activeOutputTab
        return {
          executionResults: remaining,
          activeOutputTab: activeTab,
          outputTabOrder: s.outputTabOrder.filter((tid) => tid !== tabId),
        }
      }
      return { executionResults: remaining }
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
