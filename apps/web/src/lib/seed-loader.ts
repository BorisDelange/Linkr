/**
 * Seed loader — loads workspace data from static files at build time.
 *
 * Instead of hardcoded demo data, workspaces are loaded from
 * `public/data/seed/seed.json` which lists workspace folders.
 * Each folder follows the same layout as a workspace export ZIP
 * (workspace.json, mapping-projects/, plugins/, etc.)
 *
 * Databases with Parquet files are declared in seed.json and
 * fetched/stored separately (they are not part of the export format).
 */

import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import * as engine from '@/lib/duckdb/engine'
import { BUILTIN_PRESET_IDS, SCHEMA_PRESETS, getSchemaPreset } from '@/lib/schema-presets'
import { seedBuiltinPluginsForWorkspace } from '@/lib/plugins/default-plugins'
import { buildVocabularyScript, buildCustomVocabularyScript } from '@/features/warehouse/etl/build-vocabulary-script'
import { restoreFileSourceDataFromCsv } from '@/lib/concept-mapping/export'
import { parseSourceConceptIdEntries, type CompactSourceConceptIdEntries } from '@/lib/entity-io'
import { fromPathTree, readPathTree, storablePathNode } from '@/lib/entity-tree'
import { mergeSourceConceptIdRegistry, type SourceConceptIdGroup } from '@/lib/concept-mapping/source-concept-ids-io'
import type { CustomMappingRow } from '@/features/warehouse/etl/build-vocabulary-script'
import type {
  Workspace, Organization, Project, CustomSchemaPreset, UserPlugin,
  DataSource, StoredFile, DatabaseConnectionConfig, SchemaMapping, SchemaPresetId,
  MappingProject, ConceptMapping, SourceConceptIdRange, SourceConceptIdEntry, EtlPipeline, EtlFile,
  DqRuleSet, DataCatalog, ServiceMapping,
  SqlScriptCollection, SqlScriptFile,
  WikiPage, ConceptSet,
  Dashboard, DashboardTab, DashboardWidget,
  DatasetFile, DatasetColumn,
  LocalizedString, TodoItem,
} from '@/types'
import { toLocalized } from '@/lib/localized'

/** Languages seeded from per-language README files (README.md = en, README.fr.md = fr). */
const SEED_LANGUAGES = ['en', 'fr'] as const

