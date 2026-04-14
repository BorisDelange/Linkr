/**
 * Shared utilities for entity export/import (ZIP and JSON).
 */
import JSZip from 'jszip'
import type { Storage } from '@/lib/storage'
import { APP_VERSION } from '@/lib/version'
import type {
  Project, IdeFile, Pipeline, Cohort, IdeConnection,
  Dashboard, DashboardTab, DashboardWidget,
  DatasetFile, DatasetData, DatasetAnalysis, ReadmeAttachment,
  Workspace, WikiPage, WikiAttachment,
  SqlScriptCollection, SqlScriptFile,
  EtlPipeline, EtlFile,
  DqRuleSet, DqCustomCheck,
  ConceptSet, MappingProject, ConceptMapping,
  DataCatalog, ServiceMapping, UserPlugin,
  DataSource, CustomSchemaPreset,
} from '@/types'
import { buildMappingProjectFolder } from '@/lib/concept-mapping/export'

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadJson(data: unknown, filename: string): void {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  downloadBlob(blob, filename)
}

// ---------------------------------------------------------------------------
// Project cleanup (cascade-delete all project-scoped entities)
// ---------------------------------------------------------------------------

/** Delete all IDB entities associated with a project (datasets, dashboards, etc.) */
export async function deleteProjectData(storage: Storage, uid: string): Promise<void> {
  await storage.ideFiles.deleteByProject(uid).catch(() => {})
  await storage.connections.deleteByProject(uid).catch(() => {})
  await storage.readmeAttachments.deleteByProject(uid).catch(() => {})

  // Dataset files, data, raw files, analyses
  const datasetFiles = await storage.datasetFiles.getByProject(uid)
  for (const df of datasetFiles) {
    if (df.type === 'file') {
      await storage.datasetData.delete(df.id).catch(() => {})
      await storage.datasetRawFiles.delete(df.id).catch(() => {})
      await storage.datasetAnalyses.deleteByDataset(df.id).catch(() => {})
    }
  }
  await storage.datasetFiles.deleteByProject(uid).catch(() => {})

  // Dashboards (+ tabs + widgets)
  const dashboards = await storage.dashboards.getByProject(uid)
  for (const d of dashboards) {
    const tabs = await storage.dashboardTabs.getByDashboard(d.id)
    for (const tab of tabs) await storage.dashboardWidgets.deleteByTab(tab.id)
    await storage.dashboardTabs.deleteByDashboard(d.id)
    await storage.dashboards.delete(d.id)
  }

  // Pipelines & cohorts
  const pipelines = await storage.pipelines.getByProject(uid)
  for (const pl of pipelines) await storage.pipelines.delete(pl.id)
  const cohorts = await storage.cohorts.getByProject(uid)
  for (const c of cohorts) await storage.cohorts.delete(c.id)
}

// ---------------------------------------------------------------------------
// Slugify
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'export'
}

// ---------------------------------------------------------------------------
// Export ZIP
// ---------------------------------------------------------------------------

export interface ZipEntry {
  filename: string
  data: unknown
}

/**
 * Create and download a ZIP with a main JSON file + optional child JSON files.
 */
export async function exportEntityZip(
  entries: ZipEntry[],
  zipName: string,
): Promise<void> {
  const zip = new JSZip()
  for (const entry of entries) {
    zip.file(entry.filename, JSON.stringify(entry.data, null, 2))
  }
  const blob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(blob, zipName)
}

// ---------------------------------------------------------------------------
// Import ZIP
// ---------------------------------------------------------------------------

/**
 * If all entries in a JSZip share a single root folder prefix, strip it so
 * that paths like `my-folder/workspace.json` become `workspace.json`.
 * This handles ZIPs created by macOS Finder, GitHub "Download ZIP", etc.
 * Also filters out __MACOSX resource fork entries.
 */
function stripRootFolder(zip: JSZip): JSZip {
  // Filter out macOS resource forks
  const paths = Object.keys(zip.files).filter(p => !p.startsWith('__MACOSX/') && !p.startsWith('._'))
  if (paths.length === 0) return zip

  // Check if all paths share a common root folder
  const firstSlash = paths[0].indexOf('/')
  if (firstSlash < 0) return zip
  const prefix = paths[0].slice(0, firstSlash + 1)
  if (!paths.every(p => p.startsWith(prefix))) return zip
  // Ensure we're not stripping a meaningful folder (there must be a directory entry or multiple levels)
  if (!zip.files[prefix]?.dir && paths.length === 1) return zip

  // Rebuild the zip with stripped paths
  const stripped = new JSZip()
  for (const [path, entry] of Object.entries(zip.files)) {
    if (path.startsWith('__MACOSX/') || path.startsWith('._')) continue
    if (!path.startsWith(prefix)) continue
    const newPath = path.slice(prefix.length)
    if (!newPath) continue
    if (entry.dir) {
      stripped.folder(newPath)
    } else {
      stripped.file(newPath, entry.async('arraybuffer'))
    }
  }
  return stripped
}

/**
 * Parse a ZIP file and return all JSON files as parsed objects.
 */
