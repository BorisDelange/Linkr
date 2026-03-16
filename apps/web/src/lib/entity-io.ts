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
  Workspace, WikiPage, WikiAttachment,
  SqlScriptCollection, SqlScriptFile,
  EtlPipeline, EtlFile,
  DqRuleSet, DqCustomCheck,
  ConceptSet, MappingProject, ConceptMapping,
  DataCatalog, ServiceMapping, UserPlugin,
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

// ---------------------------------------------------------------------------
// Workspace ZIP — full workspace export/import
// ---------------------------------------------------------------------------
//
// ZIP layout:
//   workspace.json                            — workspace metadata
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
//   dq/{slug}.json                            — { ruleSet, checks }
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
 * Build a ZIP blob containing all workspace data.
 * Reuses `buildProjectZip` for each project to avoid code duplication.
 */
export async function buildWorkspaceZip(
  workspaceId: string,
  storage: Storage,
  options: BuildWorkspaceZipOptions = {},
): Promise<{ blob: Blob; workspaceName: string } | null> {
  const workspace = await storage.workspaces.getById(workspaceId)
  if (!workspace) return null

  const zip = new JSZip()

  // --- workspace.json ---
  zip.file('workspace.json', json({ ...workspace, appVersion: APP_VERSION }))

  // --- projects/ (reuse buildProjectZip for each) ---
  const allProjects = await storage.projects.getAll()
  const wsProjects = allProjects.filter(p => p.workspaceId === workspaceId)
  for (const project of wsProjects) {
    const projectResult = await buildProjectZip(project.uid, storage, options)
    if (!projectResult) continue
    const projectSlug = slugify(resolveProjectName(project))
    // Unpack the project ZIP into projects/{slug}/
    const projectZipData = await JSZip.loadAsync(projectResult.blob)
    for (const [path, entry] of Object.entries(projectZipData.files)) {
      if (entry.dir) continue
      const content = await entry.async('arraybuffer')
      zip.file(`projects/${projectSlug}/${path}`, content)
    }
  }

  // --- wiki/ ---
  const wikiPages = await storage.wikiPages.getByWorkspace(workspaceId)
  if (wikiPages.length > 0) {
    // _tree.json: page metadata (without content — content goes in .md files)
    const treeMeta = wikiPages.map(({ content: _, history: _h, ...meta }) => meta)
    zip.file('wiki/_tree.json', json(treeMeta))

    for (const page of wikiPages) {
      const pageSlug = slugify(page.title || page.id)
      zip.file(`wiki/${pageSlug}--${page.id}.md`, page.content || '')
    }

    // Wiki attachments
    const wikiAttachments = await storage.wikiAttachments.getByWorkspace(workspaceId)
    if (wikiAttachments.length > 0) {
      const meta = wikiAttachments.map(({ data: _, ...rest }) => rest)
      zip.file('wiki/_attachments/_meta.json', json(meta))
      for (const att of wikiAttachments) {
        zip.file(`wiki/_attachments/${att.id}-${att.fileName}`, att.data)
      }
    }
  }

  // --- sql-scripts/ ---
  const sqlCollections = await storage.sqlScriptCollections.getByWorkspace(workspaceId)
  for (const collection of sqlCollections) {
    const collSlug = slugify(collection.name || collection.id)
    const files = await storage.sqlScriptFiles.getByCollection(collection.id)
    const byId = new Map(files.map(f => [f.id, f]))

    zip.file(`sql-scripts/${collSlug}/_collection.json`, json(collection))
    zip.file(`sql-scripts/${collSlug}/_tree.json`, json(files.map(({ content: _, ...meta }) => meta)))

    for (const f of files) {
      if (f.type === 'file' && f.content != null) {
        zip.file(`sql-scripts/${collSlug}/${buildTreePath(f, byId)}`, f.content)
      }
    }
  }

  // --- etl/ ---
  const etlPipelines = await storage.etlPipelines.getByWorkspace(workspaceId)
  for (const pipeline of etlPipelines) {
    const pSlug = slugify(pipeline.name || pipeline.id)
    const files = await storage.etlFiles.getByPipeline(pipeline.id)
    const byId = new Map(files.map(f => [f.id, f]))

    zip.file(`etl/${pSlug}/_pipeline.json`, json(pipeline))
    zip.file(`etl/${pSlug}/_tree.json`, json(files.map(({ content: _, ...meta }) => meta)))

    for (const f of files) {
      if (f.type === 'file' && f.content != null) {
        zip.file(`etl/${pSlug}/${buildTreePath(f, byId)}`, f.content)
      }
    }
  }

  // --- dq/ ---
  const dqRuleSets = await storage.dqRuleSets.getByWorkspace(workspaceId)
  for (const rs of dqRuleSets) {
    const checks = await storage.dqCustomChecks.getByRuleSet(rs.id)
    zip.file(`dq/${slugify(rs.name || rs.id)}.json`, json({ ruleSet: rs, checks }))
  }

  // --- concept-sets/ ---
  const conceptSets = await storage.conceptSets.getByWorkspace(workspaceId)
  for (const cs of conceptSets) {
    zip.file(`concept-sets/${slugify(cs.name || cs.id)}.json`, json(cs))
  }

  // --- mapping-projects/ ---
  const mappingProjects = await storage.mappingProjects.getByWorkspace(workspaceId)
  for (const mp of mappingProjects) {
    const mpSlug = slugify(mp.name || mp.id)
    const mappings = await storage.conceptMappings.getByProject(mp.id)
    zip.file(`mapping-projects/${mpSlug}/_project.json`, json(mp))
    zip.file(`mapping-projects/${mpSlug}/mappings.json`, json(mappings))
  }

  // --- catalogs/ ---
  const catalogs = await storage.dataCatalogs.getByWorkspace(workspaceId)
  for (const cat of catalogs) {
    zip.file(`catalogs/${slugify(cat.name || cat.id)}.json`, json(cat))
  }

  // --- service-mappings/ ---
  const serviceMappings = await storage.serviceMappings.getByWorkspace(workspaceId)
  for (const sm of serviceMappings) {
    zip.file(`service-mappings/${slugify(sm.name || sm.id)}.json`, json(sm))
  }

  // --- plugins/ ---
  const plugins = await storage.userPlugins.getByWorkspace(workspaceId)
  for (const plugin of plugins) {
    const pSlug = slugify(plugin.id)
    zip.file(`plugins/${pSlug}/_plugin.json`, json({ id: plugin.id, workspaceId: plugin.workspaceId, createdAt: plugin.createdAt, updatedAt: plugin.updatedAt }))
    for (const [filename, content] of Object.entries(plugin.files)) {
      zip.file(`plugins/${pSlug}/${filename}`, content)
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  return { blob, workspaceName: resolveWorkspaceName(workspace) }
}

// ---------------------------------------------------------------------------
// Parse workspace ZIP
// ---------------------------------------------------------------------------

export interface ParsedWorkspaceZip {
  workspace: Workspace & { appVersion?: string }
  projects: Map<string, ParsedProjectZip>
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
  const zipData = await JSZip.loadAsync(file)

  // --- workspace.json ---
  const wsFile = zipData.files['workspace.json']
  if (!wsFile) return null
  const workspace = JSON.parse(await wsFile.async('string')) as Workspace & { appVersion?: string }
  if (!workspace?.id) return null

  // --- projects/ (rebuild each project sub-folder and parse with parseProjectZip) ---
  const projects = new Map<string, ParsedProjectZip>()
  const projectFolders = new Set<string>()
  for (const path of Object.keys(zipData.files)) {
    if (!path.startsWith('projects/')) continue
    const parts = path.split('/')
    if (parts.length >= 2 && parts[1]) projectFolders.add(parts[1])
  }
  for (const folder of projectFolders) {
    const prefix = `projects/${folder}/`
    const projectZip = new JSZip()
    for (const [path, entry] of Object.entries(zipData.files)) {
      if (!path.startsWith(prefix) || entry.dir) continue
      projectZip.file(path.slice(prefix.length), await entry.async('arraybuffer'))
    }
    const blob = await projectZip.generateAsync({ type: 'blob' })
    const parsed = await parseProjectZip(new File([blob], `${folder}.zip`))
    if (parsed) projects.set(folder, parsed)
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

  // --- dq/ ---
  const dqRuleSets: ParsedWorkspaceZip['dqRuleSets'] = []
  for (const [path, entry] of Object.entries(zipData.files)) {
    if (!path.startsWith('dq/') || !path.endsWith('.json') || entry.dir) continue
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
    const project = await readJsonFile<MappingProject>(zipData, `${prefix}_project.json`)
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
    workspace, projects, wikiPages, wikiAttachmentsMeta, wikiAttachmentBlobs,
    sqlCollections, etlPipelines, dqRuleSets, conceptSets,
    mappingProjects, catalogs, serviceMappings, plugins,
  }
}
