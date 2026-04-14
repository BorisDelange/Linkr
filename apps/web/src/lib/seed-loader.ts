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
import * as engine from '@/lib/duckdb/engine'
import { BUILTIN_PRESET_IDS, SCHEMA_PRESETS, getSchemaPreset } from '@/lib/schema-presets'
import { getAllPlugins } from '@/lib/plugins/registry'
import { buildVocabularyScript, buildCustomVocabularyScript } from '@/features/warehouse/etl/build-vocabulary-script'
import { restoreFileSourceDataFromCsv } from '@/lib/concept-mapping/export'
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
} from '@/types'

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
  /** Project UID to attach to */
  projectUid: string
}

/** A single workspace entry in seed.json */
export interface SeedWorkspaceEntry {
  /** Folder name inside public/data/seed/ */
  folder: string
  /** Organization metadata (optional, created if provided) */
  organization?: Organization
  /** Databases to seed with Parquet data */
  databases?: SeedDatabase[]
  /** Concept mappings to seed from JSON files */
  conceptMappings?: SeedConceptMappings[]
  /** ETL scripts to seed */
  etlScripts?: SeedEtlScripts[]
  /** Datasets to seed */
  datasets?: SeedDataset[]
  /** Dashboards to seed */
  dashboards?: SeedDashboard[]
}