export async function parseImportZip(
  file: File,
): Promise<Record<string, unknown>> {
  let zip = await JSZip.loadAsync(file)
  zip = stripRootFolder(zip)
  const result: Record<string, unknown> = {}
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const content = await entry.async('string')
    try {
      result[path] = JSON.parse(content)
    } catch {
      result[path] = content
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Project ZIP — structured folder layout (unified: IDE = Export = Git)
// ---------------------------------------------------------------------------
//
// ZIP layout:
//   project.json                      — project metadata (without readme/todos/notes)
//   README.md                         — readme content
//   tasks.json                        — { todos, notes }
//   .gitignore                        — dynamic (datasets/**/*.csv excluded unless includeDataFiles)
//   scripts/_tree.json                — IDE file tree metadata (for round-trip import)
//   scripts/{path}                    — IDE files under scripts/ folder
//   pipeline/pipeline.json            — array of pipelines
//   cohorts/{slug}.json               — one file per cohort
//   databases/{slug}.json             — one file per IDE connection
//   dashboards/{slug}.json            — dashboard + its tabs + widgets
//   datasets/_tree.json               — dataset file tree metadata
//   datasets/{dataset}/
//     _columns.json                   — column metadata from DatasetFile
//     {analysis-slug}.json            — one file per analysis
//     {name}.csv                      — dataset data as CSV (optional, gitignored by default)
//   attachments/{filename}            — readme attachment binaries
//   attachments/_meta.json            — attachment metadata (ids, mime, size)
// ---------------------------------------------------------------------------

export interface BuildProjectZipOptions {
  includeDataFiles?: boolean // default false
}

function resolveProjectName(project: Project): string {
  return typeof project.name === 'string'
    ? project.name
    : (project.name.en || Object.values(project.name)[0] || 'project')
}

/** Build the full path for an IdeFile, preserving its folder hierarchy under scripts/. */
function buildIdePath(file: IdeFile, byId: Map<string, IdeFile>): string {
  const parts: string[] = [file.name]
  let current = file
  while (current.parentId) {
    const parent = byId.get(current.parentId)
    if (!parent) break
    parts.unshift(parent.name)
    current = parent
  }
  // The path already includes "scripts/" if the file is inside a scripts folder,
  // otherwise prefix it for backward compat with files at root level.
  if (parts[0] !== 'scripts') {
    parts.unshift('scripts')
  }
  return parts.join('/')
}

/** Build the full path for a DatasetFile within the tree. */
function buildDatasetPath(file: DatasetFile, byId: Map<string, DatasetFile>): string {
  const parts: string[] = [file.name]
  let current = file
  while (current.parentId) {
    const parent = byId.get(current.parentId)
    if (!parent) break
    parts.unshift(parent.name)
    current = parent
  }
  return parts.join('/')
}

const json = (data: unknown) => JSON.stringify(data, null, 2)

/**
 * Build a ZIP blob containing all project data in a git-friendly folder layout.
 */
export async function buildProjectZip(
  projectUid: string,
  storage: Storage,
  options: BuildProjectZipOptions = {},
): Promise<{ blob: Blob; projectName: string } | null> {
  const { includeDataFiles = false } = options
  const project = await storage.projects.getById(projectUid)
  if (!project) return null

  const zip = new JSZip()

  // --- project.json (without readme/todos/notes — those go in separate files) ---
  const { readme: _r, todos: _t, notes: _n, readmeHistory: _rh, ...projectMeta } = project
  zip.file('project.json', json({ ...projectMeta, appVersion: APP_VERSION }))

  // --- README.md ---
  if (project.readme) {
    zip.file('README.md', project.readme)
  }

  // --- tasks.json ---
  if ((project.todos && project.todos.length > 0) || project.notes) {
    zip.file('tasks.json', json({ todos: project.todos ?? [], notes: project.notes ?? '' }))
  }

  // --- IDE files (under scripts/ in ZIP) ---
  const ideFiles = await storage.ideFiles.getByProject(projectUid)
  if (ideFiles.length > 0) {
    const byId = new Map(ideFiles.map(f => [f.id, f]))
    zip.file('scripts/_tree.json', json(ideFiles.map(({ content: _, ...meta }) => meta)))
    for (const f of ideFiles) {
      if (f.type === 'file' && f.content != null) {
        zip.file(buildIdePath(f, byId), f.content)
      }
    }
  }

  // --- pipeline/ ---
  const pipelines = await storage.pipelines.getByProject(projectUid)
  if (pipelines.length > 0) {
    zip.file('pipeline/pipeline.json', json(pipelines))
  }

  // --- cohorts/ ---
  const cohorts = await storage.cohorts.getByProject(projectUid)
  for (const c of cohorts) {
    zip.file(`cohorts/${slugify(c.name || c.id)}.json`, json(c))
  }

  // --- databases/ (IDE connections) ---
  const connections = await storage.connections.getByProject(projectUid)
  for (const c of connections) {
    zip.file(`databases/${slugify(c.name || c.id)}.json`, json(c))
  }

  // --- dashboards/ (each dashboard = dashboard + tabs + widgets in one file) ---
  const dashboards = await storage.dashboards.getByProject(projectUid)
  for (const d of dashboards) {
    const tabs = await storage.dashboardTabs.getByDashboard(d.id)
    const widgets: DashboardWidget[] = []
    for (const tab of tabs) {
      widgets.push(...(await storage.dashboardWidgets.getByTab(tab.id)))
    }
    zip.file(`dashboards/${slugify(d.name || d.id)}.json`, json({ dashboard: d, tabs, widgets }))
  }

  // --- datasets/ (tree + analyses + optional data CSV) ---
  const datasetFiles = await storage.datasetFiles.getByProject(projectUid)
  if (datasetFiles.length > 0) {
    const byId = new Map(datasetFiles.map(f => [f.id, f]))
    zip.file('datasets/_tree.json', json(datasetFiles))

    for (const df of datasetFiles) {
      if (df.type !== 'file') continue
      const dsPath = buildDatasetPath(df, byId)
      const folderName = dsPath.replace(/\.[^.]+$/, '')

      if (df.columns && df.columns.length > 0) {
        zip.file(`datasets/${folderName}/_columns.json`, json(df.columns))
      }

      const analyses = await storage.datasetAnalyses.getByDataset(df.id)
      for (const a of analyses) {
        zip.file(`datasets/${folderName}/${slugify(a.name || a.id)}.json`, json(a))
      }

      if (includeDataFiles) {
        const data = await storage.datasetData.get(df.id)
        if (data && data.rows.length > 0) {
          const colIds = df.columns?.map(c => c.id) ?? Object.keys(data.rows[0])
          const colNames = df.columns?.map(c => c.name) ?? colIds
          const csvRows = [
            colNames.join(','),
            ...data.rows.map(row =>
              colIds.map(id => {
                const v = row[id]
                if (v == null) return ''
                const s = String(v)
                return s.includes(',') || s.includes('"') || s.includes('\n')
                  ? `"${s.replace(/"/g, '""')}"`
                  : s
              }).join(',')
            ),
          ]
          zip.file(`datasets/${folderName}/${dsPath.split('/').pop()}`, csvRows.join('\n'))
        }
      }
    }
  }

  // --- attachments/ ---
  const attachments = await storage.readmeAttachments.getByProject(projectUid)
  if (attachments.length > 0) {
    const meta = attachments.map(({ data: _, ...rest }) => rest)
    zip.file('attachments/_meta.json', json(meta))
    for (const att of attachments) {
      zip.file(`attachments/${att.id}-${att.fileName}`, att.data)
    }
  }

  // --- .gitignore (dynamic based on includeDataFiles option) ---
  const gitignoreLines = ['.cache/']
  if (!includeDataFiles) {
    gitignoreLines.unshift('datasets/**/*.csv', 'datasets/**/*.parquet')
  }
  zip.file('.gitignore', gitignoreLines.join('\n') + '\n')

  const blob = await zip.generateAsync({ type: 'blob' })
  return { blob, projectName: resolveProjectName(project) }
}

// ---------------------------------------------------------------------------
// Parse project ZIP — supports both new structured layout and legacy flat layout
// ---------------------------------------------------------------------------

export interface ParsedProjectZip {
  project: Project
  ideFiles: IdeFile[]
  pipelines: Pipeline[]
  cohorts: Cohort[]
  connections: IdeConnection[]
  dashboards: Dashboard[]
  dashboardTabs: DashboardTab[]
  dashboardWidgets: DashboardWidget[]
  datasetFiles: DatasetFile[]
  datasetAnalyses: DatasetAnalysis[]
  /** CSV data parsed from _data/ folder, keyed by datasetFileId */
  datasetData: DatasetData[]
  attachmentsMeta: Omit<ReadmeAttachment, 'data'>[]
  /** Keyed by attachment id */
  attachmentBlobs: Map<string, ArrayBuffer>
}

export async function parseProjectZip(file: File): Promise<ParsedProjectZip | null> {
  const zipData = stripRootFolder(await JSZip.loadAsync(file))

  // Detect layout:
  // - legacy: flat JSON files (ide-files.json, cohorts.json, etc.)
  // - v2: underscore-prefixed folders (_ide_tree.json, _cohorts/, _dashboards/)
  // - v3 (current): unprefixed folders (scripts/_tree.json, cohorts/, dashboards/)
  const hasLegacyLayout = zipData.files['ide-files.json'] != null || zipData.files['cohorts.json'] != null
  const hasNewLayout = zipData.files['_ide_tree.json'] != null
    || zipData.files['scripts/_tree.json'] != null
    || Object.keys(zipData.files).some(p =>
      p.startsWith('_cohorts/') || p.startsWith('_dashboards/')
      || p.startsWith('cohorts/') || p.startsWith('dashboards/')
      || p.startsWith('scripts/'))

  if (!hasLegacyLayout && !hasNewLayout) {
    if (!zipData.files['project.json']) return null
  }

  // --- Read project.json ---
  const projectFile = zipData.files['project.json']
  if (!projectFile) return null
  const projectRaw = JSON.parse(await projectFile.async('string'))
  if (!projectRaw?.uid) return null
  // Strip export-only fields
  const { appVersion: _av, ...projectMeta } = projectRaw as Project & { appVersion?: string }

  // Reconstruct readme, todos, notes from separate files
  const readmeFile = zipData.files['README.md']
  if (readmeFile) {
    projectMeta.readme = await readmeFile.async('string')
  }
  const tasksFile = zipData.files['tasks.json']
  if (tasksFile) {
    const tasks = JSON.parse(await tasksFile.async('string'))
    projectMeta.todos = tasks.todos ?? []
    projectMeta.notes = tasks.notes ?? ''
  }

  if (hasNewLayout || !hasLegacyLayout) {
    return parseNewLayout(zipData, projectMeta)
  }
  return parseLegacyLayout(zipData, projectMeta)
}

async function readJsonFile<T>(zip: JSZip, path: string): Promise<T | null> {
  const entry = zip.files[path]
  if (!entry) return null
  return JSON.parse(await entry.async('string')) as T
}

/** Parse CSV text and remap column names → column IDs based on DatasetFile.columns. */
function parseCsvToDatasetData(csv: string, df: DatasetFile): DatasetData | null {
  const lines = csv.split('\n').filter(l => l.length > 0)
  if (lines.length < 2) return null

  const headers = parseCsvLine(lines[0])
  // Build name→id mapping from columns metadata
  const nameToId = new Map<string, string>()
  if (df.columns) {
    for (const col of df.columns) nameToId.set(col.name, col.id)
  }

  const rows: Record<string, unknown>[] = []
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i])
    if (values.every(v => v === '')) continue // skip empty rows
    const row: Record<string, unknown> = {}
    for (let j = 0; j < headers.length; j++) {
      const key = nameToId.get(headers[j]) ?? headers[j]
      const v = values[j] ?? ''
      // Try to parse numbers
      if (v === '') {
        row[key] = null
      } else {
        const n = Number(v)
        row[key] = Number.isNaN(n) ? v : n
      }
    }
    rows.push(row)
  }

  if (rows.length === 0) return null
  return { datasetFileId: df.id, rows }
}

