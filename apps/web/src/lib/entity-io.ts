/**
 * Shared utilities for entity export/import (ZIP and JSON).
 */
import JSZip from 'jszip'
import type { Storage } from '@/lib/storage'
import { APP_VERSION } from '@/lib/version'
import type {
  Project, IdeFile, Pipeline, Cohort, IdeConnection,
  Dashboard, DashboardTab, DashboardWidget,
  DatasetFile, DatasetData, DatasetRawFile, DatasetAnalysis, ReadmeAttachment,
  Workspace, WikiPage, WikiAttachment,
  SqlScriptCollection, SqlScriptFile,
  EtlPipeline, EtlFile,
  DqRuleSet, DqCustomCheck,
  ConceptSet, MappingProject, ConceptMapping,
  SourceConceptIdRange, SourceConceptIdEntry,
  DataCatalog, ServiceMapping, UserPlugin,
  DataSource, CustomSchemaPreset,
  GitRemoteConfig,
} from '@/types'
import { buildMappingProjectFolder, restoreFileSourceDataFromCsv } from '@/lib/concept-mapping/export'

// ---------------------------------------------------------------------------
// Source-concept-id compact format helpers
// ---------------------------------------------------------------------------

/** Compact JSON format for source-concept-id entries (smaller than one object per entry). */
export interface CompactSourceConceptIdEntries {
  /** Column order: [badgeLabel, vocabularyId, conceptCode, sourceConceptId, createdAt] */
  columns: ['badgeLabel', 'vocabularyId', 'conceptCode', 'sourceConceptId', 'createdAt']
  entries: [string, string, string, number, string][]
}

/** Serialize SourceConceptIdEntry[] to compact format for export. */
function toCompactEntries(entries: SourceConceptIdEntry[]): CompactSourceConceptIdEntries {
  return {
    columns: ['badgeLabel', 'vocabularyId', 'conceptCode', 'sourceConceptId', 'createdAt'],
    entries: entries.map(e => [e.badgeLabel, e.vocabularyId, e.conceptCode, e.sourceConceptId, e.createdAt]),
  }
}

/** Deserialize compact or legacy entries.json into SourceConceptIdEntry[]. */
export function parseSourceConceptIdEntries(
  raw: CompactSourceConceptIdEntries | SourceConceptIdEntry[],
  workspaceId: string,
): SourceConceptIdEntry[] {
  // Legacy format: array of full objects
  if (Array.isArray(raw)) return raw

  // Compact format: { columns, entries }
  return raw.entries.map(([badgeLabel, vocabularyId, conceptCode, sourceConceptId, createdAt]) => ({
    id: `${workspaceId}__${badgeLabel}__${vocabularyId}__${conceptCode}`,
    workspaceId,
    badgeLabel,
    vocabularyId,
    conceptCode,
    sourceConceptId,
    createdAt,
  }))
}

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
        const raw = await storage.datasetRawFiles.get(df.id)

        if (raw?.blob) {
          // Original uploaded file (CSV/XLSX/parquet) kept verbatim for the user.
          zip.file(`datasets/${folderName}/${raw.fileName}`, raw.blob, { compression: 'STORE' })
          // Parsed rows sidecar so import restores the table without re-parsing XLSX/parquet.
          if (data && data.rows.length > 0) {
            zip.file(`datasets/${folderName}/_data.json`, json({ rows: data.rows }))
          }
        } else if (data && data.rows.length > 0) {
          // Computed dataset (no source file): reconstructed CSV, always named .csv.
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
          const baseName = (dsPath.split('/').pop() ?? df.name).replace(/\.[^.]+$/, '')
          zip.file(`datasets/${folderName}/${baseName}.csv`, csvRows.join('\n'))
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
    gitignoreLines.unshift('datasets/**/*.csv', 'datasets/**/*.parquet', 'datasets/**/*.xlsx', 'datasets/**/*.xls')
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
  /** Original uploaded files (CSV/XLSX/parquet) to restore into datasetRawFiles. */
  datasetRawFiles: DatasetRawFile[]
  attachmentsMeta: Omit<ReadmeAttachment, 'data'>[]
  /** Keyed by attachment id */
  attachmentBlobs: Map<string, ArrayBuffer>
}