/** Root seed.json schema */
export interface SeedManifest {
  workspaces: SeedWorkspaceEntry[]
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
    return await res.text()
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
  const now = new Date().toISOString()

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
    await storage.dashboards.create({ ...bundle.dashboard, projectUid }).catch(() => {})
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
      await storage.datasetFiles.create({ ...df, projectUid }).catch(() => {})
    }

    // Load analyses
    for (const [folder, analyses] of Object.entries(projectIndex?.datasetAnalyses ?? {})) {
      for (const analysisPath of analyses) {
        const analysis = await fetchJson<import('@/types').DatasetAnalysis>(`${base}/datasets/${folder}/${analysisPath}`)
        if (analysis) await storage.datasetAnalyses.create(analysis).catch(() => {})
      }
    }

    // Load CSV data
    for (const [folder, csvPath] of Object.entries(projectIndex?.datasetCsvFiles ?? {})) {
      const df = datasetFiles.find(f => f.name.replace(/\.[^.]+$/, '') === folder && f.type === 'file')
      if (!df) continue
      const csv = await fetchText(`${base}/datasets/${folder}/${csvPath}`)
      if (!csv) continue
      // Simple CSV parse — reuse the parseCsvToDatasetData pattern
      const rows = parseSeedCsv(csv, df)
      if (rows.length > 0) {
        await storage.datasetData.save({ datasetFileId: df.id, rows }).catch(() => {})
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
          ...meta, projectUid, data,
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
 * Load and persist a workspace from its seed folder.
 * Reads the same structure as a workspace export ZIP, but from individual files.
 */
async function loadSeedWorkspace(entry: SeedWorkspaceEntry): Promise<void> {
  const storage = getStorage()
  const base = `${SEED_BASE}/${entry.folder}`
  const now = new Date().toISOString()

  // --- Organization ---
  if (entry.organization) {
    const existing = await storage.organizations.getById(entry.organization.id)
    if (!existing) {
      await storage.organizations.create(entry.organization)
    }
  }

  // --- workspace.json ---
  const workspace = await fetchJson<Workspace>(`${base}/workspace.json`)
  if (!workspace?.id) {
    console.warn(`[seed-loader] No valid workspace.json in ${entry.folder}, skipping`)
    return
  }

  // README.md
  const readme = await fetchText(`${base}/README.md`)
  if (readme) workspace.readme = readme

  const existing = await storage.workspaces.getById(workspace.id)
  if (existing) {
    await storage.workspaces.update(workspace.id, { ...workspace, updatedAt: now })
  } else {
    await storage.workspaces.create(workspace)
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
  for (const p of getAllPlugins()) {
    if (p.workspaceId) continue // skip non-built-in
    const files: Record<string, string> = { 'plugin.json': JSON.stringify(p.manifest, null, 2) }
    if (p.templates) {
      for (const [lang, content] of Object.entries(p.templates)) {
        const ext = lang === 'r' ? '.R.template' : '.py.template'
        files[`analysis${ext}`] = content
      }
    }
    const userPlugin: UserPlugin = { id: p.manifest.id, entityId: p.manifest.id, files, workspaceId: wsId, createdAt: now, updatedAt: now }
    await storage.userPlugins.create(userPlugin).catch(() => {})
  }

  // --- _index.json (lists all files in the seed folder) ---
  // Since we can't list files via fetch, we need an index file
  const index = await fetchJson<SeedFolderIndex>(`${base}/_index.json`)
  if (!index) {
    console.warn(`[seed-loader] No _index.json in ${entry.folder}, skipping content import`)
    return
  }

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
      createdAt: now,
      updatedAt: now,
    } as DataSource)
  }

  // --- projects/ ---
  const fullProjectSet = new Set(index.fullProjects ?? [])
  for (const folder of index.projects ?? []) {
    const project = await fetchJson<Project>(`${base}/projects/${folder}/project.json`)
    if (!project?.uid) continue
    const projectReadme = await fetchText(`${base}/projects/${folder}/README.md`)
    const tasksData = await fetchJson<{ todos?: unknown[]; notes?: string }>(`${base}/projects/${folder}/tasks.json`)
    if (projectReadme) project.readme = projectReadme
    if (tasksData) {
      project.todos = (tasksData.todos ?? []) as Project['todos']
      project.notes = tasksData.notes ?? ''
    }

    const existingProject = await storage.projects.getById(project.uid)
    if (existingProject) {
      await storage.projects.update(project.uid, { ...project, workspaceId: wsId, updatedAt: now })
    } else {
      await storage.projects.create({ ...project, workspaceId: wsId, readme: project.readme ?? '', updatedAt: now })
    }

    // Full project: load scripts, pipelines, cohorts, dashboards, datasets, etc.
    const isFull = fullProjectSet.has(folder)
      || (await fetchJson(`${base}/projects/${folder}/scripts/_tree.json`)) !== null
    if (isFull) {
      await loadFullProject(project.uid, `${base}/projects/${folder}`)
    }
  }

  // --- wiki/ ---
  const wikiTree = await fetchJson<Omit<WikiPage, 'content' | 'history'>[]>(`${base}/wiki/_tree.json`)
  if (wikiTree) {
    for (const meta of wikiTree) {
      // Find matching markdown file
      const mdPath = index.wikiPages?.find(p => p.endsWith(`--${meta.id}.md`))
      const content = mdPath ? await fetchText(`${base}/${mdPath}`) ?? '' : ''
      await storage.wikiPages.create({ ...meta, content, history: [], workspaceId: wsId, updatedAt: now } as WikiPage).catch(() => {})
    }
  }

  // --- sql-scripts/ ---
  for (const colFolder of index.sqlCollections ?? []) {
    const collection = await fetchJson<SqlScriptCollection>(`${base}/sql-scripts/${colFolder}/_collection.json`)
    if (!collection) continue
    await storage.sqlScriptCollections.create({ ...collection, workspaceId: wsId, updatedAt: now }).catch(() => {})
    const treeMeta = await fetchJson<SqlScriptFile[]>(`${base}/sql-scripts/${colFolder}/_tree.json`) ?? []
    for (const f of treeMeta) {
      if (f.type === 'file' && index.sqlScriptFiles?.[`${colFolder}/${f.name}`]) {
        const content = await fetchText(`${base}/sql-scripts/${colFolder}/${f.name}`)
        if (content !== null) (f as SqlScriptFile).content = content
      }
      await storage.sqlScriptFiles.create({ ...f, collectionId: collection.id }).catch(() => {})
    }
  }

  // --- etl/ ---
  for (const etlFolder of index.etlPipelines ?? []) {
    const pipeline = await fetchJson<EtlPipeline>(`${base}/etl/${etlFolder}/_pipeline.json`)
    if (!pipeline) continue
    await storage.etlPipelines.create({ ...pipeline, workspaceId: wsId, updatedAt: now }).catch(() => {})
    const treeMeta = await fetchJson<EtlFile[]>(`${base}/etl/${etlFolder}/_tree.json`) ?? []
    for (const f of treeMeta) {
      if (f.type === 'file') {
        const filePath = index.etlFiles?.[`${etlFolder}/${f.name}`]
        if (filePath) {
          const content = await fetchText(`${base}/etl/${etlFolder}/${f.name}`)
          if (content !== null) (f as EtlFile).content = content
        }
      }
      await storage.etlFiles.create({ ...f, pipelineId: pipeline.id }).catch(() => {})
    }
  }

  // --- data-quality/ ---
  for (const path of index.dqRuleSets ?? []) {
    const bundle = await fetchJson<{ ruleSet: DqRuleSet; checks: Array<{ id: string; ruleSetId: string; [k: string]: unknown }> }>(`${base}/${path}`)
    if (!bundle?.ruleSet) continue
    await storage.dqRuleSets.create({ ...bundle.ruleSet, workspaceId: wsId, updatedAt: now }).catch(() => {})
    for (const check of bundle.checks ?? []) {
      await storage.dqCustomChecks.create({ ...check, ruleSetId: bundle.ruleSet.id } as import('@/types').DqCustomCheck).catch(() => {})
    }
  }

  // --- concept-sets/ ---
  for (const path of index.conceptSets ?? []) {
    const cs = await fetchJson<ConceptSet>(`${base}/${path}`)
    if (!cs) continue
    await storage.conceptSets.create({ ...cs, workspaceId: wsId, updatedAt: now }).catch(() => {})
  }

  // --- mapping-projects/ ---
  for (const mpFolder of index.mappingProjects ?? []) {
    const project = await fetchJson<MappingProject>(`${base}/mapping-projects/${mpFolder}/_project.json`)
      ?? await fetchJson<MappingProject>(`${base}/mapping-projects/${mpFolder}/project.json`)
    if (!project) continue
    // Restore source concepts from CSV (file-based projects)
    if (project.sourceType === 'file' && project.fileSourceData) {
      const csvText = await fetchText(`${base}/mapping-projects/${mpFolder}/source-concepts.csv`)
      if (csvText) restoreFileSourceDataFromCsv(project, csvText)
    }
    await storage.mappingProjects.create({ ...project, workspaceId: wsId, updatedAt: now }).catch(() => {})
    const mappings = await fetchJson<ConceptMapping[]>(`${base}/mapping-projects/${mpFolder}/mappings.json`) ?? []
    if (mappings.length > 0) {
      await storage.conceptMappings.createBatch(mappings.map(m => ({ ...m, projectId: project.id }))).catch(() => {})
    }
  }

  // --- source-concept-ids/ (cross-project ID assignment registry) ---
  const idRanges = await fetchJson<SourceConceptIdRange[]>(`${base}/source-concept-ids/ranges.json`) ?? []
  for (const range of idRanges) {
    await storage.sourceConceptIdRanges.save({ ...range, workspaceId: wsId, updatedAt: now }).catch(() => {})
  }
  const idEntries = await fetchJson<SourceConceptIdEntry[]>(`${base}/source-concept-ids/entries.json`) ?? []
  if (idEntries.length > 0) {
    await storage.sourceConceptIdEntries.saveBatch(
      idEntries.map(e => ({ ...e, workspaceId: wsId }))
    ).catch(() => {})
  }

  // --- catalogs/ ---
  for (const path of index.catalogs ?? []) {
    const cat = await fetchJson<DataCatalog>(`${base}/${path}`)
    if (!cat) continue
    await storage.dataCatalogs.create({ ...cat, workspaceId: wsId, updatedAt: now }).catch(() => {})
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

  console.info(`[seed-loader] Workspace "${entry.folder}" loaded successfully`)
}

/** Index of files in a seed folder (needed because we can't list directories via fetch) */
interface SeedFolderIndex {
  schemas?: string[]
  databases?: string[]
  /** Project folder names. Each can be lightweight (just project.json + README.md)
   *  or full (complete project export with scripts/, dashboards/, datasets/, etc.) */
  projects?: string[]
  /** Which projects are "full" (complete export). If omitted, auto-detected by
   *  checking for scripts/_tree.json in the project folder. */
  fullProjects?: string[]
  wikiPages?: string[]             // paths like 'wiki/slug--id.md'
  sqlCollections?: string[]        // folder names under sql-scripts/
  sqlScriptFiles?: Record<string, string>  // 'collection/filename' → relative path
  etlPipelines?: string[]          // folder names under etl/
  etlFiles?: Record<string, string>  // 'pipeline/filename' → relative path
  dqRuleSets?: string[]            // paths like 'data-quality/slug.json'
  conceptSets?: string[]           // paths like 'concept-sets/slug.json'
  mappingProjects?: string[]       // folder names under mapping-projects/
  catalogs?: string[]              // paths like 'catalogs/slug.json'
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
  const lsKey = `linkr-seed-db-${db.id}`
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
      workspaceId: wsId,
      createdAt: now,
      updatedAt: now,
    }
    await storage.dataSources.create(dataSource)
    await engine.mountEmptyFromDDL(db.id, schemaMapping.ddl!, db.alias)
    localStorage.setItem(lsKey, '1')
    console.info(`[seed-loader] In-memory database "${db.name}" created`)
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
  const lsKey = `linkr-seed-mappings-${config.projectId}`
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
  const lsKey = `linkr-seed-etl-${config.pipelineId}`
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
        const vocabSchema = engine.schemaName(config.vocabularyDataSourceId)
        vocabContent = buildVocabularyScript(mappings, vocabSchema)
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
    createdAt: now,
    updatedAt: now,
  }

  await storage.datasetFiles.create(datasetFile)
  await storage.datasetData.save({ datasetFileId: config.id, rows: data.rows })

  localStorage.setItem(lsKey, '1')
  console.info(`[seed-loader] Dataset "${config.fileName}" seeded: ${data.rows.length} rows`)
}

