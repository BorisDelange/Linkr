/**
 * Shared utilities for entity export/import (ZIP and JSON).
 */
import JSZip from 'jszip'
import type { Storage } from '@/lib/storage'
import { APP_VERSION } from '@/lib/version'
import type {
  Project, IdeFile, Pipeline, Cohort, IdeConnection,
  Dashboard, DashboardTab, DashboardWidget,
  DatasetFile, DatasetAnalysis, ReadmeAttachment,
} from '@/types'

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
// Slugify & timestamp
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'export'
}

/** Returns a timestamp string like `2025-12-01_13-23-43`. */
export function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
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
 * Parse a ZIP file and return all JSON files as parsed objects.
 */
export async function parseImportZip(
  file: File,
): Promise<Record<string, unknown>> {
  const zip = await JSZip.loadAsync(file)
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
// Project ZIP — structured folder layout
// ---------------------------------------------------------------------------
//
// ZIP layout (system folders prefixed with _ to avoid collision with IDE files):
//   project.json                      — project metadata (without readme/todos/notes)
//   README.md                         — readme content
//   tasks.json                        — { todos, notes }
//   _ide_tree.json                    — IDE file tree metadata (for round-trip import)
//   {ide files at root}               — IDE files preserving their folder hierarchy
//   _pipeline/pipeline.json           — array of pipelines
//   _cohorts/{slug}.json              — one file per cohort
//   _databases/{slug}.json            — one file per IDE connection
//   _dashboards/{slug}.json           — dashboard + its tabs + widgets
//   _datasets/{dataset}/
//     _columns.json                   — column metadata from DatasetFile
//     {analysis-slug}.json            — one file per analysis
//   _data/{name}                      — dataset data as CSV (optional)
//   _attachments/{filename}           — readme attachment binaries
//   _attachments/_meta.json           — attachment metadata (ids, mime, size)
// ---------------------------------------------------------------------------

export interface BuildProjectZipOptions {
  includeDataFiles?: boolean // default false
}

function resolveProjectName(project: Project): string {
  return typeof project.name === 'string'
    ? project.name
    : (project.name.en || Object.values(project.name)[0] || 'project')
}

/** Build the full path for an IdeFile, preserving its folder hierarchy at the ZIP root. */
function buildIdePath(file: IdeFile, byId: Map<string, IdeFile>): string {
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

  // --- IDE files (at ZIP root, preserving their folder hierarchy) ---
  const ideFiles = await storage.ideFiles.getByProject(projectUid)
  if (ideFiles.length > 0) {
    const byId = new Map(ideFiles.map(f => [f.id, f]))
    // Write _ide_tree.json with metadata only (no content — files are at root)
    zip.file('_ide_tree.json', json(ideFiles.map(({ content: _, ...meta }) => meta)))
    for (const f of ideFiles) {
      if (f.type === 'file' && f.content != null) {
        zip.file(buildIdePath(f, byId), f.content)
      }
    }
  }

  // --- _pipeline/ ---
  const pipelines = await storage.pipelines.getByProject(projectUid)
  if (pipelines.length > 0) {
    zip.file('_pipeline/pipeline.json', json(pipelines))
  }

  // --- _cohorts/ ---
  const cohorts = await storage.cohorts.getByProject(projectUid)
  for (const c of cohorts) {
    zip.file(`_cohorts/${slugify(c.name || c.id)}.json`, json(c))
  }

  // --- _databases/ (IDE connections) ---
  const connections = await storage.connections.getByProject(projectUid)
  for (const c of connections) {
    zip.file(`_databases/${slugify(c.name || c.id)}.json`, json(c))
  }

  // --- _dashboards/ (each dashboard = dashboard + tabs + widgets in one file) ---
  const dashboards = await storage.dashboards.getByProject(projectUid)
  for (const d of dashboards) {
    const tabs = await storage.dashboardTabs.getByDashboard(d.id)
    const widgets: DashboardWidget[] = []
    for (const tab of tabs) {
      widgets.push(...(await storage.dashboardWidgets.getByTab(tab.id)))
    }
    zip.file(`_dashboards/${slugify(d.name || d.id)}.json`, json({ dashboard: d, tabs, widgets }))
  }

  // --- _datasets/ + _data/ ---
  const datasetFiles = await storage.datasetFiles.getByProject(projectUid)
  if (datasetFiles.length > 0) {
    const byId = new Map(datasetFiles.map(f => [f.id, f]))
    zip.file('_datasets/_tree.json', json(datasetFiles))

    for (const df of datasetFiles) {
      if (df.type !== 'file') continue
      const dsPath = buildDatasetPath(df, byId)
      const folderName = dsPath.replace(/\.[^.]+$/, '')

      if (df.columns && df.columns.length > 0) {
        zip.file(`_datasets/${folderName}/_columns.json`, json(df.columns))
      }

      const analyses = await storage.datasetAnalyses.getByDataset(df.id)
      for (const a of analyses) {
        zip.file(`_datasets/${folderName}/${slugify(a.name || a.id)}.json`, json(a))
      }

      if (includeDataFiles) {
        const data = await storage.datasetData.get(df.id)
        if (data && data.rows.length > 0) {
          const cols = df.columns?.map(c => c.name) ?? Object.keys(data.rows[0])
          const csvRows = [
            cols.join(','),
            ...data.rows.map(row =>
              cols.map(c => {
                const v = row[c]
                if (v == null) return ''
                const s = String(v)
                return s.includes(',') || s.includes('"') || s.includes('\n')
                  ? `"${s.replace(/"/g, '""')}"`
                  : s
              }).join(',')
            ),
          ]
          zip.file(`_data/${dsPath}`, csvRows.join('\n'))
        }
      }
    }
  }

  // --- _attachments/ ---
  const attachments = await storage.readmeAttachments.getByProject(projectUid)
  if (attachments.length > 0) {
    const meta = attachments.map(({ data: _, ...rest }) => rest)
    zip.file('_attachments/_meta.json', json(meta))
    for (const att of attachments) {
      zip.file(`_attachments/${att.id}-${att.fileName}`, att.data)
    }
  }

  // --- .gitignore ---
  zip.file('.gitignore', '_data/\n.cache/\n')

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
  attachmentsMeta: Omit<ReadmeAttachment, 'data'>[]
  /** Keyed by attachment id */
  attachmentBlobs: Map<string, ArrayBuffer>
}

export async function parseProjectZip(file: File): Promise<ParsedProjectZip | null> {
  const zipData = await JSZip.loadAsync(file)

  // Detect layout: new (has _ide_tree.json or cohorts/ or dashboards/) vs legacy (has ide-files.json)
  const hasLegacyLayout = zipData.files['ide-files.json'] != null || zipData.files['cohorts.json'] != null
  const hasNewLayout = zipData.files['_ide_tree.json'] != null
    || Object.keys(zipData.files).some(p => p.startsWith('_cohorts/') || p.startsWith('_dashboards/'))

  if (!hasLegacyLayout && !hasNewLayout) {
    // Might be legacy with just project.json
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
    datasetFiles, datasetAnalyses, attachmentsMeta, attachmentBlobs,
  }
}

async function parseNewLayout(zip: JSZip, project: Project): Promise<ParsedProjectZip> {
  // --- IDE files (metadata from _ide_tree.json, content from actual files) ---
  const ideFiles = (await readJsonFile<IdeFile[]>(zip, '_ide_tree.json')) ?? []
  if (ideFiles.length > 0) {
    const byId = new Map(ideFiles.map(f => [f.id, f]))
    for (const f of ideFiles) {
      if (f.type !== 'file') continue
      const path = buildIdePath(f, byId)
      const entry = zip.files[path]
      if (entry) {
        f.content = await entry.async('string')
      }
    }
  }

  // --- Pipelines ---
  const pipelines = (await readJsonFile<Pipeline[]>(zip, '_pipeline/pipeline.json')) ?? []

  // --- Cohorts (one file each) ---
  const cohorts: Cohort[] = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (path.startsWith('_cohorts/') && path.endsWith('.json') && !entry.dir) {
      cohorts.push(JSON.parse(await entry.async('string')))
    }
  }

  // --- Connections (_databases/) ---
  const connections: IdeConnection[] = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (path.startsWith('_databases/') && path.endsWith('.json') && !entry.dir) {
      connections.push(JSON.parse(await entry.async('string')))
    }
  }

  // --- Dashboards (each file = { dashboard, tabs, widgets }) ---
  const dashboards: Dashboard[] = []
  const dashboardTabs: DashboardTab[] = []
  const dashboardWidgets: DashboardWidget[] = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (path.startsWith('_dashboards/') && path.endsWith('.json') && !entry.dir) {
      const bundle = JSON.parse(await entry.async('string')) as {
        dashboard: Dashboard; tabs: DashboardTab[]; widgets: DashboardWidget[]
      }
      dashboards.push(bundle.dashboard)
      dashboardTabs.push(...(bundle.tabs ?? []))
      dashboardWidgets.push(...(bundle.widgets ?? []))
    }
  }

  // --- Dataset files + analyses ---
  const datasetFiles = (await readJsonFile<DatasetFile[]>(zip, '_datasets/_tree.json')) ?? []
  const datasetAnalyses: DatasetAnalysis[] = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!path.startsWith('_datasets/') || entry.dir) continue
    if (path.endsWith('/_tree.json') || path.endsWith('/_columns.json')) continue
    if (path.endsWith('.json')) {
      datasetAnalyses.push(JSON.parse(await entry.async('string')))
    }
  }

  // --- Attachments ---
  const attachmentsMeta = (await readJsonFile<Omit<ReadmeAttachment, 'data'>[]>(zip, '_attachments/_meta.json')) ?? []
  const attachmentBlobs = new Map<string, ArrayBuffer>()
  for (const meta of attachmentsMeta) {
    const blobKey = `_attachments/${meta.id}-${meta.fileName}`
    const entry = zip.files[blobKey]
    if (entry) attachmentBlobs.set(meta.id, await entry.async('arraybuffer'))
  }

  return {
    project, ideFiles, pipelines, cohorts, connections,
    dashboards, dashboardTabs, dashboardWidgets,
    datasetFiles, datasetAnalyses, attachmentsMeta, attachmentBlobs,
  }
}