/** Simple CSV line parser that handles quoted fields. */
function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

async function parseLegacyLayout(zip: JSZip, project: Project): Promise<ParsedProjectZip> {
  const ideFiles = (await readJsonFile<IdeFile[]>(zip, 'ide-files.json')) ?? []
  const pipelines = (await readJsonFile<Pipeline[]>(zip, 'pipelines.json')) ?? []
  const cohorts = (await readJsonFile<Cohort[]>(zip, 'cohorts.json')) ?? []
  const connections = (await readJsonFile<IdeConnection[]>(zip, 'connections.json')) ?? []
  const dashboards = (await readJsonFile<Dashboard[]>(zip, 'dashboards.json')) ?? []
  const dashboardTabs = (await readJsonFile<DashboardTab[]>(zip, 'dashboard-tabs.json')) ?? []
  const dashboardWidgets = (await readJsonFile<DashboardWidget[]>(zip, 'dashboard-widgets.json')) ?? []
  const datasetFiles = (await readJsonFile<DatasetFile[]>(zip, 'dataset-files.json')) ?? []
  const datasetAnalyses = (await readJsonFile<DatasetAnalysis[]>(zip, 'dataset-analyses.json')) ?? []
  const attachmentsMeta = (await readJsonFile<Omit<ReadmeAttachment, 'data'>[]>(zip, 'readme-attachments.json')) ?? []

  const attachmentBlobs = new Map<string, ArrayBuffer>()
  for (const meta of attachmentsMeta) {
    const entry = zip.files[`attachments/${meta.id}-${meta.fileName}`]
      ?? zip.files[`_attachments/${meta.id}-${meta.fileName}`]
    if (entry) attachmentBlobs.set(meta.id, await entry.async('arraybuffer'))
  }

  return {
    project, ideFiles, pipelines, cohorts, connections,
    dashboards, dashboardTabs, dashboardWidgets,
    datasetFiles, datasetAnalyses, datasetData: [], attachmentsMeta, attachmentBlobs,
  }
}