// ---------------------------------------------------------------------------
// Dashboard seeding
// ---------------------------------------------------------------------------

async function seedDashboardFromFile(config: SeedDashboard): Promise<void> {
  const lsKey = `linkr-seed-dashboard-${config.projectUid}`
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

  await storage.dashboards.create({ ...data.dashboard, projectUid: config.projectUid })
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

/**
 * Load all seed data on first launch.
 * Called from app-store loadProjects() when no workspaces exist.
 *
 * Phase 1: Loads workspace structure (metadata, projects, mapping projects, etc.)
 * Returns quickly so the UI can render.
 */
export async function seedWorkspaces(): Promise<void> {
  if (isSeeded()) return

  const manifest = await fetchJson<SeedManifest>(`${SEED_BASE}/seed.json`)
  if (!manifest?.workspaces?.length) {
    console.warn('[seed-loader] No seed.json found or empty, skipping seed')
    localStorage.setItem(SEED_KEY, '1')
    return
  }

  for (const entry of manifest.workspaces) {
    try {
      await loadSeedWorkspace(entry)
    } catch (err) {
      console.error(`[seed-loader] Failed to load workspace "${entry.folder}":`, err)
    }
  }

  localStorage.setItem(SEED_KEY, '1')
  console.info('[seed-loader] All workspaces seeded')
}

/**
 * Phase 2: Seed databases, concept mappings, ETL scripts, datasets, dashboards.
 * Called from App.tsx after stores are loaded.
 * Each step is idempotent and guarded by localStorage flags.
 */
export async function seedDatabases(): Promise<void> {
  const manifest = await fetchJson<SeedManifest>(`${SEED_BASE}/seed.json`)
  if (!manifest?.workspaces?.length) return

  for (const entry of manifest.workspaces) {
    const workspace = await fetchJson<Workspace>(`${SEED_BASE}/${entry.folder}/workspace.json`)
    if (!workspace?.id) continue
    const wsId = workspace.id

    // Seed databases with Parquet files
    for (const db of entry.databases ?? []) {
      try {
        await seedDatabase({ ...db }, wsId)
      } catch (err) {
        console.error(`[seed-loader] Failed to seed database "${db.name}":`, err)
      }
    }

    // Seed concept mappings
    for (const cm of entry.conceptMappings ?? []) {
      try {
        await seedConceptMappings(cm)
      } catch (err) {
        console.error(`[seed-loader] Failed to seed concept mappings:`, err)
      }
    }

    // Seed ETL scripts
    for (const etl of entry.etlScripts ?? []) {
      try {
        await seedEtlScripts(etl)
      } catch (err) {
        console.error(`[seed-loader] Failed to seed ETL scripts:`, err)
      }
    }

    // Seed datasets
    for (const ds of entry.datasets ?? []) {
      try {
        await seedDataset(ds)
      } catch (err) {
        console.error(`[seed-loader] Failed to seed dataset:`, err)
      }
    }

    // Seed dashboards
    for (const db of entry.dashboards ?? []) {
      try {
        await seedDashboardFromFile(db)
      } catch (err) {
        console.error(`[seed-loader] Failed to seed dashboard:`, err)
      }
    }
  }

  console.info('[seed-loader] Database seeding complete')
}