/**
 * Write a parsed project's sub-entities (IDE files, pipelines, cohorts, connections,
 * dashboards + tabs + widgets, datasets + analyses + data + raw files, attachments) into
 * storage under `projectUid`, remapping every child id to a fresh UUID so records from a
 * different instance never collide. The project record itself must already exist.
 * Shared by project import, workspace import, and git clone — does NOT touch in-memory caches.
 */
export async function importProjectContent(
  parsed: ParsedProjectZip,
  projectUid: string,
  storage: Storage,
): Promise<void> {
  const idMap = new Map<string, string>()
  const mapId = (oldId: string): string => {
    if (!idMap.has(oldId)) idMap.set(oldId, crypto.randomUUID())
    return idMap.get(oldId)!
  }

  for (const f of parsed.ideFiles) {
    await storage.ideFiles.create({ ...f, id: mapId(f.id), projectUid, parentId: f.parentId ? mapId(f.parentId) : null })
  }
  for (const p of parsed.pipelines) {
    await storage.pipelines.create({ ...p, id: mapId(p.id), projectUid })
  }
  for (const c of parsed.cohorts) {
    await storage.cohorts.create({ ...c, id: mapId(c.id), projectUid })
  }
  for (const c of parsed.connections) {
    await storage.connections.create({ ...c, id: mapId(c.id), projectUid })
  }
  for (const d of parsed.dashboards) {
    const filterConfig = (d.filterConfig ?? []).map(f => ({
      ...f,
      id: mapId(f.id),
      datasetFileId: mapId(f.datasetFileId),
      ...(f.scope?.type === 'tabs' ? { scope: { ...f.scope, tabIds: f.scope.tabIds.map(mapId) } } : {}),
      ...(f.scope?.type === 'widgets' ? { scope: { ...f.scope, widgetIds: f.scope.widgetIds.map(mapId) } } : {}),
    }))
    await storage.dashboards.create({
      ...d,
      id: mapId(d.id),
      projectUid,
      filterConfig,
      defaultDatasetFileId: d.defaultDatasetFileId ? mapId(d.defaultDatasetFileId) : d.defaultDatasetFileId,
    })
  }
  for (const tab of parsed.dashboardTabs) {
    await storage.dashboardTabs.create({ ...tab, id: mapId(tab.id), dashboardId: mapId(tab.dashboardId), parentTabId: tab.parentTabId ? mapId(tab.parentTabId) : (tab.parentTabId ?? null) })
  }
  for (const w of parsed.dashboardWidgets) {
    await storage.dashboardWidgets.create({
      ...w,
      id: mapId(w.id),
      tabId: mapId(w.tabId),
      datasetFileId: w.datasetFileId ? mapId(w.datasetFileId) : w.datasetFileId,
    })
  }
  for (const df of parsed.datasetFiles) {
    await storage.datasetFiles.create({ ...df, id: mapId(df.id), projectUid, parentId: df.parentId ? mapId(df.parentId) : null })
  }
  for (const a of parsed.datasetAnalyses) {
    await storage.datasetAnalyses.create({ ...a, id: mapId(a.id), datasetFileId: mapId(a.datasetFileId) })
  }
  for (const dd of parsed.datasetData) {
    await storage.datasetData.save({ datasetFileId: mapId(dd.datasetFileId), rows: dd.rows })
  }
  for (const rf of parsed.datasetRawFiles ?? []) {
    await storage.datasetRawFiles.save({ datasetFileId: mapId(rf.datasetFileId), blob: rf.blob, fileName: rf.fileName })
  }
  for (const meta of parsed.attachmentsMeta) {
    const blobData = parsed.attachmentBlobs.get(meta.id)
    if (blobData) {
      await storage.readmeAttachments.create({
        ...meta, id: mapId(meta.id), projectUid, data: blobData,
      } as ReadmeAttachment)
    }
  }
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
export function parseCsvToDatasetData(csv: string, df: DatasetFile): DatasetData | null {
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
export function parseCsvLine(line: string): string[] {
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
    datasetFiles, datasetAnalyses, datasetData: [], datasetRawFiles: [], attachmentsMeta, attachmentBlobs,
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
    // Skip the dataset metadata sidecars — only true analysis JSONs become datasetAnalyses.
    // (_data.json holds parsed rows, not an analysis: parsing it here pushed an idless object whose
    //  mapId(undefined) collided across every data file, breaking import with a uniqueness error.)
    if (path.endsWith('/_tree.json') || path.endsWith('/_columns.json') || path.endsWith('/_data.json')) continue
    if (path.endsWith('.json')) {
      datasetAnalyses.push(JSON.parse(await entry.async('string')))
    }
  }

  // --- Dataset data + raw files (v3: datasets/{folder}/, v2: _data/) ---
  const datasetData: DatasetData[] = []
  const datasetRawFiles: DatasetRawFile[] = []
  if (datasetFiles.length > 0) {
    const byId = new Map(datasetFiles.map(f => [f.id, f]))
    for (const df of datasetFiles) {
      if (df.type !== 'file') continue
      const dsPath = buildDatasetPath(df, byId)
      const folderName = dsPath.replace(/\.[^.]+$/, '')
      const fileName = dsPath.split('/').pop() ?? dsPath

      // Find the data file in this dataset's folder (the original upload or reconstructed CSV).
      // It is the only non-metadata entry besides _columns.json / analysis JSONs / _data.json.
      const dsFolderPrefix = `datasets/${folderName}/`
      let rawEntry: { name: string; entry: JSZip.JSZipObject } | null = null
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir || !path.startsWith(dsFolderPrefix)) continue
        const rest = path.slice(dsFolderPrefix.length)
        if (rest.includes('/')) continue // belongs to a nested dataset folder
        if (rest === '_columns.json' || rest === '_data.json' || rest === '_tree.json') continue
        if (rest.endsWith('.json')) continue // analysis files
        rawEntry = { name: rest, entry }
        break
      }

      // Parsed rows: prefer the _data.json sidecar (format-agnostic), else parse a CSV.
      const sidecar = zip.files[`datasets/${folderName}/_data.json`]
      if (sidecar) {
        const { rows } = JSON.parse(await sidecar.async('string')) as { rows: Record<string, unknown>[] }
        if (rows?.length) datasetData.push({ datasetFileId: df.id, rows })
      } else {
        const csvEntry = rawEntry?.entry
          ?? zip.files[`datasets/${folderName}/${fileName}`]
          ?? zip.files[`_data/${dsPath}`]
        if (csvEntry) {
          const parsed = parseCsvToDatasetData(await csvEntry.async('string'), df)
          if (parsed) datasetData.push(parsed)
        }
      }

      // Restore the original uploaded file so "Import settings" works after re-import.
      if (rawEntry) {
        const blob = await rawEntry.entry.async('blob')
        datasetRawFiles.push({ datasetFileId: df.id, blob, fileName: rawEntry.name })
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
    datasetFiles, datasetAnalyses, datasetData, datasetRawFiles, attachmentsMeta, attachmentBlobs,
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
  /**
   * Per-entity opt-in to include full content for entities NOT linked to a git repo.
   * Keyed by the entity's stable id (project.uid, mappingProject.id, sqlCollection.id, etlPipeline.id).
   * Git-linked entities always export metadata + git pointer only and ignore this flag.
   * Defaults to false (metadata only) when an entity id is absent.
   */
  includeEntityData?: Record<string, boolean>
  /**
   * Per-entity opt-out: when an entity id maps to true, that entity is omitted from the
   * export entirely (no metadata, no git-link entry). Entities are included by default.
   * Keyed by the same stable ids as includeEntityData.
   */
  excludeEntities?: Record<string, boolean>
}

/** A single git-linked entity recorded in the workspace's git-links.json manifest. */
export interface GitLinkEntry {
  type: 'project' | 'mapping-project' | 'sql-collection' | 'etl-pipeline'
  /** Stable entity id (project.uid or entity id). */
  id: string
  /** Folder name used inside the workspace zip (projectId / entityId / slug). */
  folder: string
  url: string
  branch: string
}

/**
 * Resolve an entity's git link, tolerating the legacy `Project.gitUrl` field.
 * Returns null when the entity is not linked to any git repo.
 */
export function resolveGitRemote(entity: { gitRemoteConfig?: GitRemoteConfig; gitUrl?: string }): GitRemoteConfig | null {
  if (entity.gitRemoteConfig?.url) return entity.gitRemoteConfig
  if (entity.gitUrl) return { url: entity.gitUrl, branch: 'main' }
  return null
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
 * Lay out a SQL script collection in a git-friendly tree under `prefix`:
 * `_collection.json` (metadata), `_tree.json` (file hierarchy without content),
 * and each script written at its real path with its raw `.sql` content.
 */
export async function buildSqlCollectionFolder(
  zip: JSZip,
  prefix: string,
  collection: SqlScriptCollection,
  storage: Storage,
): Promise<void> {
  zip.file(`${prefix}_collection.json`, json(collection))
  const files = await storage.sqlScriptFiles.getByCollection(collection.id)
  const byId = new Map(files.map(f => [f.id, f]))
  zip.file(`${prefix}_tree.json`, json(files.map(({ content: _, ...meta }) => meta)))
  for (const f of files) {
    if (f.type === 'file' && f.content != null) {
      zip.file(`${prefix}${buildTreePath(f, byId)}`, f.content)
    }
  }
}

/**
 * Reconstruct tree files (SqlScriptFile / EtlFile) from a parsed import ZIP that uses
 * the git-friendly layout (`_tree.json` for metadata + raw files at their real paths).
 * `parsed` keys are zip paths relative to the collection/pipeline root (after any prefix
 * is stripped by the caller). Folders carry no content; file content comes from the
 * raw entry matching the file's reconstructed path.
 */
export function reconstructTreeFiles<T extends { id: string; name: string; type: 'file' | 'folder'; parentId: string | null; content?: string }>(
  tree: T[],
  parsed: Record<string, unknown>,
): T[] {
  const byId = new Map(tree.map(f => [f.id, f]))
  return tree.map(f => {
    if (f.type !== 'file') return f
    const path = buildTreePath(f, byId as Map<string, { id: string; name: string; parentId: string | null }>)
    const raw = parsed[path]
    return typeof raw === 'string' ? { ...f, content: raw } : f
  })
}

/**
 * Apply the content of a cloned git repo (root = one entity's export layout) into storage,
 * filling in the content of an already-imported, git-linked entity.
 * Returns true when content was applied, false when the repo didn't match the expected layout.
 */
export async function applyClonedEntity(
  zip: JSZip,
  type: GitLinkedEntity['type'],
  targetId: string,
  storage: Storage,
): Promise<boolean> {
  const readJson = async <T>(name: string): Promise<T | null> => {
    const entry = zip.files[name]
    return entry ? (JSON.parse(await entry.async('string')) as T) : null
  }

  if (type === 'sql-collection' || type === 'etl-pipeline') {
    const treeName = '_tree.json'
    const tree = (await readJson<(SqlScriptFile | EtlFile)[]>(treeName)) ?? []
    if (tree.length === 0) return false
    const byId = new Map(tree.map(f => [f.id, f as { id: string; name: string; parentId: string | null }]))
    const fkKey = type === 'sql-collection' ? 'collectionId' : 'pipelineId'
    for (const f of tree) {
      const rec: Record<string, unknown> = { ...f, [fkKey]: targetId }
      if (f.type === 'file') {
        const entry = zip.files[buildTreePath(f, byId)]
        if (entry) rec.content = await entry.async('string')
      }
      if (type === 'sql-collection') await storage.sqlScriptFiles.create(rec as unknown as SqlScriptFile).catch(() => {})
      else await storage.etlFiles.create(rec as unknown as EtlFile).catch(() => {})
    }
    return true
  }

  if (type === 'mapping-project') {
    const mappings = (await readJson<ConceptMapping[]>('mappings.json')) ?? []
    let applied = false
    for (const m of mappings) {
      await storage.conceptMappings.create({ ...m, projectId: targetId }).catch(() => {})
      applied = true
    }
    return applied
  }

  // project: parse the cloned repo as a project ZIP and write its sub-entities under targetId.
  const blob = await zip.generateAsync({ type: 'blob' })
  const parsed = await parseProjectZip(new File([blob], 'clone.zip'))
  if (!parsed) return false
  await importProjectContent(parsed, targetId, storage)
  return true
}

/**
 * Lay out an ETL pipeline in a git-friendly tree under `prefix`:
 * `_pipeline.json` (metadata), `_tree.json` (file hierarchy without content),
 * and each script written at its real path with its raw content.
 */
export async function buildEtlPipelineFolder(
  zip: JSZip,
  prefix: string,
  pipeline: EtlPipeline,
  storage: Storage,
): Promise<void> {
  zip.file(`${prefix}_pipeline.json`, json(pipeline))
  const files = await storage.etlFiles.getByPipeline(pipeline.id)
  const byId = new Map(files.map(f => [f.id, f]))
  zip.file(`${prefix}_tree.json`, json(files.map(({ content: _, ...meta }) => meta)))
  for (const f of files) {
    if (f.type === 'file' && f.content != null) {
      zip.file(`${prefix}${buildTreePath(f, byId)}`, f.content)
    }
  }
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

/** Resolve a user plugin's manifest id from its bundled plugin.json (falls back to undefined). */
function pluginManifestId(plugin: UserPlugin): string | undefined {
  try {
    return (JSON.parse(plugin.files['plugin.json'] ?? '{}') as { id?: string }).id
  } catch {
    return undefined
  }
}

/** Count of workspace plugins that are NOT copies of a built-in (i.e. genuinely exported). */
export async function countExportablePlugins(workspaceId: string, storage: Storage): Promise<number> {
  const { getAllPlugins } = await import('@/lib/plugins/registry')
  const builtinIds = new Set(getAllPlugins().filter(p => !p.workspaceId).map(p => p.manifest.id))
  const plugins = await storage.userPlugins.getByWorkspace(workspaceId)
  return plugins.filter(p => !builtinIds.has(pluginManifestId(p) ?? p.id)).length
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

  // Git-link manifest: collected across all sections, written as git-links.json at the end.
  const gitLinks: GitLinkEntry[] = []
  const includeData = options.includeEntityData ?? {}
  const excluded = options.excludeEntities ?? {}

  // --- workspace.json ---
  const { readme: wsReadme, ...wsMeta } = workspace
  zip.file('workspace.json', json({ ...wsMeta, appVersion: APP_VERSION }))

  // --- README.md ---
  if (wsReadme) {
    zip.file('README.md', wsReadme)
  }

  // --- projects/ ---
  // Git-linked projects: metadata + README + git pointer only (full content lives in the project's own repo).
  // Unlinked projects: metadata only by default; full content when includeEntityData[uid] is true.
  if (on('projects')) {
    const allProjects = await storage.projects.getAll()
    const wsProjects = allProjects.filter(p => p.workspaceId === workspaceId)
    for (const project of wsProjects) {
      if (excluded[project.uid]) continue
      const folder = project.projectId || slugify(resolveProjectName(project))
      const git = resolveGitRemote(project)
      const { todos: _t, notes: _n, readmeHistory: _rh, gitUrl: _gu, ...projectMeta } = project
      const projectMetaOut = { ...projectMeta, ...(git ? { gitRemoteConfig: git } : {}), appVersion: APP_VERSION }

      if (git) {
        // Metadata + git pointer only — content comes from the linked repo at portal build time.
        zip.file(`projects/${folder}/project.json`, json(projectMetaOut))
        if (project.readme) zip.file(`projects/${folder}/README.md`, project.readme)
        gitLinks.push({ type: 'project', id: project.uid, folder, url: git.url, branch: git.branch })
      } else if (includeData[project.uid]) {
        // Full project content nested under projects/<folder>/ (reuses buildProjectZip layout).
        // The per-project "include data" checkbox is the request to bundle data files too.
        const sub = await buildProjectZip(project.uid, storage, { includeDataFiles: true })
        if (sub) {
          const subZip = await JSZip.loadAsync(sub.blob)
          await Promise.all(Object.keys(subZip.files).map(async (path) => {
            const entry = subZip.files[path]
            if (entry.dir) return
            zip.file(`projects/${folder}/${path}`, await entry.async('uint8array'))
          }))
        }
      } else {
        // Lightweight: catalog-relevant metadata + README only.
        zip.file(`projects/${folder}/project.json`, json(projectMetaOut))
        if (project.readme) zip.file(`projects/${folder}/README.md`, project.readme)
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
      if (excluded[sp.presetId]) continue
      zip.file(`schemas/${slugify(sp.presetId)}.json`, json(sp))
    }
  }

  // --- databases/ (always exported when section enabled; credentials opt-in, passwords never) ---
  if (on('databases')) {
    const keepCreds = options.includeCredentials === true
    const dataSources = await storage.dataSources.getByWorkspace(workspaceId)
    for (const ds of dataSources) {
      if (excluded[ds.id]) continue
      // DataSource has no index signature; widen via unknown to destructure dynamically
      const { connectionConfig, ...rest } = ds as unknown as Record<string, unknown>
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
      if (excluded[collection.id]) continue
      const folder = eid(collection)
      const git = resolveGitRemote(collection)

      if (git) {
        // Metadata + git pointer only.
        zip.file(`sql-scripts/${folder}/_collection.json`, json(collection))
        gitLinks.push({ type: 'sql-collection', id: collection.id, folder, url: git.url, branch: git.branch })
        continue
      }

      if (!includeData[collection.id]) {
        zip.file(`sql-scripts/${folder}/_collection.json`, json(collection))
        continue
      }
      await buildSqlCollectionFolder(zip, `sql-scripts/${folder}/`, collection, storage)
    }
  }

  // --- etl/ ---
  if (on('etl')) {
    const etlPipelines = await storage.etlPipelines.getByWorkspace(workspaceId)
    for (const pipeline of etlPipelines) {
      if (excluded[pipeline.id]) continue
      const folder = eid(pipeline)
      const git = resolveGitRemote(pipeline)

      if (git) {
        zip.file(`etl/${folder}/_pipeline.json`, json(pipeline))
        gitLinks.push({ type: 'etl-pipeline', id: pipeline.id, folder, url: git.url, branch: git.branch })
        continue
      }

      if (!includeData[pipeline.id]) {
        zip.file(`etl/${folder}/_pipeline.json`, json(pipeline))
        continue
      }
      await buildEtlPipelineFolder(zip, `etl/${folder}/`, pipeline, storage)
    }
  }

  // --- data-quality/ ---
  if (on('dataQuality')) {
    const dqRuleSets = await storage.dqRuleSets.getByWorkspace(workspaceId)
    for (const rs of dqRuleSets) {
      if (excluded[rs.id]) continue
      const checks = await storage.dqCustomChecks.getByRuleSet(rs.id)
      zip.file(`data-quality/${eid(rs)}.json`, json({ ruleSet: rs, checks }))
    }
  }

  // --- mapping-projects/ (reuses buildMappingProjectFolder for full export) ---
  if (on('conceptMapping')) {
    const mappingProjects = await storage.mappingProjects.getByWorkspace(workspaceId)
    for (const mp of mappingProjects) {
      if (excluded[mp.id]) continue
      const folder = eid(mp)
      const git = resolveGitRemote(mp)

      if (git) {
        // Metadata + git pointer only — mappings.json / source-concepts.csv live in the linked repo.
        const { conceptSetIds: _cs, importBatches: _ib, fileSourceData: _fsd, ...mpMeta } = mp
        zip.file(`mapping-projects/${folder}/project.json`, json({ ...mpMeta, gitRemoteConfig: git }))
        gitLinks.push({ type: 'mapping-project', id: mp.id, folder, url: git.url, branch: git.branch })
        continue
      }

      if (!includeData[mp.id]) {
        // Unlinked, data not requested: metadata only (skip mappings + source concepts).
        const { conceptSetIds: _cs, importBatches: _ib, fileSourceData: _fsd, ...mpMeta } = mp
        zip.file(`mapping-projects/${folder}/project.json`, json(mpMeta))
        continue
      }

      await buildMappingProjectFolder(zip, `mapping-projects/${folder}/`, mp, storage)
    }

    // --- source-concept-ids/ (ranges + compact entries for cross-project ID assignment) ---
    const idRanges = await storage.sourceConceptIdRanges.getByWorkspace(workspaceId)
    if (idRanges.length > 0) {
      zip.file('source-concept-ids/ranges.json', json(idRanges))
      const idEntries = await storage.sourceConceptIdEntries.getByWorkspace(workspaceId)
      if (idEntries.length > 0) {
        zip.file('source-concept-ids/entries.json', json(toCompactEntries(idEntries)))
      }
    }
  }

  // --- catalogs/ + service-mappings/ ---
  if (on('catalogs')) {
    const catalogs = await storage.dataCatalogs.getByWorkspace(workspaceId)
    for (const cat of catalogs) {
      if (excluded[cat.id]) continue
      zip.file(`catalogs/${eid(cat)}.json`, json(cat))
    }

    const serviceMappings = await storage.serviceMappings.getByWorkspace(workspaceId)
    for (const sm of serviceMappings) {
      if (excluded[sm.id]) continue
      zip.file(`service-mappings/${slugify(sm.name || sm.id)}.json`, json(sm))
    }
  }

  // --- plugins/ ---
  // Built-in plugins (added to a workspace via "Add default") are reconstitutable from
  // the app's own registry on import, so we never bundle their code — only true
  // workspace-authored plugins are exported.
  if (on('plugins')) {
    const { getAllPlugins } = await import('@/lib/plugins/registry')
    const builtinIds = new Set(getAllPlugins().filter(p => !p.workspaceId).map(p => p.manifest.id))
    const plugins = (await storage.userPlugins.getByWorkspace(workspaceId))
      .filter(p => !builtinIds.has(pluginManifestId(p) ?? p.id))
    for (const plugin of plugins) {
      const folder = plugin.entityId || slugify(plugin.id)
      zip.file(`plugins/${folder}/_plugin.json`, json({ id: plugin.id, entityId: plugin.entityId, workspaceId: plugin.workspaceId, createdAt: plugin.createdAt, updatedAt: plugin.updatedAt }))
      for (const [filename, content] of Object.entries(plugin.files)) {
        zip.file(`plugins/${folder}/${filename}`, content)
      }
    }
  }

  // --- git-links.json (manifest of git-linked entities; portal build derives .gitmodules from it) ---
  if (gitLinks.length > 0) {
    zip.file('git-links.json', json({ appVersion: APP_VERSION, links: gitLinks }))
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
  sourceConceptIdRanges: SourceConceptIdRange[]
  sourceConceptIdEntries: SourceConceptIdEntry[]
  catalogs: DataCatalog[]
  serviceMappings: ServiceMapping[]
  plugins: UserPlugin[]
}

/** A git-linked entity discovered in a parsed workspace ZIP (metadata only — content lives in its repo). */
export interface GitLinkedEntity {
  type: 'project' | 'mapping-project' | 'sql-collection' | 'etl-pipeline'
  /** Stable id (project.uid or entity id) of the created record, for a later clone. */
  id: string
  name: string
  url: string
  branch: string
}

/**
 * List every entity in a parsed workspace ZIP that carries a git link.
 * These import as metadata only — their full content stays in the linked repo
 * until cloned (the portal build does this; the app can offer a best-effort clone).
 */
export function collectGitLinkedEntities(parsed: ParsedWorkspaceZip): GitLinkedEntity[] {
  const out: GitLinkedEntity[] = []
  const push = (type: GitLinkedEntity['type'], id: string, name: string, cfg?: GitRemoteConfig) => {
    if (cfg?.url) out.push({ type, id, name, url: cfg.url, branch: cfg.branch || 'main' })
  }
  for (const e of parsed.projectEntries) {
    push('project', e.project.uid, resolveProjectName(e.project), resolveGitRemote(e.project) ?? undefined)
  }
  for (const { collection } of parsed.sqlCollections) push('sql-collection', collection.id, collection.name, resolveGitRemote(collection) ?? undefined)
  for (const { pipeline } of parsed.etlPipelines) push('etl-pipeline', pipeline.id, pipeline.name, resolveGitRemote(pipeline) ?? undefined)
  for (const { project } of parsed.mappingProjects) push('mapping-project', project.id, project.name, resolveGitRemote(project) ?? undefined)
  return out
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

    // Restore rawFileBuffer + columnMapping from source-concepts.csv (file-based projects)
    const sourceCsvEntry = zipData.files[`${prefix}source-concepts.csv`]
    if (sourceCsvEntry && project.sourceType === 'file' && project.fileSourceData) {
      const csvText = await sourceCsvEntry.async('string')
      if (csvText) {
        restoreFileSourceDataFromCsv(project, csvText)
      }
    }

    mappingProjects.push({ project, mappings })
  }

  // --- source-concept-ids/ (cross-project ID assignment registry) ---
  const sourceConceptIdRanges = (await readJsonFile<SourceConceptIdRange[]>(zipData, 'source-concept-ids/ranges.json')) ?? []
  const rawEntries = await readJsonFile<CompactSourceConceptIdEntries | SourceConceptIdEntry[]>(zipData, 'source-concept-ids/entries.json')
  const sourceConceptIdEntries = rawEntries ? parseSourceConceptIdEntries(rawEntries, workspace.id) : []

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
    mappingProjects, sourceConceptIdRanges, sourceConceptIdEntries,
    catalogs, serviceMappings, plugins,
  }
}