/** Normalize seed/imported todos: coerce legacy string `text` into a LocalizedString. */
function normalizeTodos(todos: unknown): TodoItem[] {
  if (!Array.isArray(todos)) return []
  return todos.map((raw) => {
    const t = raw as { id?: string; text?: unknown; done?: boolean }
    return {
      id: String(t.id ?? ''),
      text: toLocalized(t.text as string | LocalizedString | undefined),
      done: Boolean(t.done),
    }
  })
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A database to seed with Parquet files from a static folder. */
export interface SeedDatabase {
  id: string
  alias: string
  name: string
  description: string
  /** Schema preset id (e.g. 'omop-5.4', 'mimic-iv') or inline SchemaMapping */
  schema: SchemaPresetId | SchemaMapping
  /** Base path relative to public/ (e.g. '/data/mimic-iv-demo-omop') */
  parquetBase: string
  /** List of table names (without .parquet extension) */
  tables: string[]
  /** Link this database to a project by UID */
  linkToProject?: string
  /** Mark as vocabulary reference */
  isVocabularyReference?: boolean
  /** For in-memory databases with no Parquet files (ETL target) */
  inMemory?: boolean
}

/** A mapping JSON to seed from a static file. */
interface SeedConceptMappings {
  /** Path to the compact JSON file (relative to public/) */
  file: string
  /** Mapping project ID to attach to */
  projectId: string
}

/** ETL scripts seed config */
interface SeedEtlScripts {
  /** Path to the JSON file with script definitions */
  file: string
  /** Pipeline ID to attach to */
  pipelineId: string
  /** Optional: path to custom mappings JSON for vocabulary generation */
  customMappingsFile?: string
  /** Optional: mapping project ID for vocabulary script generation */
  mappingProjectId?: string
  /** Optional: vocabulary datasource ID for vocabulary script */
  vocabularyDataSourceId?: string
}

/** Dataset seed config */
interface SeedDataset {
  /** Path to the JSON file with columns + rows */
  file: string
  /** Dataset file ID */
  id: string
  /** Project UID to attach to */
  projectUid: string
  /** File name (e.g. 'icu_activity.csv') */
  fileName: string
}

/** Dashboard seed config */
interface SeedDashboard {
  /** Path to the JSON file with dashboard + tabs + widgets */
  file: string
  /** Dashboard id (matches the bundle's dashboard.id). */
  id: string
  /** Project UID to attach to */
  projectUid: string
}

// ---------------------------------------------------------------------------
// Unified manifest (schemaVersion 2)
// ---------------------------------------------------------------------------
//
// Every workspace ships ONE `<folder>/manifest.json` listing all its entities in a flat,
// homogeneous form. It is the single source of truth for "what this workspace contains":
// the seed loader, the change-detection hash plugin and the targeted re-seed all iterate
// the same list, so they can't drift. Each entity gets a uniform `linkr-seed-<type>-<id>`
// guard flag and a single hash.
//
// Entities load in two phases (the split is load-bearing — see seedWorkspaces/seedDatabases):
//   - phase 'structure': projects (+ full content), mapping projects, dq rule sets, catalogs.
//   - phase 'data': databases (parquet/mount), concept mappings, etl scripts, datasets,
//     dashboards — these depend on structural rows and on each other, in that order.

/** Entity types that appear as first-class manifest entities. */
export type SeedEntityKind =
  | 'database' | 'conceptMapping' | 'etlScript' | 'dataset' | 'dashboard'
  | 'project' | 'mappingProject' | 'dqRuleSet' | 'catalog' | 'etlPipeline'

/** Per-kind payload carried by a manifest entity (the config its loader needs). */
interface SeedEntitySpecs {
  database: SeedDatabase
  conceptMapping: SeedConceptMappings
  etlScript: SeedEtlScripts
  dataset: SeedDataset
  dashboard: SeedDashboard
  /** Folder name under `projects/` (full or lightweight project export). */
  project: { folder: string; full?: boolean }
  /** Folder name under `mapping-projects/`. */
  mappingProject: { folder: string }
  /** Path (relative to the workspace folder) to the rule-set bundle JSON. */
  dqRuleSet: { path: string }
  /** Path (relative to the workspace folder) to the catalog JSON. */
  catalog: { path: string }
  /** Folder name under `etl/` (pipeline row + optional script-file tree). */
  etlPipeline: { folder: string }
}

/** One entity in a workspace manifest: a kind tag + its loader payload. */
export type SeedManifestEntity = {
  [K in SeedEntityKind]: { type: K; id: string } & SeedEntitySpecs[K]
}[SeedEntityKind]

/** A workspace's unified manifest (`<folder>/manifest.json`). */
export interface WorkspaceManifest {
  schemaVersion: 2
  /** Organization metadata (optional, created if provided). */
  organization?: Organization
  /** All first-class entities of this workspace, in declaration order. */
  entities: SeedManifestEntity[]
  /** Non-re-seedable bootstrap content (wiki, sql-scripts, plugins, …). Optional. */
  internals?: WorkspaceInternals
}

/** Root `seed.json`: just the list of workspace folders (schemaVersion 2). */
export interface SeedManifest {
  schemaVersion: 2
  /** Folder names under public/data/seed/, each holding a `manifest.json`. */
  workspaces: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEED_KEY = 'linkr-seeded'
const SEED_BASE = `${import.meta.env.BASE_URL}data/seed`.replace(/\/\//g, '/')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path)
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

async function fetchText(path: string): Promise<string | null> {
  try {
    const res = await fetch(path)
    if (!res.ok) return null
    // On SPA hosting a missing path serves index.html (200); on an auth-gated
    // portal (private GitLab Pages) it serves a login-redirect HTML page. Either
    // would silently become a bogus source-concepts.csv → zero source concepts.
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/html')) return null
    const text = await res.text()
    // Extra guard for servers that mislabel the fallback shell (content-type check
    // above handles the honest case). Match only the app-shell openers, each on a
    // word boundary — don't drop legit content (CSV/markdown/code) that happens to
    // begin with e.g. an HTML anchor. Kept in sync with fetchMarkdown's guard.
    if (/^\s*<(?:!doctype|html|script|meta)\b/i.test(text)) return null
    return text
  } catch {
    return null
  }
}

/**
 * Fetch a markdown file, returning null when the file is absent. On SPA hosting
 * (and Vite dev), a missing path yields a 200 serving index.html — guard against
 * that so a non-existent README.<lang>.md doesn't leak the app shell as content.
 */
async function fetchMarkdown(path: string): Promise<string | null> {
  try {
    const res = await fetch(path)
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/html')) return null
    const text = await res.text()
    // Extra guard for servers that mislabel the fallback shell.
    if (/^\s*<(?:!doctype|html|script|meta)\b/i.test(text)) return null
    return text
  } catch {
    return null
  }
}

async function fetchBinary(path: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(path)
    if (!res.ok) return null
    return await res.arrayBuffer()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Full project loader (reads project export folder layout via fetch)
// ---------------------------------------------------------------------------

/**
 * Load a full project's content from its seed folder.
 * Follows the same layout as a project export ZIP:
 *   scripts/_tree.json + script files
 *   pipeline/pipeline.json
 *   cohorts/*.json
 *   databases/*.json
 *   dashboards/*.json (bundled: dashboard + tabs + widgets)
 *   datasets/_tree.json + folder/analysis.json + folder/data.csv
 *   attachments/_meta.json + binary files
 */
async function loadFullProject(projectUid: string, base: string): Promise<void> {
  const storage = getStorage()

  // Need a project index to know which files exist
  const projectIndex = await fetchJson<SeedProjectIndex>(`${base}/_index.json`)

  // --- IDE files (scripts/) ---
  const ideFiles = await fetchJson<import('@/types').IdeFile[]>(`${base}/scripts/_tree.json`)
  if (ideFiles) {
    for (const f of ideFiles) {
      if (f.type === 'file' && projectIndex?.scripts) {
        // Try to find the file content
        const content = await fetchText(`${base}/scripts/${f.name}`)
        if (content !== null) f.content = content
      }
      await storage.ideFiles.create({ ...f, projectUid }).catch(() => {})
    }
  }

  // --- Pipelines ---
  const pipelines = await fetchJson<import('@/types').Pipeline[]>(`${base}/pipeline/pipeline.json`)
  if (pipelines) {
    for (const p of pipelines) {
      await storage.pipelines.create({ ...p, projectUid }).catch(() => {})
    }
  }

  // --- Cohorts ---
  for (const path of projectIndex?.cohorts ?? []) {
    const cohort = await fetchJson<import('@/types').Cohort>(`${base}/cohorts/${path}`)
    if (cohort) await storage.cohorts.create({ ...cohort, projectUid }).catch(() => {})
  }

  // --- Connections (databases/) ---
  for (const path of projectIndex?.connections ?? []) {
    const conn = await fetchJson<import('@/types').IdeConnection>(`${base}/databases/${path}`)
    if (conn) await storage.connections.create({ ...conn, projectUid }).catch(() => {})
  }

  // --- Dashboards ---
  for (const path of projectIndex?.dashboards ?? []) {
    const bundle = await fetchJson<{
      dashboard: Dashboard; tabs: DashboardTab[]; widgets: DashboardWidget[]
    }>(`${base}/dashboards/${path}`)
    if (!bundle?.dashboard) continue
    await storage.dashboards.create({ ...bundle.dashboard, projectUid, origin: 'seed' }).catch(() => {})
    for (const tab of bundle.tabs ?? []) {
      await storage.dashboardTabs.create(tab).catch(() => {})
    }
    for (const w of bundle.widgets ?? []) {
      await storage.dashboardWidgets.create(w).catch(() => {})
    }
  }

  // --- Dataset files + analyses + data ---
  const datasetFiles = await fetchJson<DatasetFile[]>(`${base}/datasets/_tree.json`)
  if (datasetFiles) {
    for (const df of datasetFiles) {
      // Load column metadata from datasets/{folder}/_columns.json
      if (df.type === 'file' && !df.columns) {
        const folderName = df.name.replace(/\.[^.]+$/, '')
        const columns = await fetchJson<DatasetColumn[]>(`${base}/datasets/${folderName}/_columns.json`)
        if (columns) df.columns = columns
      }
      await storage.datasetFiles.create({ ...df, projectUid, origin: 'seed' }).catch(() => {})
    }

    // Load analyses
    for (const [folder, analyses] of Object.entries(projectIndex?.datasetAnalyses ?? {})) {
      for (const analysisPath of analyses) {
        const analysis = await fetchJson<import('@/types').DatasetAnalysis>(`${base}/datasets/${folder}/${analysisPath}`)
        if (analysis) await storage.datasetAnalyses.create(analysis).catch(() => {})
      }
    }

    // Load parsed rows: prefer a _data.json sidecar (format-agnostic), else a CSV.
    const findDf = (folder: string) =>
      datasetFiles.find(f => f.name.replace(/\.[^.]+$/, '') === folder && f.type === 'file')

    // Server mode: dataset rows + raw files are pre-provisioned server-side (portal
    // build), and the API storage adapter's save() is a no-op anyway, so fetching
    // these blobs into the browser would be pure wasted download/parse. Skip them —
    // same rationale as the Parquet-DB guard below. Front-only keeps loading them.
    if (!isServerMode()) {
      const sidecarFolders = new Set(projectIndex?.datasetDataSidecars ?? [])
      for (const folder of sidecarFolders) {
        const df = findDf(folder)
        if (!df) continue
        const sidecar = await fetchJson<{ rows: Record<string, unknown>[] }>(`${base}/datasets/${folder}/_data.json`)
        if (sidecar?.rows?.length) {
          await storage.datasetData.save({ datasetFileId: df.id, rows: sidecar.rows }).catch(() => {})
        }
      }

      for (const [folder, csvPath] of Object.entries(projectIndex?.datasetCsvFiles ?? {})) {
        if (sidecarFolders.has(folder)) continue // rows already loaded from the sidecar
        const df = findDf(folder)
        if (!df) continue
        const csv = await fetchText(`${base}/datasets/${folder}/${csvPath}`)
        if (!csv) continue
        const rows = parseSeedCsv(csv, df)
        if (rows.length > 0) {
          await storage.datasetData.save({ datasetFileId: df.id, rows }).catch(() => {})
        }
      }

      // Restore original uploaded files so "Import settings" works in the seeded app.
      for (const [folder, rawName] of Object.entries(projectIndex?.datasetRawFiles ?? {})) {
        const df = findDf(folder)
        if (!df) continue
        const bytes = await fetchBinary(`${base}/datasets/${folder}/${rawName}`)
        if (bytes) {
          await storage.datasetRawFiles.save({ datasetFileId: df.id, blob: new Blob([bytes]), fileName: rawName }).catch(() => {})
        }
      }
    }
  }

  // --- Attachments ---
  const attachmentsMeta = await fetchJson<Array<{ id: string; fileName: string; [k: string]: unknown }>>(`${base}/attachments/_meta.json`)
  if (attachmentsMeta) {
    for (const meta of attachmentsMeta) {
      const data = await fetchBinary(`${base}/attachments/${meta.id}-${meta.fileName}`)
      if (data) {
        await storage.readmeAttachments.create({
          ...meta, ownerType: 'project', ownerId: projectUid, data,
        } as import('@/types').ReadmeAttachment).catch(() => {})
      }
    }
  }

  console.info(`[seed-loader] Full project ${projectUid} loaded`)
}

/**
 * Parse CSV text into rows, using DatasetFile.columns for header→id mapping.
 */
function parseSeedCsv(csv: string, df: DatasetFile): Record<string, unknown>[] {
  const lines = csv.split('\n').filter(l => l.length > 0)
  if (lines.length < 2) return []

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  const nameToId = new Map<string, string>()
  if (df.columns) {
    for (const col of df.columns) nameToId.set(col.name, col.id)
  }

  const rows: Record<string, unknown>[] = []
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''))
    if (values.every(v => v === '')) continue
    const row: Record<string, unknown> = {}
    for (let j = 0; j < headers.length; j++) {
      const key = nameToId.get(headers[j]) ?? headers[j]
      const v = values[j] ?? ''
      if (v === '') { row[key] = null }
      else {
        const n = Number(v)
        row[key] = Number.isNaN(n) ? v : n
      }
    }
    rows.push(row)
  }
  return rows
}

// ---------------------------------------------------------------------------
// Workspace structure loader (reads export folder layout via fetch)
// ---------------------------------------------------------------------------

/**
 * Load a workspace's structure (phase 1): organization, workspace.json, built-in schemas
 * and plugins, the workspace "internals" (wiki, sql-scripts, etl pipelines, …) and the
 * structural first-class entities (projects, mapping projects, dq rule sets, catalogs).
 *
 * The "data" entities (databases, concept mappings, etl scripts, datasets, dashboards) are
 * loaded later by seedDatabases() — they depend on these structural rows and on each other.
 */
async function loadSeedWorkspace(folder: string, manifest: WorkspaceManifest): Promise<void> {
  const storage = getStorage()
  const base = `${SEED_BASE}/${folder}`
  const now = new Date().toISOString()

  // --- Organization ---
  if (manifest.organization) {
    const existing = await storage.organizations.getById(manifest.organization.id)
    if (!existing) {
      // Export strips instance fields (createdAt/updatedAt) — re-stamp on load.
      await storage.organizations.create({
        ...manifest.organization,
        createdAt: manifest.organization.createdAt ?? now,
        updatedAt: now,
      })
    }
  }

  // --- workspace.json ---
  const workspace = await fetchJson<Workspace>(`${base}/workspace.json`)
  if (!workspace?.id) {
    console.warn(`[seed-loader] No valid workspace.json in ${folder}, skipping`)
    return
  }

  // README.md (+ README.<lang>.md per language)
  const wsReadmeByLang: LocalizedString = {}
  for (const lang of SEED_LANGUAGES) {
    const suffix = lang === 'en' ? '' : `.${lang}`
    const text = await fetchMarkdown(`${base}/README${suffix}.md`)
    if (text) wsReadmeByLang[lang] = text
  }
  if (Object.keys(wsReadmeByLang).length > 0) workspace.readme = wsReadmeByLang

  const existing = await storage.workspaces.getById(workspace.id)
  if (existing) {
    await storage.workspaces.update(workspace.id, { ...workspace, origin: 'seed', updatedAt: now })
  } else {
    await storage.workspaces.create({ ...workspace, origin: 'seed' })
  }

  const wsId = workspace.id

  // --- Seed built-in schemas for this workspace ---
  for (const presetId of BUILTIN_PRESET_IDS) {
    const mapping = SCHEMA_PRESETS[presetId]
    if (!mapping) continue
    const preset: CustomSchemaPreset = { presetId, mapping, workspaceId: wsId, createdAt: now, updatedAt: now }
    await storage.schemaPresets.save(preset).catch(() => {})
  }

  // --- Seed built-in plugins for this workspace ---
  await seedBuiltinPluginsForWorkspace(wsId)

  // --- Workspace internals (non-re-seedable bootstrap content) ---
  // The manifest's `internals` mirrors the old `_index.json` minus the first-class entity
  // types, which now live in `manifest.entities`. The `default` seed omits it entirely.
  const internals = manifest.internals ?? {}
  // Mapping-project folders, so the registry step can read each project's
  // source-concept-ids/ subfolder (entries now live there, not at the root).
  const mpFolders = manifest.entities
    .filter((e): e is SeedManifestEntity & { type: 'mappingProject' } => e.type === 'mappingProject')
    .map((e) => (e as { folder?: string }).folder)
    .filter((f): f is string => !!f)
  await loadWorkspaceInternals(base, wsId, now, internals, mpFolders)

  // --- Structural first-class entities (phase 1: projects, mapping projects, dq, catalogs) ---
  for (const entity of manifest.entities) {
    if (!STRUCTURAL_KINDS.has(entity.type)) continue
    try {
      await loadStructuralEntity(entity, base, wsId, now)
    } catch (err) {
      console.error(`[seed-loader] Failed to load ${entity.type} ${entity.id}:`, err)
    }
  }

  console.info(`[seed-loader] Workspace "${folder}" loaded successfully`)
}

/** Phase-1 entity kinds, loaded by loadSeedWorkspace before databases/datasets/etc. */
const STRUCTURAL_KINDS = new Set<SeedEntityKind>(['project', 'mappingProject', 'dqRuleSet', 'catalog', 'etlPipeline'])

/** Load one structural (phase-1) entity. Idempotent via a uniform `linkr-seed-<type>-<id>` flag. */
async function loadStructuralEntity(
  entity: SeedManifestEntity, base: string, wsId: string, now: string,
): Promise<void> {
  const storage = getStorage()
  const flag = `${entity.type}-${entity.id}`
  if (localStorage.getItem(`linkr-seed-${flag}`)) return

  switch (entity.type) {
    case 'project': {
      const folder = entity.folder
      const project = await fetchJson<Project>(`${base}/projects/${folder}/project.json`)
      if (!project?.uid) return
      const readmeByLang: LocalizedString = {}
      for (const lang of SEED_LANGUAGES) {
        const suffix = lang === 'en' ? '' : `.${lang}`
        const text = await fetchMarkdown(`${base}/projects/${folder}/README${suffix}.md`)
        if (text) readmeByLang[lang] = text
      }
      const tasksData = await fetchJson<{ todos?: unknown[]; notes?: string | LocalizedString }>(`${base}/projects/${folder}/tasks.json`)
      if (Object.keys(readmeByLang).length > 0) project.readme = readmeByLang
      if (tasksData) {
        project.todos = normalizeTodos(tasksData.todos)
        project.notes = toLocalized(tasksData.notes)
      }

      const existingProject = await storage.projects.getById(project.uid)
      if (existingProject) {
        await storage.projects.update(project.uid, { ...project, workspaceId: wsId, origin: 'seed', updatedAt: now })
      } else {
        await storage.projects.create({ ...project, workspaceId: wsId, origin: 'seed', readme: project.readme ?? {}, updatedAt: now })
      }

      // Full project: load scripts, pipelines, cohorts, dashboards, datasets, etc.
      const isFull = entity.full
        || (await fetchJson(`${base}/projects/${folder}/scripts/_tree.json`)) !== null
      if (isFull) {
        await loadFullProject(project.uid, `${base}/projects/${folder}`)
      }
      break
    }
    case 'mappingProject': {
      const mpFolder = entity.folder
      const project = await fetchJson<MappingProject>(`${base}/mapping-projects/${mpFolder}/_project.json`)
        ?? await fetchJson<MappingProject>(`${base}/mapping-projects/${mpFolder}/project.json`)
      if (!project) return
      // Restore source concepts from CSV (file-based projects)
      if (project.sourceType === 'file' && project.fileSourceData) {
        const csvText = await fetchText(`${base}/mapping-projects/${mpFolder}/source-concepts.csv`)
        if (csvText) restoreFileSourceDataFromCsv(project, csvText)
      }
      await storage.mappingProjects.create({ ...project, workspaceId: wsId, origin: 'seed', updatedAt: now }).catch(() => {})
      const mappings = await fetchJson<ConceptMapping[]>(`${base}/mapping-projects/${mpFolder}/mappings.json`) ?? []
      if (mappings.length > 0) {
        await storage.conceptMappings.createBatch(mappings.map(m => ({ ...m, projectId: project.id }))).catch(() => {})
      }
      // Optional precomputed similarity scores (present only when the export bundled them)
      const scoresBuf = await fetchBinary(`${base}/mapping-projects/${mpFolder}/similarity-scores.parquet`)
      if (scoresBuf && scoresBuf.byteLength > 0) {
        const scoresFile = new File([scoresBuf], `${project.id}.parquet`, { type: 'application/octet-stream' })
        if (isServerMode()) {
          const { persistScoresFileOnServer } = await import('@/lib/api/scores')
          await persistScoresFileOnServer(project.id, scoresFile).catch(() => {})
        } else {
          const { persistScoresFile } = await import('@/lib/concept-mapping/scores-engine')
          await persistScoresFile(project.id, scoresFile).catch(() => {})
        }
      }
      break
    }
    case 'dqRuleSet': {
      const bundle = await fetchJson<{ ruleSet: DqRuleSet; checks: Array<{ id: string; ruleSetId: string; [k: string]: unknown }> }>(`${base}/${entity.path}`)
      if (!bundle?.ruleSet) return
      await storage.dqRuleSets.create({ ...bundle.ruleSet, workspaceId: wsId, origin: 'seed', updatedAt: now }).catch(() => {})
      for (const check of bundle.checks ?? []) {
        await storage.dqCustomChecks.create({ ...check, ruleSetId: bundle.ruleSet.id } as import('@/types').DqCustomCheck).catch(() => {})
      }
      break
    }
    case 'catalog': {
      const cat = await fetchJson<DataCatalog>(`${base}/${entity.path}`)
      if (!cat) return
      await storage.dataCatalogs.create({ ...cat, workspaceId: wsId, origin: 'seed', updatedAt: now }).catch(() => {})
      break
    }
    case 'etlPipeline': {
      const etlFolder = entity.folder
      const pipeline = await fetchJson<EtlPipeline>(`${base}/etl/${etlFolder}/_pipeline.json`)
      if (!pipeline) return
      await storage.etlPipelines.create({ ...pipeline, workspaceId: wsId, origin: 'seed', updatedAt: now }).catch(() => {})
      // Optional script-file tree (the generated ETL scripts themselves are seeded
      // in phase 2 via the etlScript entry; older exports may ship a _tree.json).
      const tree = fromPathTree<EtlFile & { path: string }>(
        readPathTree(await fetchJson(`${base}/etl/${etlFolder}/_tree.json`)),
        pipeline.id,
        'pipelineId',
      )
      for (const f of tree) {
        if (f.type === 'file') {
          const content = await fetchText(`${base}/etl/${etlFolder}/${f.path}`)
          if (content !== null) f.content = content
        }
        await storage.etlFiles.create(storablePathNode(f)).catch(() => {})
      }
      break
    }
  }

  localStorage.setItem(`linkr-seed-${flag}`, '1')
}

/** Load the non-re-seedable bootstrap content of a workspace (wiki, sql, etl pipelines, …). */
async function loadWorkspaceInternals(
  base: string, wsId: string, now: string, index: WorkspaceInternals, mpFolders: string[] = [],
): Promise<void> {
  const storage = getStorage()

  // --- schemas/ ---
  for (const path of index.schemas ?? []) {
    const sp = await fetchJson<CustomSchemaPreset>(`${base}/${path}`)
    if (!sp) continue
    await storage.schemaPresets.save({ ...sp, workspaceId: wsId }).catch(() => {})
  }

  // --- databases/ (metadata only, no credentials/files) ---
  for (const path of index.databases ?? []) {
    const ds = await fetchJson<Partial<DataSource>>(`${base}/${path}`)
    if (!ds?.id) continue
    const existingDs = await storage.dataSources.getById(ds.id)
    if (existingDs) continue
    await storage.dataSources.create({
      ...ds,
      workspaceId: wsId,
      status: 'disconnected',
      origin: 'seed',
      createdAt: now,
      updatedAt: now,
    } as DataSource)
  }

  // --- wiki/ ---
  const wikiTree = await fetchJson<Omit<WikiPage, 'content' | 'history'>[]>(`${base}/wiki/_tree.json`)
  if (wikiTree) {
    for (const meta of wikiTree) {
      // Content lives in <folder>.md (en/first) + <folder>.<lang>.md per language.
      const folder = meta.entityId
      const content: LocalizedString = {}
      for (const p of index.wikiPages ?? []) {
        if (!p.startsWith('wiki/') || !p.endsWith('.md')) continue
        const rel = p.slice('wiki/'.length, -'.md'.length)
        const langMatch = /\.([a-z]{2})$/.exec(rel)
        const lang = langMatch ? langMatch[1] : 'en'
        const pageBase = langMatch ? rel.slice(0, -3) : rel
        const matches = folder ? pageBase === folder : pageBase.endsWith(`--${meta.id}`)
        if (!matches) continue
        const text = await fetchMarkdown(`${base}/${p}`)
        if (text != null) content[lang] = text
      }
      const title = toLocalized((meta as { title?: string | LocalizedString }).title)
      await storage.wikiPages.create({ ...meta, title, content, history: [], workspaceId: wsId, updatedAt: now } as WikiPage).catch(() => {})
    }
  }

  // --- sql-scripts/ ---
  for (const colFolder of index.sqlCollections ?? []) {
    const collection = await fetchJson<SqlScriptCollection>(`${base}/sql-scripts/${colFolder}/_collection.json`)
    if (!collection) continue
    await storage.sqlScriptCollections.create({ ...collection, workspaceId: wsId, updatedAt: now }).catch(() => {})
    // Content lives at the file's tree path (`queries/cohort.sql`), which is also
    // its manifest key — a nested script used to be looked up at a flat
    // `<folder>/<name>` and silently seeded empty.
    const tree = fromPathTree<SqlScriptFile & { path: string }>(
      readPathTree(await fetchJson(`${base}/sql-scripts/${colFolder}/_tree.json`)),
      collection.id,
      'collectionId',
    )
    for (const f of tree) {
      if (f.type === 'file' && index.sqlScriptFiles?.[`${colFolder}/${f.path}`]) {
        const content = await fetchText(`${base}/sql-scripts/${colFolder}/${f.path}`)
        if (content !== null) f.content = content
      }
      await storage.sqlScriptFiles.create(storablePathNode(f)).catch(() => {})
    }
  }

  // --- etl/ (pipeline rows + script files; the generated scripts are seeded in phase 2) ---
  for (const etlFolder of index.etlPipelines ?? []) {
    const pipeline = await fetchJson<EtlPipeline>(`${base}/etl/${etlFolder}/_pipeline.json`)
    if (!pipeline) continue
    await storage.etlPipelines.create({ ...pipeline, workspaceId: wsId, origin: 'seed', updatedAt: now }).catch(() => {})
    const tree = fromPathTree<EtlFile & { path: string }>(
      readPathTree(await fetchJson(`${base}/etl/${etlFolder}/_tree.json`)),
      pipeline.id,
      'pipelineId',
    )
    for (const f of tree) {
      if (f.type === 'file' && index.etlFiles?.[`${etlFolder}/${f.path}`]) {
        const content = await fetchText(`${base}/etl/${etlFolder}/${f.path}`)
        if (content !== null) f.content = content
      }
      await storage.etlFiles.create(storablePathNode(f)).catch(() => {})
    }
  }

  // --- concept-sets/ ---
  for (const path of index.conceptSets ?? []) {
    const cs = await fetchJson<ConceptSet>(`${base}/${path}`)
    if (!cs) continue
    await storage.conceptSets.create({ ...cs, workspaceId: wsId, updatedAt: now }).catch(() => {})
  }

  // --- source-concept-ids/ registry: root ranges + per-project entries, merged.
  // Ownership model (docs/architecture.md, "Versioning (as-built)"): the
  // root holds the whole-workspace RANGES; each mapping project's subfolder owns
  // its ENTRIES. A legacy root entries.json is still read as a fallback. The merge
  // keeps nextId monotone and lets a project's fresher range win over a stale root.
  const projectGroups: SourceConceptIdGroup[] = []
  for (const mpFolder of mpFolders) {
    const pRanges = await fetchJson<SourceConceptIdRange[]>(`${base}/mapping-projects/${mpFolder}/source-concept-ids/ranges.json`) ?? []
    const pRaw = await fetchJson<CompactSourceConceptIdEntries | SourceConceptIdEntry[]>(`${base}/mapping-projects/${mpFolder}/source-concept-ids/entries.json`)
    const pEntries = pRaw ? parseSourceConceptIdEntries(pRaw, wsId) : []
    if (pRanges.length > 0 || pEntries.length > 0) projectGroups.push({ ranges: pRanges, entries: pEntries })
  }
  const rootRanges = await fetchJson<SourceConceptIdRange[]>(`${base}/source-concept-ids/ranges.json`) ?? []
  const rootRaw = await fetchJson<CompactSourceConceptIdEntries | SourceConceptIdEntry[]>(`${base}/source-concept-ids/entries.json`)
  const rootEntries = rootRaw ? parseSourceConceptIdEntries(rootRaw, wsId) : []
  const merged = mergeSourceConceptIdRegistry(projectGroups, { ranges: rootRanges, entries: rootEntries })
  for (const range of merged.ranges) {
    await storage.sourceConceptIdRanges.save({ ...range, workspaceId: wsId, createdAt: now, updatedAt: now }).catch(() => {})
  }
  if (merged.entries.length > 0) {
    await storage.sourceConceptIdEntries.saveBatch(
      merged.entries.map(e => ({ ...e, workspaceId: wsId }))
    ).catch(() => {})
  }

  // --- service-mappings/ ---
  for (const path of index.serviceMappings ?? []) {
    const sm = await fetchJson<ServiceMapping>(`${base}/${path}`)
    if (!sm) continue
    await storage.serviceMappings.create({ ...sm, workspaceId: wsId, updatedAt: now }).catch(() => {})
  }

  // --- plugins/ ---
  for (const pluginFolder of index.pluginFolders ?? []) {
    const pluginMeta = await fetchJson<{ id: string; createdAt: string; updatedAt: string }>(`${base}/plugins/${pluginFolder}/_plugin.json`)
    if (!pluginMeta) continue
    const files: Record<string, string> = {}
    for (const fileName of index.pluginFiles?.[pluginFolder] ?? []) {
      const content = await fetchText(`${base}/plugins/${pluginFolder}/${fileName}`)
      if (content !== null) files[fileName] = content
    }
    const userPlugin: UserPlugin = {
      id: pluginMeta.id,
      entityId: pluginMeta.id,
      files,
      workspaceId: wsId,
      createdAt: pluginMeta.createdAt,
      updatedAt: now,
    }
    await storage.userPlugins.create(userPlugin).catch(() => {})
  }
}

/**
 * Non-re-seedable bootstrap content of a workspace, listed in `manifest.internals`.
 * Mirrors the old `_index.json` minus the first-class entity types, which are now
 * `manifest.entities`. (We can't list directories via fetch, hence these explicit lists.)
 */
export interface WorkspaceInternals {
  schemas?: string[]
  databases?: string[]
  wikiPages?: string[]             // paths like 'wiki/slug--id.md'
  sqlCollections?: string[]        // folder names under sql-scripts/
  sqlScriptFiles?: Record<string, string>  // 'collection/<tree path>' → relative path
  etlPipelines?: string[]          // folder names under etl/ (pipeline rows + files)
  etlFiles?: Record<string, string>  // 'pipeline/<tree path>' → relative path
  conceptSets?: string[]           // paths like 'concept-sets/slug.json'
  serviceMappings?: string[]       // paths like 'service-mappings/slug.json'
  pluginFolders?: string[]         // folder names under plugins/
  pluginFiles?: Record<string, string[]>  // folder → list of file names
}

/** Index of files in a full project seed folder */
interface SeedProjectIndex {
  /** IDE script files: paths relative to scripts/ (e.g. 'analysis.py') */
  scripts?: string[]
  /** Pipeline JSON files under pipeline/ */
  pipelines?: string[]
  /** Cohort JSON files under cohorts/ */
  cohorts?: string[]
  /** Database/connection JSON files under databases/ */
  connections?: string[]
  /** Dashboard JSON files under dashboards/ (bundled: dashboard + tabs + widgets) */
  dashboards?: string[]
  /** Dataset folder names under datasets/ */
  datasetFolders?: string[]
  /** Dataset analysis JSON paths: 'folder/analysis.json' */
  datasetAnalyses?: Record<string, string[]>
  /** Dataset CSV paths: 'folder/data.csv' */
  datasetCsvFiles?: Record<string, string>
  /** Original uploaded data file per folder (CSV/XLSX/parquet), filename only. */
  datasetRawFiles?: Record<string, string>
  /** Folders that ship a parsed-rows sidecar (_data.json) for format-agnostic restore. */
  datasetDataSidecars?: string[]
  /** Attachment file names under attachments/ */
  attachments?: string[]
}

// ---------------------------------------------------------------------------
// Database seeding (Parquet files)
// ---------------------------------------------------------------------------

/**
 * Seed a database from Parquet files.
 * Fetches files in parallel, stores in IndexedDB, mounts in DuckDB.
 */
async function seedDatabase(db: SeedDatabase, wsId: string): Promise<void> {
  const lsKey = `linkr-seed-database-${db.id}`
  if (localStorage.getItem(lsKey)) return

  const storage = getStorage()

  // Guard: already exists in IDB
  const existing = await storage.dataSources.getById(db.id)
  if (existing) {
    localStorage.setItem(lsKey, '1')
    return
  }

  const now = new Date().toISOString()

  if (db.inMemory) {
    // In-memory database (no Parquet files, e.g. ETL target)
    const schemaMapping = typeof db.schema === 'string' ? getSchemaPreset(db.schema)! : db.schema
    const connectionConfig: DatabaseConnectionConfig = {
      engine: 'duckdb',
      fileIds: [],
      fileNames: [],
      inMemory: true,
    }
    const dataSource: DataSource = {
      id: db.id,
      alias: db.alias,
      name: db.name,
      description: db.description,
      sourceType: 'database',
      connectionConfig,
      schemaMapping,
      status: 'connected',
      origin: 'seed',
      workspaceId: wsId,
      createdAt: now,
      updatedAt: now,
    }
    await storage.dataSources.create(dataSource)
    // Server mode: no browser WASM mount (the empty schema is materialized
    // server-side on first query). Front-only mounts it in DuckDB-WASM.
    if (!isServerMode()) {
      await engine.mountEmptyFromDDL(db.id, schemaMapping.ddl!, db.alias)
    }
    localStorage.setItem(lsKey, '1')
    console.info(`[seed-loader] In-memory database "${db.name}" created`)
    return
  }

  // Server mode: the default Parquet databases are pre-loaded server-side
  // (portal build), so the browser neither fetches the files nor mounts them
  // in DuckDB-WASM. A source pointing at browser-only IDB file ids would be
  // broken here, so skip the whole Parquet path — front-only keeps it below.
  if (isServerMode()) {
    localStorage.setItem(lsKey, '1')
    return
  }

  // Fetch all Parquet files in parallel
  const fetched = await Promise.all(
    db.tables.map(async (name) => {
      const res = await fetch(`${db.parquetBase}/${name}.parquet`)
      if (!res.ok) throw new Error(`Failed to fetch ${name}.parquet: ${res.status}`)
      const data = await res.arrayBuffer()
      return { name, data }
    }),
  )

  // Store files in IndexedDB
  const storedFiles: StoredFile[] = []
  for (const { name, data } of fetched) {
    const stored: StoredFile = {
      id: crypto.randomUUID(),
      dataSourceId: db.id,
      fileName: `${name}.parquet`,
      fileSize: data.byteLength,
      data,
      createdAt: now,
    }
    storedFiles.push(stored)
    await storage.files.create(stored)
  }

  // Create DataSource
  const schemaMapping = typeof db.schema === 'string' ? getSchemaPreset(db.schema)! : db.schema
  const connectionConfig: DatabaseConnectionConfig = {
    engine: 'duckdb',
    fileIds: storedFiles.map((f) => f.id),
    fileNames: storedFiles.map((f) => f.fileName),
  }

  const dataSource: DataSource = {
    id: db.id,
    alias: db.alias,
    name: db.name,
    description: db.description,
    sourceType: 'database',
    connectionConfig,
    schemaMapping,
    isVocabularyReference: db.isVocabularyReference,
    status: 'configuring',
    origin: 'seed',
    workspaceId: wsId,
    createdAt: now,
    updatedAt: now,
  }

  await storage.dataSources.create(dataSource)

  // Mount in DuckDB and compute stats
  await engine.mountDataSource(dataSource, storedFiles)
  const stats = await engine.computeStats(db.id, schemaMapping)
  await storage.dataSources.update(db.id, { status: 'connected', stats })

  // Link to project if specified
  if (db.linkToProject) {
    const project = await storage.projects.getById(db.linkToProject)
    if (project) {
      const linkedIds = project.linkedDataSourceIds ?? []
      if (!linkedIds.includes(db.id)) {
        await storage.projects.update(db.linkToProject, {
          linkedDataSourceIds: [...linkedIds, db.id],
        })
      }
    }
  }

  localStorage.setItem(lsKey, '1')
  console.info(`[seed-loader] Database "${db.name}" seeded (${storedFiles.length} tables)`)
}

// ---------------------------------------------------------------------------
// Concept mappings seeding (from compact JSON)
// ---------------------------------------------------------------------------

interface CompactMapping {
  sn: string; sc: string; sv: string; cat?: string
  ti: number; tn: string; tv: string; td: string; tc: string
}

async function seedConceptMappings(config: SeedConceptMappings): Promise<void> {
  const lsKey = `linkr-seed-conceptMapping-${config.projectId}`
  if (localStorage.getItem(lsKey)) return

  const storage = getStorage()
  const existingMappings = await storage.conceptMappings.getByProject(config.projectId)
  if (existingMappings.length > 0) {
    localStorage.setItem(lsKey, '1')
    return
  }

  const now = new Date().toISOString()
  const raw = await fetchJson<CompactMapping[]>(config.file)
  if (!raw?.length) return

  const mappings: ConceptMapping[] = raw.map((m, i) => ({
    id: `seed-mapping-${config.projectId}-${String(i).padStart(4, '0')}`,
    projectId: config.projectId,
    sourceConceptId: Number(m.sc),
    sourceConceptName: m.sn,
    sourceVocabularyId: m.sv,
    sourceDomainId: '',
    sourceConceptCode: m.sc,
    sourceCategoryId: m.cat,
    targetConceptId: m.ti,
    targetConceptName: m.tn,
    targetVocabularyId: m.tv,
    targetDomainId: m.td,
    targetConceptCode: m.tc,
    mappingType: 'maps_to' as const,
    equivalence: 'skos:exactMatch' as const,
    status: 'approved' as const,
    mappedBy: 'OHDSI ETL',
    mappedOn: now,
    createdAt: now,
    updatedAt: now,
  }))

  await storage.conceptMappings.createBatch(mappings)
  localStorage.setItem(lsKey, '1')
  console.info(`[seed-loader] ${mappings.length} concept mappings seeded for project ${config.projectId}`)
}

// ---------------------------------------------------------------------------
// ETL scripts seeding
// ---------------------------------------------------------------------------

interface EtlScriptRow {
  folder: string
  name: string
  order: number
  content: string
}

async function seedEtlScripts(config: SeedEtlScripts): Promise<void> {
  const lsKey = `linkr-seed-etlScript-${config.pipelineId}`
  if (localStorage.getItem(lsKey)) return

  const storage = getStorage()
  const existingFiles = await storage.etlFiles.getByPipeline(config.pipelineId)
  if (existingFiles.length > 0) {
    localStorage.setItem(lsKey, '1')
    return
  }

  const now = new Date().toISOString()
  const scripts = await fetchJson<EtlScriptRow[]>(config.file)
  if (!scripts?.length) return

  // Generate 00_vocabulary.sql if possible
  let vocabContent: string | null = null
  if (config.mappingProjectId && config.vocabularyDataSourceId) {
    try {
      const mappings = await storage.conceptMappings.getByProject(config.mappingProjectId)
      if (mappings.length > 0) {
        // Defaults to the `vocab.` role prefix, resolved at run time — the seeded
        // script must be as portable as one generated from the Vocabulary tab.
        vocabContent = buildVocabularyScript(mappings)
      }
    } catch { /* ignore */ }
  }

  // Generate 00b_custom_vocabulary.sql if custom mappings file provided
  let customVocabContent: string | null = null
  if (config.customMappingsFile) {
    try {
      const customRows = await fetchJson<CustomMappingRow[]>(config.customMappingsFile)
      if (customRows?.length) {
        customVocabContent = buildCustomVocabularyScript(customRows)
      }
    } catch { /* ignore */ }
  }

  for (const script of scripts) {
    let content = script.content
    if (script.name === '00_vocabulary.sql' && vocabContent) content = vocabContent
    else if (script.name === '00b_custom_vocabulary.sql' && customVocabContent) content = customVocabContent
    const file: EtlFile = {
      id: `seed-etl-${config.pipelineId}-${script.name.replace('.sql', '')}`,
      pipelineId: config.pipelineId,
      name: script.name,
      type: 'file',
      parentId: null,
      content,
      language: 'sql',
      order: script.order,
      createdAt: now,
    }
    await storage.etlFiles.create(file)
  }

  localStorage.setItem(lsKey, '1')
  console.info(`[seed-loader] ${scripts.length} ETL scripts seeded for pipeline ${config.pipelineId}`)
}

// ---------------------------------------------------------------------------
// Dataset seeding
// ---------------------------------------------------------------------------

async function seedDataset(config: SeedDataset): Promise<void> {
  const lsKey = `linkr-seed-dataset-${config.id}`
  if (localStorage.getItem(lsKey)) return

  const storage = getStorage()
  const existing = await storage.datasetFiles.getById(config.id)
  if (existing) {
    localStorage.setItem(lsKey, '1')
    return
  }

  const data = await fetchJson<{ columns: DatasetColumn[]; rows: Record<string, unknown>[] }>(config.file)
  if (!data) return

  const now = new Date().toISOString()
  const datasetFile: DatasetFile = {
    id: config.id,
    projectUid: config.projectUid,
    name: config.fileName,
    type: 'file',
    parentId: null,
    columns: data.columns,
    rowCount: data.rows.length,
    origin: 'seed',
    createdAt: now,
    updatedAt: now,
  }

  await storage.datasetFiles.create(datasetFile)
  // Server mode: rows are pre-provisioned server-side and the API adapter's save()
  // is a no-op, so only persist rows into the browser store in front-only mode.
  if (!isServerMode()) {
    await storage.datasetData.save({ datasetFileId: config.id, rows: data.rows })
  }

  localStorage.setItem(lsKey, '1')
  console.info(`[seed-loader] Dataset "${config.fileName}" seeded: ${data.rows.length} rows`)
}

// ---------------------------------------------------------------------------
// Dashboard seeding
// ---------------------------------------------------------------------------

async function seedDashboardFromFile(config: SeedDashboard): Promise<void> {
  const lsKey = `linkr-seed-dashboard-${config.id}`
  if (localStorage.getItem(lsKey)) return

  const data = await fetchJson<{
    dashboard: Dashboard
    tabs: DashboardTab[]
    widgets: DashboardWidget[]
  }>(config.file)
  if (!data?.dashboard) return

  const storage = getStorage()
  const existing = await storage.dashboards.getById(data.dashboard.id)
  if (existing) {
    localStorage.setItem(lsKey, '1')
    return
  }

  await storage.dashboards.create({ ...data.dashboard, projectUid: config.projectUid, origin: 'seed' })
  for (const tab of data.tabs) {
    await storage.dashboardTabs.create(tab)
  }
  for (const w of data.widgets) {
    await storage.dashboardWidgets.create(w)
  }

  localStorage.setItem(lsKey, '1')
  console.info(`[seed-loader] Dashboard seeded for project ${config.projectUid}`)
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Check if seeding has already been done.
 */
export function isSeeded(): boolean {
  return !!localStorage.getItem(SEED_KEY)
}

/** Clear a per-entity seed guard flag (e.g. 'dataset-<id>', 'database-<id>') so it re-seeds. */
export function clearSeedFlag(suffix: string): void {
  localStorage.removeItem(`linkr-seed-${suffix}`)
}

/** Clear the global seed guard so seedWorkspaces() re-imports workspace-scoped entities. */
export function clearGlobalSeedFlag(): void {
  localStorage.removeItem(SEED_KEY)
}

/**
 * Find the seed entities that belong to a project (datasets/dashboards attached via
 * projectUid). Used by the targeted re-seed to cascade a project re-import to its children,
 * declaratively from the manifest instead of hardcoding the child types.
 */
export async function fetchProjectChildEntities(
  projectUid: string,
): Promise<Array<{ type: SeedEntityKind; id: string }>> {
  const children: Array<{ type: SeedEntityKind; id: string }> = []
  const folders = await fetchSeedRoot()
  for (const folder of folders) {
    const manifest = await fetchWorkspaceManifest(folder)
    if (!manifest) continue
    for (const entity of manifest.entities) {
      if ((entity.type === 'dataset' || entity.type === 'dashboard') && entity.projectUid === projectUid) {
        children.push({ type: entity.type, id: entity.id })
      }
    }
  }
  return children
}

/** Fetch the root seed.json and return its (validated) list of workspace folders. */
async function fetchSeedRoot(): Promise<string[]> {
  const root = await fetchJson<SeedManifest>(`${SEED_BASE}/seed.json`)
  return root?.workspaces ?? []
}

/** Fetch and lightly validate a workspace's unified manifest. */
async function fetchWorkspaceManifest(folder: string): Promise<WorkspaceManifest | null> {
  const manifest = await fetchJson<WorkspaceManifest>(`${SEED_BASE}/${folder}/manifest.json`)
  if (!manifest || !Array.isArray(manifest.entities)) {
    console.warn(`[seed-loader] No valid manifest.json in ${folder}, skipping`)
    return null
  }
  return manifest
}

/** Phase-2 entity kinds, in dependency order (databases → mappings → etl → datasets → dashboards). */
const DATA_KIND_ORDER: SeedEntityKind[] = ['database', 'conceptMapping', 'etlScript', 'dataset', 'dashboard']

/** Load one data (phase-2) entity. Each seeder owns its own uniform guard flag + IDB check. */
async function loadDataEntity(entity: SeedManifestEntity, wsId: string): Promise<void> {
  switch (entity.type) {
    case 'database': return seedDatabase({ ...entity }, wsId)
    case 'conceptMapping': return seedConceptMappings(entity)
    case 'etlScript': return seedEtlScripts(entity)
    case 'dataset': return seedDataset(entity)
    case 'dashboard': return seedDashboardFromFile(entity)
  }
}

/**
 * Load all seed data on first launch.
 * Called from app-store loadProjects() when no workspaces exist.
 *
 * Phase 1: Loads workspace structure (metadata, internals, projects, mapping projects, dq,
 * catalogs). Returns quickly so the UI can render. Databases/datasets/dashboards/mappings/etl
 * are loaded in phase 2 (seedDatabases) — they depend on these rows.
 */
export async function seedWorkspaces(): Promise<void> {
  if (isSeeded()) return

  const folders = await fetchSeedRoot()
  if (!folders.length) {
    console.warn('[seed-loader] No seed.json found or empty, skipping seed')
    localStorage.setItem(SEED_KEY, '1')
    return
  }

  for (const folder of folders) {
    try {
      const manifest = await fetchWorkspaceManifest(folder)
      if (manifest) await loadSeedWorkspace(folder, manifest)
    } catch (err) {
      console.error(`[seed-loader] Failed to load workspace "${folder}":`, err)
    }
  }

  localStorage.setItem(SEED_KEY, '1')
  console.info('[seed-loader] All workspaces seeded')
}

/**
 * Phase 2: Seed databases, concept mappings, ETL scripts, datasets, dashboards.
 * Called from App.tsx after stores are loaded. Entities load in dependency order
 * (DATA_KIND_ORDER); each step is idempotent via its uniform localStorage flag.
 */
export async function seedDatabases(): Promise<void> {
  const folders = await fetchSeedRoot()
  if (!folders.length) return

  for (const folder of folders) {
    const workspace = await fetchJson<Workspace>(`${SEED_BASE}/${folder}/workspace.json`)
    if (!workspace?.id) continue
    const wsId = workspace.id

    const manifest = await fetchWorkspaceManifest(folder)
    if (!manifest) continue

    for (const kind of DATA_KIND_ORDER) {
      for (const entity of manifest.entities) {
        if (entity.type !== kind) continue
        try {
          await loadDataEntity(entity, wsId)
        } catch (err) {
          console.error(`[seed-loader] Failed to seed ${entity.type} ${entity.id}:`, err)
        }
      }
    }
  }

  console.info('[seed-loader] Database seeding complete')
}