/** Read a JSON file from the first matching path. */
async function readJsonFileFromEither<T>(zip: JSZip, ...paths: string[]): Promise<T | null> {
  for (const p of paths) {
    const result = await readJsonFile<T>(zip, p)
    if (result != null) return result
  }
  return null
}

/** Scan a folder (and its legacy `_`-prefixed variant) for JSON files. */
function scanFolder(zip: JSZip, folder: string, legacyFolder: string): [string, JSZip.JSZipObject][] {
  const results: [string, JSZip.JSZipObject][] = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    if (path.startsWith(folder) || path.startsWith(legacyFolder)) {
      results.push([path, entry])
    }
  }
  return results
}

async function parseNewLayout(zip: JSZip, project: Project): Promise<ParsedProjectZip> {
  // --- IDE files (v3: scripts/_tree.json, v2: _ide_tree.json) ---
  const ideFiles = (await readJsonFileFromEither<IdeFile[]>(zip, 'scripts/_tree.json', '_ide_tree.json')) ?? []
  if (ideFiles.length > 0) {
    const byId = new Map(ideFiles.map(f => [f.id, f]))
    for (const f of ideFiles) {
      if (f.type !== 'file') continue
      const relPath = buildIdePath(f, byId)
      // v3: files are under scripts/, v2: files are at root (relPath without scripts/ prefix)
      // buildIdePath now always prepends scripts/, so for v2 we try without the prefix too
      const entry = zip.files[relPath]
        ?? zip.files[relPath.replace(/^scripts\//, '')]
      if (entry) {
        f.content = await entry.async('string')
      }
    }
  }

  // --- Pipelines (v3: pipeline/, v2: _pipeline/) ---
  const pipelines = (await readJsonFileFromEither<Pipeline[]>(zip, 'pipeline/pipeline.json', '_pipeline/pipeline.json')) ?? []

  // --- Cohorts (v3: cohorts/, v2: _cohorts/) ---
  const cohorts: Cohort[] = []
  for (const [path, entry] of scanFolder(zip, 'cohorts/', '_cohorts/')) {
    if (path.endsWith('.json')) {
      cohorts.push(JSON.parse(await entry.async('string')))
    }
  }

  // --- Connections (v3: databases/, v2: _databases/) ---
  const connections: IdeConnection[] = []
  for (const [path, entry] of scanFolder(zip, 'databases/', '_databases/')) {
    if (path.endsWith('.json')) {
      connections.push(JSON.parse(await entry.async('string')))
    }
  }

  // --- Dashboards (v3: dashboards/, v2: _dashboards/) ---
  const dashboards: Dashboard[] = []
  const dashboardTabs: DashboardTab[] = []
  const dashboardWidgets: DashboardWidget[] = []
  for (const [path, entry] of scanFolder(zip, 'dashboards/', '_dashboards/')) {
    if (path.endsWith('.json')) {
      const bundle = JSON.parse(await entry.async('string')) as {
        dashboard: Dashboard; tabs: DashboardTab[]; widgets: DashboardWidget[]
      }
      dashboards.push(bundle.dashboard)
      dashboardTabs.push(...(bundle.tabs ?? []))
      dashboardWidgets.push(...(bundle.widgets ?? []))
    }
  }

  // --- Dataset files + analyses (v3: datasets/, v2: _datasets/) ---
  const datasetFiles = (await readJsonFileFromEither<DatasetFile[]>(zip, 'datasets/_tree.json', '_datasets/_tree.json')) ?? []
  const datasetAnalyses: DatasetAnalysis[] = []
  for (const [path, entry] of scanFolder(zip, 'datasets/', '_datasets/')) {
    if (path.endsWith('/_tree.json') || path.endsWith('/_columns.json')) continue
    if (path.endsWith('.json')) {
      datasetAnalyses.push(JSON.parse(await entry.async('string')))
    }
  }

  // --- Dataset data (v3: CSV inside datasets/{folder}/, v2: CSV in _data/) ---
  const datasetData: DatasetData[] = []
  if (datasetFiles.length > 0) {
    const byId = new Map(datasetFiles.map(f => [f.id, f]))
    for (const df of datasetFiles) {
      if (df.type !== 'file') continue
      const dsPath = buildDatasetPath(df, byId)
      const folderName = dsPath.replace(/\.[^.]+$/, '')
      const fileName = dsPath.split('/').pop() ?? dsPath
      // v3: datasets/{folder}/{name}.csv, v2: _data/{path}
      const csvEntry = zip.files[`datasets/${folderName}/${fileName}`]
        ?? zip.files[`_data/${dsPath}`]
      if (csvEntry) {
        const csv = await csvEntry.async('string')
        const parsed = parseCsvToDatasetData(csv, df)
        if (parsed) datasetData.push(parsed)
      }
    }
  }

  // --- Attachments (v3: attachments/, v2: _attachments/) ---
  const attachmentsMeta = (await readJsonFileFromEither<Omit<ReadmeAttachment, 'data'>[]>(zip, 'attachments/_meta.json', '_attachments/_meta.json')) ?? []
  const attachmentBlobs = new Map<string, ArrayBuffer>()
  for (const meta of attachmentsMeta) {
    const entry = zip.files[`attachments/${meta.id}-${meta.fileName}`]
      ?? zip.files[`_attachments/${meta.id}-${meta.fileName}`]
    if (entry) attachmentBlobs.set(meta.id, await entry.async('arraybuffer'))
  }

  return {
    project, ideFiles, pipelines, cohorts, connections,
    dashboards, dashboardTabs, dashboardWidgets,
    datasetFiles, datasetAnalyses, datasetData, attachmentsMeta, attachmentBlobs,
  }
}

// ---------------------------------------------------------------------------
// Workspace ZIP — full workspace export/import
// ---------------------------------------------------------------------------
//
// ZIP layout:
//   workspace.json                            — workspace metadata
//   README.md                                 — workspace readme (markdown)
//   projects/{slug}/...                       — one folder per project (same layout as project ZIP)
//   wiki/_tree.json                           — wiki page metadata (hierarchy, icons, etc.)
//   wiki/{slug}--{id}.md                      — wiki page content as markdown
//   wiki/_attachments/_meta.json              — wiki attachment metadata
//   wiki/_attachments/{id}-{filename}         — wiki attachment binaries
//   sql-scripts/{collection-slug}/
//     _collection.json                        — collection metadata
//     _tree.json                              — file tree metadata (folders, order)
//     {path/to/script.sql}                    — script files at their folder path
//   etl/{slug}/
//     _pipeline.json                          — ETL pipeline metadata
//     _tree.json                              — file tree metadata
//     {path/to/script.sql}                    — ETL files at their folder path
//   data-quality/{slug}.json                   — { ruleSet, checks }
//   concept-sets/{slug}.json                  — concept set
//   mapping-projects/{slug}/
//     _project.json                           — mapping project metadata
//     mappings.json                           — concept mappings
//   catalogs/{slug}.json                      — data catalog config
//   service-mappings/{slug}.json              — service mapping
//   plugins/{slug}/
//     _plugin.json                            — plugin metadata
//     {filename}                              — plugin source files
// ---------------------------------------------------------------------------

export interface BuildWorkspaceZipOptions {
  includeDataFiles?: boolean
  /** Per-section toggles (all true by default for backwards compat) */
  sections?: {
    projects?: boolean
    wiki?: boolean
    plugins?: boolean
    schemas?: boolean
    databases?: boolean
    conceptMapping?: boolean
    sqlScripts?: boolean
    etl?: boolean
    dataQuality?: boolean
    catalogs?: boolean
  }
  /** Include connection credentials (host, port, database, schema, username) in database export. Passwords are never included. */
  includeCredentials?: boolean
}

function resolveWorkspaceName(ws: Workspace): string {
  return typeof ws.name === 'string'
    ? ws.name
    : (ws.name.en || Object.values(ws.name)[0] || 'workspace')
}

/** Build the full path for a tree node (SqlScriptFile, EtlFile) preserving folder hierarchy. */
function buildTreePath(file: { id: string; name: string; parentId: string | null }, byId: Map<string, { id: string; name: string; parentId: string | null }>): string {
  const parts: string[] = [file.name]
  let current = file
  while (current.parentId) {
    const parent = byId.get(current.parentId)
    if (!parent) break
    parts.unshift(parent.name)
    current = parent
  }
  return parts.join('/')
}

/**
 * Strip sensitive fields from a DatabaseConnectionConfig.
 * - Always removes: password, tokens, local file refs (fileId, fileIds, fileNames, fileHandleIds).
 * - When `keepCredentials` is false, also removes: host, port, database, schema, username.
 *   Only `engine` is kept so the data source entry remains useful as a reference.
 */
function sanitizeConnectionConfig(config: Record<string, unknown>, keepCredentials: boolean): Record<string, unknown> {
  // Always strip password, tokens and local file references
  const { password: _, token: _tk, fileId: _f, fileIds: _fi, fileNames: _fn, fileHandleIds: _fh, ...rest } = config
  if (keepCredentials) return rest
  // Strip connection details too — keep only engine
  const { host: _h, port: _p, database: _d, schema: _s, username: _u, baseUrl: _bu, authType: _at, ...minimal } = rest
  return minimal
}

/**
 * Build a ZIP blob containing all workspace data.
 * Sections can be toggled individually via `options.sections`.
 * Reuses `buildProjectZip` for each project to avoid code duplication.
 */
export async function buildWorkspaceZip(
  workspaceId: string,
  storage: Storage,
  options: BuildWorkspaceZipOptions = {},
): Promise<{ blob: Blob; workspaceName: string } | null> {
  const workspace = await storage.workspaces.getById(workspaceId)
  if (!workspace) return null

  // Section toggles (default: all enabled for backwards compat)
  const sec = options.sections ?? {}
  const on = (key: string) => (sec as Record<string, boolean | undefined>)[key] !== false

  const zip = new JSZip()

  // --- workspace.json ---
  const { readme: wsReadme, ...wsMeta } = workspace
  zip.file('workspace.json', json({ ...wsMeta, appVersion: APP_VERSION }))

  // --- README.md ---
  if (wsReadme) {
    zip.file('README.md', wsReadme)
  }

  // --- projects/ (lightweight: metadata + README only, no full content) ---
  if (on('projects')) {
    const allProjects = await storage.projects.getAll()
    const wsProjects = allProjects.filter(p => p.workspaceId === workspaceId)
    for (const project of wsProjects) {
      const folder = project.projectId || slugify(resolveProjectName(project))
      // Export only catalog-relevant metadata (not full project content)
      const { todos: _t, notes: _n, readmeHistory: _rh, ...projectMeta } = project
      zip.file(`projects/${folder}/project.json`, json({ ...projectMeta, appVersion: APP_VERSION }))
      if (project.readme) {
        zip.file(`projects/${folder}/README.md`, project.readme)
      }
    }
  }

  // Helper: prefer entityId, fallback to slugified name or id
  const eid = (entity: { entityId?: string; name?: string; id: string }) =>
    entity.entityId || slugify(String(entity.name || entity.id || 'unknown'))

  // --- wiki/ ---
  if (on('wiki')) {
    const wikiPages = await storage.wikiPages.getByWorkspace(workspaceId)
    if (wikiPages.length > 0) {
      const treeMeta = wikiPages.map(({ content: _, history: _h, ...meta }) => meta)
      zip.file('wiki/_tree.json', json(treeMeta))

      for (const page of wikiPages) {
        const pageFolder = page.entityId || `${slugify(page.title || page.id)}--${page.id}`
        zip.file(`wiki/${pageFolder}.md`, page.content || '')
      }

      const wikiAttachments = await storage.wikiAttachments.getByWorkspace(workspaceId)
      if (wikiAttachments.length > 0) {
        const meta = wikiAttachments.map(({ data: _, ...rest }) => rest)
        zip.file('wiki/_attachments/_meta.json', json(meta))
        for (const att of wikiAttachments) {
          zip.file(`wiki/_attachments/${att.id}-${att.fileName}`, att.data)
        }
      }
    }
  }

  // --- schemas/ ---
  if (on('schemas')) {
    const schemas = await storage.schemaPresets.getByWorkspace(workspaceId)
    for (const sp of schemas) {
      zip.file(`schemas/${slugify(sp.presetId)}.json`, json(sp))
    }
  }

  // --- databases/ (always exported when section enabled; credentials opt-in, passwords never) ---
  if (on('databases')) {
    const keepCreds = options.includeCredentials === true
    const dataSources = await storage.dataSources.getByWorkspace(workspaceId)
    for (const ds of dataSources) {
      const { connectionConfig, ...rest } = ds as Record<string, unknown>
      const safeDsJson = {
        ...rest,
        connectionConfig: connectionConfig
          ? sanitizeConnectionConfig(connectionConfig as Record<string, unknown>, keepCreds)
          : undefined,
      }
      zip.file(`databases/${slugify((ds as { name?: string }).name || (ds as { id: string }).id)}.json`, json(safeDsJson))
    }
  }

  // --- sql-scripts/ ---
  if (on('sqlScripts')) {
    const sqlCollections = await storage.sqlScriptCollections.getByWorkspace(workspaceId)
    for (const collection of sqlCollections) {
      const folder = eid(collection)
      const files = await storage.sqlScriptFiles.getByCollection(collection.id)
      const byId = new Map(files.map(f => [f.id, f]))

      zip.file(`sql-scripts/${folder}/_collection.json`, json(collection))
      zip.file(`sql-scripts/${folder}/_tree.json`, json(files.map(({ content: _, ...meta }) => meta)))

      for (const f of files) {
        if (f.type === 'file' && f.content != null) {
          zip.file(`sql-scripts/${folder}/${buildTreePath(f, byId)}`, f.content)
        }
      }
    }
  }

  // --- etl/ ---
  if (on('etl')) {
    const etlPipelines = await storage.etlPipelines.getByWorkspace(workspaceId)
    for (const pipeline of etlPipelines) {
      const folder = eid(pipeline)
      const files = await storage.etlFiles.getByPipeline(pipeline.id)
      const byId = new Map(files.map(f => [f.id, f]))

      zip.file(`etl/${folder}/_pipeline.json`, json(pipeline))
      zip.file(`etl/${folder}/_tree.json`, json(files.map(({ content: _, ...meta }) => meta)))

      for (const f of files) {
        if (f.type === 'file' && f.content != null) {
          zip.file(`etl/${folder}/${buildTreePath(f, byId)}`, f.content)
        }
      }
    }
  }

  // --- data-quality/ ---
  if (on('dataQuality')) {
    const dqRuleSets = await storage.dqRuleSets.getByWorkspace(workspaceId)
    for (const rs of dqRuleSets) {
      const checks = await storage.dqCustomChecks.getByRuleSet(rs.id)
      zip.file(`data-quality/${eid(rs)}.json`, json({ ruleSet: rs, checks }))
    }
  }

  // --- mapping-projects/ (reuses buildMappingProjectFolder for full export) ---
  if (on('conceptMapping')) {
    const mappingProjects = await storage.mappingProjects.getByWorkspace(workspaceId)
    for (const mp of mappingProjects) {
      const folder = eid(mp)
      await buildMappingProjectFolder(zip, `mapping-projects/${folder}/`, mp, storage)
    }
  }

  // --- catalogs/ + service-mappings/ ---
  if (on('catalogs')) {
    const catalogs = await storage.dataCatalogs.getByWorkspace(workspaceId)
    for (const cat of catalogs) {
      zip.file(`catalogs/${eid(cat)}.json`, json(cat))
    }

    const serviceMappings = await storage.serviceMappings.getByWorkspace(workspaceId)
    for (const sm of serviceMappings) {
      zip.file(`service-mappings/${slugify(sm.name || sm.id)}.json`, json(sm))
    }
  }

  // --- plugins/ ---
  if (on('plugins')) {
    const plugins = await storage.userPlugins.getByWorkspace(workspaceId)
    for (const plugin of plugins) {
      const folder = plugin.entityId || slugify(plugin.id)
      zip.file(`plugins/${folder}/_plugin.json`, json({ id: plugin.id, entityId: plugin.entityId, workspaceId: plugin.workspaceId, createdAt: plugin.createdAt, updatedAt: plugin.updatedAt }))
      for (const [filename, content] of Object.entries(plugin.files)) {
        zip.file(`plugins/${folder}/${filename}`, content)
      }
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  return { blob, workspaceName: resolveWorkspaceName(workspace) }
}

// ---------------------------------------------------------------------------
// Parse workspace ZIP
// ---------------------------------------------------------------------------

/** Lightweight project entry (catalog-only: metadata + README). */
export interface ParsedProjectEntry {
  project: Project & { appVersion?: string }
  readme?: string
}

export interface ParsedWorkspaceZip {
  workspace: Workspace & { appVersion?: string }
  /** Full project data (legacy format: complete project ZIP inside workspace ZIP). */
  projects: Map<string, ParsedProjectZip>
  /** Lightweight project entries (new format: metadata + README only). */
  projectEntries: ParsedProjectEntry[]
  schemas: CustomSchemaPreset[]
  databases: Partial<DataSource>[]
  wikiPages: WikiPage[]
  wikiAttachmentsMeta: Omit<WikiAttachment, 'data'>[]
  wikiAttachmentBlobs: Map<string, ArrayBuffer>
  sqlCollections: { collection: SqlScriptCollection; files: SqlScriptFile[] }[]
  etlPipelines: { pipeline: EtlPipeline; files: EtlFile[] }[]
  dqRuleSets: { ruleSet: DqRuleSet; checks: DqCustomCheck[] }[]
  conceptSets: ConceptSet[]
  mappingProjects: { project: MappingProject; mappings: ConceptMapping[] }[]
  catalogs: DataCatalog[]
  serviceMappings: ServiceMapping[]
  plugins: UserPlugin[]
}

export async function parseWorkspaceZip(file: File): Promise<ParsedWorkspaceZip | null> {
  const zipData = stripRootFolder(await JSZip.loadAsync(file))

  // --- workspace.json ---
  const wsFile = zipData.files['workspace.json']
  if (!wsFile) return null
  const workspace = JSON.parse(await wsFile.async('string')) as Workspace & { appVersion?: string }
  if (!workspace?.id) return null

  // --- README.md ---
  const readmeFile = zipData.files['README.md']
  if (readmeFile) {
    workspace.readme = await readmeFile.async('string')
  }

  // --- projects/ ---
  // Detect format: lightweight (only project.json + README.md) vs full (has _pipeline/, _cohorts/, etc.)
  const projects = new Map<string, ParsedProjectZip>()
  const projectEntries: ParsedProjectEntry[] = []
  const projectFolders = new Set<string>()
  for (const path of Object.keys(zipData.files)) {
    if (!path.startsWith('projects/')) continue
    const parts = path.split('/')
    if (parts.length >= 2 && parts[1]) projectFolders.add(parts[1])
  }
  for (const folder of projectFolders) {
    const prefix = `projects/${folder}/`
    // Check if this is a lightweight entry (no _pipeline, _cohorts, _dashboards, etc.)
    const hasFullContent = Object.keys(zipData.files).some(p =>
      p.startsWith(prefix) && (p.includes('/_pipeline/') || p.includes('/_cohorts/') || p.includes('/_dashboards/') || p.includes('/_datasets/') || p.includes('/_ide_tree.json'))
    )

    if (hasFullContent) {
      // Legacy full project ZIP
      const projectZip = new JSZip()
      for (const [path, entry] of Object.entries(zipData.files)) {
        if (!path.startsWith(prefix) || entry.dir) continue
        projectZip.file(path.slice(prefix.length), await entry.async('arraybuffer'))
      }
      const blob = await projectZip.generateAsync({ type: 'blob' })
      const parsed = await parseProjectZip(new File([blob], `${folder}.zip`))
      if (parsed) projects.set(folder, parsed)
    } else {
      // Lightweight entry (catalog-only)
      const projectJson = await readJsonFile<Project & { appVersion?: string }>(zipData, `${prefix}project.json`)
      if (!projectJson) continue
      const readmeEntry = zipData.files[`${prefix}README.md`]
      const readme = readmeEntry ? await readmeEntry.async('string') : undefined
      projectEntries.push({ project: projectJson, readme })
    }
  }

  // --- schemas/ ---
  const schemas: CustomSchemaPreset[] = []
  for (const [path, entry] of Object.entries(zipData.files)) {
    if (!path.startsWith('schemas/') || !path.endsWith('.json') || entry.dir) continue
    schemas.push(JSON.parse(await entry.async('string')))
  }

  // --- databases/ (sanitized connection metadata) ---
  const databases: Partial<DataSource>[] = []
  for (const [path, entry] of Object.entries(zipData.files)) {
    if (!path.startsWith('databases/') || !path.endsWith('.json') || entry.dir) continue
    databases.push(JSON.parse(await entry.async('string')))
  }

  // --- wiki/ ---
  const wikiPages: WikiPage[] = []
  const wikiTreeMeta = await readJsonFile<Omit<WikiPage, 'content' | 'history'>[]>(zipData, 'wiki/_tree.json')
  if (wikiTreeMeta) {
    for (const meta of wikiTreeMeta) {
      let content = ''
      for (const [path, entry] of Object.entries(zipData.files)) {
        if (path.startsWith('wiki/') && path.endsWith(`--${meta.id}.md`) && !entry.dir) {
          content = await entry.async('string')
          break
        }
      }
      wikiPages.push({ ...meta, content, history: [] } as WikiPage)
    }
  }

  const wikiAttachmentsMeta = (await readJsonFile<Omit<WikiAttachment, 'data'>[]>(zipData, 'wiki/_attachments/_meta.json')) ?? []
  const wikiAttachmentBlobs = new Map<string, ArrayBuffer>()
  for (const meta of wikiAttachmentsMeta) {
    const entry = zipData.files[`wiki/_attachments/${meta.id}-${meta.fileName}`]
    if (entry) wikiAttachmentBlobs.set(meta.id, await entry.async('arraybuffer'))
  }

  // --- sql-scripts/ ---
  const sqlCollections: ParsedWorkspaceZip['sqlCollections'] = []
  const sqlFolders = new Set<string>()
  for (const path of Object.keys(zipData.files)) {
    if (!path.startsWith('sql-scripts/')) continue
    const parts = path.split('/')
    if (parts.length >= 2 && parts[1]) sqlFolders.add(parts[1])
  }
  for (const folder of sqlFolders) {
    const prefix = `sql-scripts/${folder}/`
    const collection = await readJsonFile<SqlScriptCollection>(zipData, `${prefix}_collection.json`)
    if (!collection) continue
    const treeMeta = (await readJsonFile<SqlScriptFile[]>(zipData, `${prefix}_tree.json`)) ?? []
    if (treeMeta.length > 0) {
      const byId = new Map(treeMeta.map(f => [f.id, f]))
      for (const f of treeMeta) {
        if (f.type !== 'file') continue
        const filePath = `${prefix}${buildTreePath(f, byId)}`
        const entry = zipData.files[filePath]
        if (entry) {
          ;(f as SqlScriptFile).content = await entry.async('string')
        }
      }
    }
    sqlCollections.push({ collection, files: treeMeta as SqlScriptFile[] })
  }

  // --- etl/ ---
  const etlPipelines: ParsedWorkspaceZip['etlPipelines'] = []
  const etlFolders = new Set<string>()
  for (const path of Object.keys(zipData.files)) {
    if (!path.startsWith('etl/')) continue
    const parts = path.split('/')
    if (parts.length >= 2 && parts[1]) etlFolders.add(parts[1])
  }
  for (const folder of etlFolders) {
    const prefix = `etl/${folder}/`
    const pipeline = await readJsonFile<EtlPipeline>(zipData, `${prefix}_pipeline.json`)
    if (!pipeline) continue
    const treeMeta = (await readJsonFile<EtlFile[]>(zipData, `${prefix}_tree.json`)) ?? []
    if (treeMeta.length > 0) {
      const byId = new Map(treeMeta.map(f => [f.id, f]))
      for (const f of treeMeta) {
        if (f.type !== 'file') continue
        const filePath = `${prefix}${buildTreePath(f, byId)}`
        const entry = zipData.files[filePath]
        if (entry) {
          ;(f as EtlFile).content = await entry.async('string')
        }
      }
    }
    etlPipelines.push({ pipeline, files: treeMeta as EtlFile[] })
  }

  // --- data-quality/ (also supports legacy 'dq/' prefix) ---
  const dqRuleSets: ParsedWorkspaceZip['dqRuleSets'] = []
  for (const [path, entry] of Object.entries(zipData.files)) {
    if ((!path.startsWith('data-quality/') && !path.startsWith('dq/')) || !path.endsWith('.json') || entry.dir) continue
    const bundle = JSON.parse(await entry.async('string')) as { ruleSet: DqRuleSet; checks: DqCustomCheck[] }
    if (bundle.ruleSet) dqRuleSets.push(bundle)
  }

  // --- concept-sets/ ---
  const conceptSets: ConceptSet[] = []
  for (const [path, entry] of Object.entries(zipData.files)) {
    if (!path.startsWith('concept-sets/') || !path.endsWith('.json') || entry.dir) continue
    conceptSets.push(JSON.parse(await entry.async('string')))
  }

  // --- mapping-projects/ ---
  const mappingProjects: ParsedWorkspaceZip['mappingProjects'] = []
  const mpFolders = new Set<string>()
  for (const path of Object.keys(zipData.files)) {
    if (!path.startsWith('mapping-projects/')) continue
    const parts = path.split('/')
    if (parts.length >= 2 && parts[1]) mpFolders.add(parts[1])
  }
  for (const folder of mpFolders) {
    const prefix = `mapping-projects/${folder}/`
    const project = (await readJsonFile<MappingProject>(zipData, `${prefix}project.json`))
      ?? (await readJsonFile<MappingProject>(zipData, `${prefix}_project.json`))
    if (!project) continue
    const mappings = (await readJsonFile<ConceptMapping[]>(zipData, `${prefix}mappings.json`)) ?? []
    mappingProjects.push({ project, mappings })
  }

  // --- catalogs/ ---
  const catalogs: DataCatalog[] = []
  for (const [path, entry] of Object.entries(zipData.files)) {
    if (!path.startsWith('catalogs/') || !path.endsWith('.json') || entry.dir) continue
    catalogs.push(JSON.parse(await entry.async('string')))
  }

  // --- service-mappings/ ---
  const serviceMappings: ServiceMapping[] = []
  for (const [path, entry] of Object.entries(zipData.files)) {
    if (!path.startsWith('service-mappings/') || !path.endsWith('.json') || entry.dir) continue
    serviceMappings.push(JSON.parse(await entry.async('string')))
  }

  // --- plugins/ ---
  const plugins: UserPlugin[] = []
  const pluginFolders = new Set<string>()
  for (const path of Object.keys(zipData.files)) {
    if (!path.startsWith('plugins/')) continue
    const parts = path.split('/')
    if (parts.length >= 2 && parts[1]) pluginFolders.add(parts[1])
  }
  for (const folder of pluginFolders) {
    const prefix = `plugins/${folder}/`
    const pluginMeta = await readJsonFile<{ id: string; workspaceId?: string; createdAt: string; updatedAt: string }>(zipData, `${prefix}_plugin.json`)
    if (!pluginMeta) continue
    const files: Record<string, string> = {}
    for (const [path, entry] of Object.entries(zipData.files)) {
      if (!path.startsWith(prefix) || entry.dir) continue
      const relativePath = path.slice(prefix.length)
      if (relativePath === '_plugin.json') continue
      files[relativePath] = await entry.async('string')
    }
    plugins.push({ ...pluginMeta, files } as UserPlugin)
  }

  return {
    workspace, projects, projectEntries, schemas, databases,
    wikiPages, wikiAttachmentsMeta, wikiAttachmentBlobs,
    sqlCollections, etlPipelines, dqRuleSets, conceptSets,
    mappingProjects, catalogs, serviceMappings, plugins,
  }
}
