/**
 * Shared utilities for entity export/import (ZIP and JSON).
 */
import JSZip from 'jszip'
import type { Storage } from '@/lib/storage'
import { APP_VERSION } from '@/lib/version'
import { deterministicId } from '@/lib/deterministic-id'
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
  LocalizedString, TodoItem,
  Organization, OrganizationInfo,
} from '@/types'
import { localized, toLocalized } from '@/lib/localized'
import { buildMappingProjectFolder, restoreFileSourceDataFromCsv } from '@/lib/concept-mapping/export'
import { isServerMode } from '@/lib/api-client'
import { importDatasetOnServer } from '@/lib/api/datasets'

/**
 * Write a project/workspace README as `README.md` (English or first language)
 * plus `README.<lang>.md` siblings, so it round-trips per language while
 * staying git/portal-readable. Accepts legacy plain strings.
 */
function writeReadmeFiles(
  zip: JSZip,
  dir: string,
  readme: LocalizedString | string | null | undefined,
): void {
  if (!readme) return
  const byLang = toLocalized(readme)
  const langs = Object.keys(byLang).filter((l) => byLang[l])
  if (langs.length === 0) return
  const primary = langs.includes('en') ? 'en' : langs[0]
  for (const lang of langs) {
    const suffix = lang === primary ? '' : `.${lang}`
    zip.file(`${dir}README${suffix}.md`, byLang[lang])
  }
}

/** Coerce imported todos: legacy string `text` becomes a LocalizedString. */
function normalizeImportedTodos(todos: unknown): TodoItem[] {
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

// Source-concept-id compact format helpers live in source-concept-ids-io (shared
// with the per-project export/import, kept out of this module to avoid a cycle).
import type { CompactSourceConceptIdEntries } from '@/lib/concept-mapping/source-concept-ids-io'
export type { CompactSourceConceptIdEntries }
import {
  toCompactEntries,
  parseSourceConceptIdEntries,
} from '@/lib/concept-mapping/source-concept-ids-io'
export { parseSourceConceptIdEntries }

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
  // Called before an import to wipe any stale data for the target uid. In server
  // mode the sub-entity routes 404 ("Project not found") when the project doesn't
  // exist yet — expected here, so every read and delete tolerates failure instead
  // of aborting the import.
  const safe = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback)

  await storage.ideFiles.deleteByProject(uid).catch(() => {})
  await storage.connections.deleteByProject(uid).catch(() => {})
  await storage.readmeAttachments.deleteByProject(uid).catch(() => {})

  // Dataset files, data, raw files, analyses
  const datasetFiles = await safe(storage.datasetFiles.getByProject(uid), [])
  for (const df of datasetFiles) {
    if (df.type === 'file') {
      await storage.datasetData.delete(df.id).catch(() => {})
      await storage.datasetRawFiles.delete(df.id).catch(() => {})
      await storage.datasetAnalyses.deleteByDataset(df.id).catch(() => {})
    }
  }
  await storage.datasetFiles.deleteByProject(uid).catch(() => {})

  // Dashboards (+ tabs + widgets)
  const dashboards = await safe(storage.dashboards.getByProject(uid), [])
  for (const d of dashboards) {
    const tabs = await safe(storage.dashboardTabs.getByDashboard(d.id), [])
    for (const tab of tabs) await storage.dashboardWidgets.deleteByTab(tab.id).catch(() => {})
    await storage.dashboardTabs.deleteByDashboard(d.id).catch(() => {})
    await storage.dashboards.delete(d.id).catch(() => {})
  }

  // Pipelines & cohorts
  const pipelines = await safe(storage.pipelines.getByProject(uid), [])
  for (const pl of pipelines) await storage.pipelines.delete(pl.id).catch(() => {})
  const cohorts = await safe(storage.cohorts.getByProject(uid), [])
  for (const c of cohorts) await storage.cohorts.delete(c.id).catch(() => {})
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

/**
 * Read a single entry from an import ZIP as raw bytes (root-folder-aware, like
 * parseImportZip). Binary payloads (e.g. similarity-scores.parquet) must be read
 * this way — parseImportZip decodes every entry as UTF-8 text, which corrupts
 * binary content. Returns null when the entry is absent or empty.
 */
export async function readBinaryFromImportZip(
  file: File,
  path: string,
): Promise<Uint8Array | null> {
  let zip = await JSZip.loadAsync(file)
  zip = stripRootFolder(zip)
  const entry = zip.files[path]
  if (!entry || entry.dir) return null
  const buf = await entry.async('uint8array')
  return buf.byteLength > 0 ? buf : null
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

// Fields that are specific to the exporting instance/deployment, not portable
// project content: the owning user, the workspace placement, the git link
// (never commit a repo's own remote/token into itself), catalog/org metadata,
// and local timestamps. Stripped from every exported entity metadata so a
// round-trip export→import→export is stable across instances.
//
// NB: createdBy / createdByDetails are deliberately NOT stripped — they are the
// original author's display snapshot and must survive a cross-instance import so
// the importer isn't credited as the creator. createdById IS stripped, because a
// local user id is meaningless in another instance (the importing backend
// re-resolves it by ORCID/email, falling back to NULL + the snapshot).
const INSTANCE_FIELDS = [
  'ownerId',
  'createdById',
  'origin',
  'workspaceId',
  'gitRemoteConfig',
  'gitUrl',
  'catalogVisibility',
  'organization',
  'organizationId',
  'createdAt',
  'updatedAt',
] as const

/** Return a copy of an entity's metadata without instance-specific fields.
 *  Accepts any object (interfaces without an index signature included). */
export function stripInstanceFields<T extends object>(meta: T): Partial<T> {
  const out: Partial<T> = { ...meta }
  for (const f of INSTANCE_FIELDS) delete (out as Record<string, unknown>)[f]
  return out
}

/**
 * Drop a createdById carried by an imported record: it's a foreign instance's
 * local user id and must never be persisted. The author snapshot
 * (createdBy/createdByDetails) is kept, so the record still shows the original
 * author; in server mode the backend re-resolves a local id by ORCID/email.
 */
export function dropForeignAuthorId<T extends object>(rec: T): T {
  return 'createdById' in rec ? { ...rec, createdById: undefined } : rec
}

/**
 * Serialize dataset rows to CSV. Rows are keyed by column id (as stored/exported);
 * the header uses column NAMES so a re-parse (front or server) recovers the real columns.
 */
export function datasetToCsv(df: DatasetFile, rows: Record<string, unknown>[]): string {
  const colIds = df.columns?.map(c => c.id) ?? (rows[0] ? Object.keys(rows[0]) : [])
  const colNames = df.columns?.map(c => c.name) ?? colIds
  const escape = (v: unknown): string => {
    if (v == null) return ''
    const s = String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [
    colNames.join(','),
    ...rows.map(row => colIds.map(id => escape(row[id])).join(',')),
  ].join('\n')
}

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

  // --- project.json (without readme/todos/notes — those go in separate files —
  // nor instance-specific fields like ownerId/workspaceId/gitRemoteConfig) ---
  const { readme: _r, todos: _t, notes: _n, ...projectMeta } = project
  zip.file('project.json', json({ ...stripInstanceFields(projectMeta), appVersion: APP_VERSION }))

  // --- README.md (+ README.<lang>.md per extra language) ---
  writeReadmeFiles(zip, '', project.readme)

  // --- tasks.json ---
  const notes = toLocalized(project.notes)
  const hasNotes = Object.values(notes).some(Boolean)
  if ((project.todos && project.todos.length > 0) || hasNotes) {
    zip.file('tasks.json', json({ todos: project.todos ?? [], notes }))
  }

  // --- IDE files (under scripts/ in ZIP) ---
  // In server mode the disk-backed tree exposes a synthetic "scripts" root folder
  // (parentId null, id = hash of ""), a UI convenience that isn't repo content.
  // Drop it, and reparent its direct children to null, so scripts/_tree.json
  // matches a git-authored tree (no phantom root node / dangling parentId).
  const rawIdeFiles = await storage.ideFiles.getByProject(projectUid)
  const syntheticRoot = rawIdeFiles.find((f) => f.parentId == null && f.type === 'folder' && f.name === 'scripts')
  const ideFiles = rawIdeFiles
    .filter((f) => f !== syntheticRoot)
    .map((f) => (syntheticRoot && f.parentId === syntheticRoot.id ? { ...f, parentId: null } : f))
  if (ideFiles.length > 0) {
    const byId = new Map(ideFiles.map(f => [f.id, f]))
    zip.file('scripts/_tree.json', json(ideFiles.map(({ content: _, ...meta }) => meta)))
    for (const f of ideFiles) {
      if (f.type === 'file' && f.content != null) {
        zip.file(buildIdePath(f, byId), f.content)
      }
    }
  }

  // Sub-entities carry the same instance-specific noise (timestamps, createdBy,
  // origin) that the backend regenerates on import and never reads back — strip
  // it so re-exporting an imported project is stable.
  // --- pipeline/ ---
  const pipelines = await storage.pipelines.getByProject(projectUid)
  if (pipelines.length > 0) {
    zip.file('pipeline/pipeline.json', json(pipelines.map(stripInstanceFields)))
  }

  // --- cohorts/ ---
  const cohorts = await storage.cohorts.getByProject(projectUid)
  for (const c of cohorts) {
    zip.file(`cohorts/${slugify(c.name || c.id)}.json`, json(stripInstanceFields(c)))
  }

  // --- databases/ (IDE connections) ---
  const connections = await storage.connections.getByProject(projectUid)
  for (const c of connections) {
    zip.file(`databases/${slugify(c.name || c.id)}.json`, json(stripInstanceFields(c)))
  }

  // --- dashboards/ (each dashboard = dashboard + tabs + widgets in one file) ---
  const dashboards = await storage.dashboards.getByProject(projectUid)
  for (const d of dashboards) {
    const tabs = await storage.dashboardTabs.getByDashboard(d.id)
    const widgets: DashboardWidget[] = []
    for (const tab of tabs) {
      widgets.push(...(await storage.dashboardWidgets.getByTab(tab.id)))
    }
    zip.file(
      `dashboards/${slugify(localized(d.name, 'en') || d.id)}.json`,
      json({ dashboard: stripInstanceFields(d), tabs: tabs.map(stripInstanceFields), widgets: widgets.map(stripInstanceFields) }),
    )
  }

  // --- datasets/ (tree + analyses + optional data CSV) ---
  const datasetFiles = await storage.datasetFiles.getByProject(projectUid)
  if (datasetFiles.length > 0) {
    const byId = new Map(datasetFiles.map(f => [f.id, f]))
    zip.file('datasets/_tree.json', json(datasetFiles.map(stripInstanceFields)))

    for (const df of datasetFiles) {
      if (df.type !== 'file') continue
      const dsPath = buildDatasetPath(df, byId)
      const folderName = dsPath.replace(/\.[^.]+$/, '')

      if (df.columns && df.columns.length > 0) {
        zip.file(`datasets/${folderName}/_columns.json`, json(df.columns))
      }

      const analyses = await storage.datasetAnalyses.getByDataset(df.id)
      for (const a of analyses) {
        zip.file(`datasets/${folderName}/${slugify(a.name || a.id)}.json`, json(stripInstanceFields(a)))
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
          const baseName = (dsPath.split('/').pop() ?? df.name).replace(/\.[^.]+$/, '')
          zip.file(`datasets/${folderName}/${baseName}.csv`, datasetToCsv(df, data.rows))
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

  // --- organization.json (inherited from the parent workspace) ---
  // The project has no org link of its own; it belongs to whatever org its
  // workspace is attached to. workspaceId is stripped from project.json (instance
  // field) but still present on the in-memory record, so we resolve it here.
  await attachEntityOrganization(zip, 'project.json', project, storage)

  const blob = await zip.generateAsync({ type: 'blob' })
  return { blob, projectName: resolveProjectName(project) }
}

// ---------------------------------------------------------------------------
// Parse project ZIP — supports both new structured layout and legacy flat layout
// ---------------------------------------------------------------------------

export interface ParsedProjectZip {
  project: Project
  /** Organization inherited from the parent workspace, bundled by UUID for cross-instance upsert. */
  organization?: Organization
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
 * Import a project's dataset tree, returning a map from each ZIP dataset id to its
 * FINAL id in storage.
 *
 * Front-only (IndexedDB): datasets are UUID-keyed rows — create the file, then save its
 * parsed rows and raw blob; the final id is the remapped UUID (via mapId).
 *
 * Server mode: datasets are disk-source-of-truth (projects/<uid>/datasets/<path>) and the
 * generic storage adapters no-op for dataset files. Each file is uploaded through the real
 * server import (importDatasetOnServer), which lands the raw file, parses it into Parquet,
 * and returns a node whose id is the on-disk path — that path becomes the final id. When a
 * raw file is absent (data-only export), a CSV is synthesized from the parsed rows so the
 * dataset still lands on the server.
 */
async function importDatasets(
  parsed: ParsedProjectZip,
  projectUid: string,
  storage: Storage,
  mapId: (oldId: string) => string,
): Promise<{ datasetIdMap: Map<string, string>; colIdMap: Map<string, string> }> {
  const datasetIdMap = new Map<string, string>()
  // ZIP column id → final column id. Only populated in server mode, where re-parsing the
  // raw file regenerates column ids: widgets/analyses that store col ids in their config
  // (plugin xColumn/yColumn/column/uniquePer/…) must be relinked to survive the import.
  const colIdMap = new Map<string, string>()
  const byId = new Map(parsed.datasetFiles.map(f => [f.id, f]))

  if (!isServerMode()) {
    for (const df of parsed.datasetFiles) {
      await storage.datasetFiles.create({ ...df, id: mapId(df.id), projectUid, parentId: df.parentId ? mapId(df.parentId) : null })
      datasetIdMap.set(df.id, mapId(df.id))
    }
    for (const dd of parsed.datasetData) {
      await storage.datasetData.save({ datasetFileId: mapId(dd.datasetFileId), rows: dd.rows })
    }
    for (const rf of parsed.datasetRawFiles ?? []) {
      await storage.datasetRawFiles.save({ datasetFileId: mapId(rf.datasetFileId), blob: rf.blob, fileName: rf.fileName })
    }
    return { datasetIdMap, colIdMap }
  }

  // Server mode: create folders top-down (a child's path needs its parent to exist first),
  // then import each file at its real path.
  const rawByDataset = new Map((parsed.datasetRawFiles ?? []).map(rf => [rf.datasetFileId, rf]))
  const dataByDataset = new Map(parsed.datasetData.map(dd => [dd.datasetFileId, dd]))
  const folders = parsed.datasetFiles.filter(f => f.type === 'folder')
  const files = parsed.datasetFiles.filter(f => f.type === 'file')

  // Parent-before-child ordering by tree depth so folder paths resolve.
  const depth = (f: DatasetFile): number => {
    let d = 0, cur: DatasetFile | undefined = f
    while (cur?.parentId) { cur = byId.get(cur.parentId); d++ }
    return d
  }
  for (const folder of [...folders].sort((a, b) => depth(a) - depth(b))) {
    const path = buildDatasetPath(folder, byId)
    datasetIdMap.set(folder.id, path)
    await storage.datasetFiles.create({ ...folder, id: path, projectUid, parentId: folder.parentId ? (datasetIdMap.get(folder.parentId) ?? null) : null })
  }

  for (const df of files) {
    const raw = rawByDataset.get(df.id)
    const data = dataByDataset.get(df.id)
    let blob: Blob | undefined = raw?.blob
    let fileName = raw?.fileName ?? df.name
    if (!blob && data?.rows?.length) {
      blob = new Blob([datasetToCsv(df, data.rows)], { type: 'text/csv' })
      fileName = df.name.match(/\.[^.]+$/) ? df.name.replace(/\.[^.]+$/, '.csv') : `${df.name}.csv`
    }
    if (!blob) continue // nothing to upload (empty dataset)

    const parentPath = df.parentId ? (datasetIdMap.get(df.parentId) ?? null) : null
    const node = await importDatasetOnServer({ projectUid, name: df.name, parentId: parentPath, file: blob, fileName })
    datasetIdMap.set(df.id, node.id)

    // Map the ZIP's column ids to the server's freshly-parsed ones. Names and order are
    // preserved by the parser, so match by index, falling back to name.
    const zipCols = df.columns ?? []
    const srvCols = node.columns ?? []
    const srvByName = new Map(srvCols.map(c => [c.name, c.id]))
    zipCols.forEach((zc, i) => {
      const srvId = srvCols[i]?.name === zc.name ? srvCols[i].id : srvByName.get(zc.name)
      if (srvId) colIdMap.set(zc.id, srvId)
    })
  }

  return { datasetIdMap, colIdMap }
}

/**
 * Deep-rewrite column ids inside an arbitrary widget/analysis config value. Plugin configs
 * store column ids as free-form strings (scalars like `column`, arrays like `popupColumns`),
 * so every string is passed through the map; non-matching strings are returned unchanged.
 */
function remapColIds<T>(value: T, colIdMap: Map<string, string>): T {
  if (colIdMap.size === 0) return value
  if (typeof value === 'string') return (colIdMap.get(value) ?? value) as T
  if (Array.isArray(value)) return value.map(v => remapColIds(v, colIdMap)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = remapColIds(v, colIdMap)
    return out as T
  }
  return value
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
  // Derive each new id deterministically from (projectUid + originalId) instead
  // of a random UUID, so re-importing the same project yields the same ids and a
  // git export→import→export round-trip is stable — while ids from a different
  // project still differ (projectUid is in the hash), avoiding PK collisions.
  const idMap = new Map<string, string>()
  const mapId = (oldId: string): string => {
    if (!idMap.has(oldId)) idMap.set(oldId, deterministicId(projectUid, oldId))
    return idMap.get(oldId)!
  }

  // Datasets must be imported before dashboards/widgets so their final ids are known
  // when we remap `datasetFileId` references. In server mode a dataset's id is its
  // on-disk path (not a UUID), so widgets/analyses/filters resolve through datasetIdMap
  // instead of the generic mapId. resolveDatasetId falls back to mapId for the front-only
  // path, where dataset ids are remapped UUIDs like every other entity.
  const { datasetIdMap, colIdMap } = await importDatasets(parsed, projectUid, storage, mapId)
  const resolveDatasetId = (oldId: string): string => datasetIdMap.get(oldId) ?? mapId(oldId)

  for (const f of parsed.ideFiles) {
    await storage.ideFiles.create({ ...f, id: mapId(f.id), projectUid, parentId: f.parentId ? mapId(f.parentId) : null })
  }
  for (const p of parsed.pipelines) {
    await storage.pipelines.create(dropForeignAuthorId({ ...p, id: mapId(p.id), projectUid }))
  }
  for (const c of parsed.cohorts) {
    await storage.cohorts.create(dropForeignAuthorId({ ...c, id: mapId(c.id), projectUid }))
  }
  for (const c of parsed.connections) {
    await storage.connections.create({ ...c, id: mapId(c.id), projectUid })
  }
  for (const d of parsed.dashboards) {
    const filterConfig = (d.filterConfig ?? []).map(f => ({
      ...f,
      id: mapId(f.id),
      datasetFileId: resolveDatasetId(f.datasetFileId),
      // In server mode the CSV is re-parsed on import and columns get fresh ids, so the
      // filter's stored columnId must be remapped like widgets' config colIds — otherwise
      // it points at a column the server no longer knows and the filter can't resolve its
      // values (front-only: colIdMap is empty, so this is a no-op).
      columnId: colIdMap.get(f.columnId) ?? f.columnId,
      ...(f.scope?.type === 'tabs' ? { scope: { ...f.scope, tabIds: f.scope.tabIds.map(mapId) } } : {}),
      ...(f.scope?.type === 'widgets' ? { scope: { ...f.scope, widgetIds: f.scope.widgetIds.map(mapId) } } : {}),
    }))
    await storage.dashboards.create(dropForeignAuthorId({
      ...d,
      id: mapId(d.id),
      projectUid,
      filterConfig,
      defaultDatasetFileId: d.defaultDatasetFileId ? resolveDatasetId(d.defaultDatasetFileId) : d.defaultDatasetFileId,
    }))
  }
  for (const tab of parsed.dashboardTabs) {
    await storage.dashboardTabs.create({ ...tab, id: mapId(tab.id), dashboardId: mapId(tab.dashboardId), parentTabId: tab.parentTabId ? mapId(tab.parentTabId) : (tab.parentTabId ?? null) })
  }
  for (const w of parsed.dashboardWidgets) {
    await storage.dashboardWidgets.create({
      ...w,
      id: mapId(w.id),
      tabId: mapId(w.tabId),
      datasetFileId: w.datasetFileId ? resolveDatasetId(w.datasetFileId) : w.datasetFileId,
      source: remapColIds(w.source, colIdMap),
    })
  }
  for (const a of parsed.datasetAnalyses) {
    await storage.datasetAnalyses.create({
      ...a,
      id: mapId(a.id),
      datasetFileId: resolveDatasetId(a.datasetFileId),
      config: remapColIds(a.config, colIdMap),
    })
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

  // Organization provenance snapshot: for a standalone project ZIP it's inlined
  // on project.json (project.organization). A legacy root organization.json is
  // still honored as a fallback. The snapshot stays on projectMeta so it's kept
  // as immutable provenance on the imported record (like createdByDetails) — it
  // is NOT re-linked to a local org entity.
  if (!projectMeta.organization) {
    const orgFile = zipData.files['organization.json']
    if (orgFile) projectMeta.organization = JSON.parse(await orgFile.async('string')) as Organization
  }
  const organization = projectMeta.organization as Organization | undefined

  // Reconstruct readme (README.md = en, README.<lang>.md = other langs), todos, notes
  const readmeByLang: LocalizedString = {}
  for (const [path, file] of Object.entries(zipData.files)) {
    const m = /^README(?:\.([a-z]{2}))?\.md$/.exec(path)
    if (!m) continue
    readmeByLang[m[1] ?? 'en'] = await file.async('string')
  }
  if (Object.keys(readmeByLang).length > 0) {
    projectMeta.readme = readmeByLang
  }
  const tasksFile = zipData.files['tasks.json']
  if (tasksFile) {
    const tasks = JSON.parse(await tasksFile.async('string'))
    projectMeta.todos = normalizeImportedTodos(tasks.todos)
    projectMeta.notes = toLocalized(tasks.notes)
  }

  const parsed = (hasNewLayout || !hasLegacyLayout)
    ? await parseNewLayout(zipData, projectMeta)
    : await parseLegacyLayout(zipData, projectMeta)
  return { ...parsed, organization }
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
  type: 'project' | 'mapping-project' | 'sql-collection' | 'etl-pipeline' | 'data-catalog' | 'dq-rule-set' | 'schema-preset'
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
  // Strip instance-specific fields (workspaceId, gitRemoteConfig, …) so the
  // versioned tree round-trips idempotently — import reassigns them anyway.
  zip.file(`${prefix}_collection.json`, json(stripInstanceFields(collection)))
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
 * Build a ZIP blob for a SQL script collection's versioned tree (root layout),
 * used by the git sync panel. Mirrors buildMappingProjectZip: content at the
 * root + a .gitattributes derived from the automatic LFS rule and any per-file
 * overrides. SQL scripts are text, so LFS rarely triggers, but keeping the same
 * shape means the sync panel's per-file LFS control works uniformly.
 */
/** Write the .gitattributes (auto LFS rule + overrides) from the ZIP's own entry
 *  sizes, then emit the blob — shared tail of every single-entity git zip. */
/**
 * Resolve the organization a standalone entity inherits from its parent
 * workspace: a SQL collection / ETL pipeline / mapping project / DQ rule set /
 * catalog / project has no org link of its own — its org is the one managed at
 * the workspace level (workspaceId → workspace.organizationId → the full record).
 * Returns undefined when the entity has no workspace or the workspace no org.
 */
async function resolveEntityOrganization(
  entity: { workspaceId?: string },
  storage: Storage,
): Promise<Organization | undefined> {
  if (!entity.workspaceId) return undefined
  const workspace = await storage.workspaces.getById(entity.workspaceId)
  if (!workspace?.organizationId) return undefined
  return storage.organizations.getById(workspace.organizationId)
}

/**
 * Inline the inherited organization as an `organization` field on a standalone
 * entity's already-written metadata JSON inside the ZIP. Used for single-entity
 * exports (one project / mapping project / collection per ZIP): there's exactly
 * one org, so embedding the full record keeps the file self-sufficient and
 * human-readable without a sidecar. (A multi-entity workspace ZIP instead
 * factors the org into one root organization.json — see buildWorkspaceZip — to
 * avoid repeating it across every entity.) The record carries the org's stable
 * UUID, so import upserts by id whether it comes from inline or the sidecar.
 * No-op when there's no org to attach or the meta entry is missing.
 */
export async function attachEntityOrganization(
  zip: JSZip,
  metaPath: string,
  entity: { workspaceId?: string; organization?: OrganizationInfo | null },
  storage: Storage,
): Promise<void> {
  // Prefer the entity's own frozen provenance snapshot (e.g. set by the author
  // editor or carried over from a prior import) so a re-export keeps the origin
  // organization. Only fall back to resolving from the parent workspace when the
  // entity has no snapshot of its own — the first export inherits it that way.
  const org = entity.organization ?? await resolveEntityOrganization(entity, storage)
  const entry = zip.files[metaPath]
  if (!org || !entry) return
  const meta = JSON.parse(await entry.async('string'))
  meta.organization = org
  zip.file(metaPath, json(meta))
}

async function finalizeEntityZip(zip: JSZip, lfsOverrides?: Map<string, boolean>): Promise<Blob> {
  const { resolveLfsPaths, buildGitAttributes } = await import('@/lib/git-lfs')
  const entries = await Promise.all(
    Object.values(zip.files)
      .filter((f) => !f.dir)
      .map(async (f) => ({ path: f.name, size: (await f.async('uint8array')).byteLength })),
  )
  const attrs = buildGitAttributes(resolveLfsPaths(entries, lfsOverrides ?? new Map()))
  if (attrs) zip.file('.gitattributes', attrs)
  return zip.generateAsync({ type: 'blob' })
}

export async function buildSqlCollectionZip(
  collectionId: string,
  storage: Storage,
  options: { lfsOverrides?: Map<string, boolean> } = {},
): Promise<{ blob: Blob; name: string } | null> {
  const collection = await storage.sqlScriptCollections.getById(collectionId)
  if (!collection) return null
  const zip = new JSZip()
  await buildSqlCollectionFolder(zip, '', collection, storage)
  await attachEntityOrganization(zip, '_collection.json', collection, storage)
  const blob = await finalizeEntityZip(zip, options.lfsOverrides)
  return { blob, name: localized(collection.name, 'en') || collection.id }
}

export async function buildEtlPipelineZip(
  pipelineId: string,
  storage: Storage,
  options: { lfsOverrides?: Map<string, boolean> } = {},
): Promise<{ blob: Blob; name: string } | null> {
  const pipeline = await storage.etlPipelines.getById(pipelineId)
  if (!pipeline) return null
  const zip = new JSZip()
  await buildEtlPipelineFolder(zip, '', pipeline, storage)
  await attachEntityOrganization(zip, '_pipeline.json', pipeline, storage)
  const blob = await finalizeEntityZip(zip, options.lfsOverrides)
  return { blob, name: localized(pipeline.name, 'en') || pipeline.id }
}

/** Folder layout for one data catalog's git repo: just its config (stripped).
 *  Service mappings are workspace-level siblings, not owned by a single catalog,
 *  so they are not part of the catalog's own repo. */
export async function buildDataCatalogFolder(
  zip: JSZip,
  prefix: string,
  catalog: DataCatalog,
): Promise<void> {
  zip.file(`${prefix}catalog.json`, json(stripInstanceFields(catalog)))
}

export async function buildDataCatalogZip(
  catalogId: string,
  storage: Storage,
  options: { lfsOverrides?: Map<string, boolean> } = {},
): Promise<{ blob: Blob; name: string } | null> {
  const catalog = await storage.dataCatalogs.getById(catalogId)
  if (!catalog) return null
  const zip = new JSZip()
  await buildDataCatalogFolder(zip, '', catalog)
  await attachEntityOrganization(zip, 'catalog.json', catalog, storage)
  const blob = await finalizeEntityZip(zip, options.lfsOverrides)
  return { blob, name: localized(catalog.name, 'en') || catalog.id }
}

/** Folder layout for one DQ rule set's git repo: the rule set (stripped) plus its
 *  custom checks (they belong to the rule set, not the workspace). */
export async function buildDqRuleSetFolder(
  zip: JSZip,
  prefix: string,
  ruleSet: DqRuleSet,
  storage: Storage,
): Promise<void> {
  zip.file(`${prefix}rule-set.json`, json(stripInstanceFields(ruleSet)))
  const checks = await storage.dqCustomChecks.getByRuleSet(ruleSet.id)
  if (checks.length > 0) zip.file(`${prefix}checks.json`, json(checks))
}

export async function buildDqRuleSetZip(
  ruleSetId: string,
  storage: Storage,
  options: { lfsOverrides?: Map<string, boolean> } = {},
): Promise<{ blob: Blob; name: string } | null> {
  const ruleSet = await storage.dqRuleSets.getById(ruleSetId)
  if (!ruleSet) return null
  const zip = new JSZip()
  await buildDqRuleSetFolder(zip, '', ruleSet, storage)
  await attachEntityOrganization(zip, 'rule-set.json', ruleSet, storage)
  const blob = await finalizeEntityZip(zip, options.lfsOverrides)
  return { blob, name: localized(ruleSet.name, 'en') || ruleSet.id }
}

/** Folder layout for one schema preset's git repo: its mapping config (stripped).
 *  Keyed on presetId (its primary key), not id. */
export async function buildSchemaPresetFolder(
  zip: JSZip,
  prefix: string,
  preset: CustomSchemaPreset,
): Promise<void> {
  zip.file(`${prefix}preset.json`, json(stripInstanceFields(preset)))
}

export async function buildSchemaPresetZip(
  presetId: string,
  storage: Storage,
  options: { lfsOverrides?: Map<string, boolean> } = {},
): Promise<{ blob: Blob; name: string } | null> {
  const preset = await storage.schemaPresets.getById(presetId)
  if (!preset) return null
  const zip = new JSZip()
  await buildSchemaPresetFolder(zip, '', preset)
  const blob = await finalizeEntityZip(zip, options.lfsOverrides)
  return { blob, name: preset.presetId }
}

/** Folder layout for one user plugin's git repo: a metadata pointer plus each
 *  source file (filename → code) at the root, mirroring the workspace export. */
export async function buildUserPluginFolder(
  zip: JSZip,
  prefix: string,
  plugin: UserPlugin,
): Promise<void> {
  zip.file(`${prefix}_plugin.json`, json({ id: plugin.id, entityId: plugin.entityId }))
  for (const [filename, content] of Object.entries(plugin.files)) {
    zip.file(`${prefix}${filename}`, content)
  }
}

export async function buildUserPluginZip(
  pluginId: string,
  storage: Storage,
  options: { lfsOverrides?: Map<string, boolean> } = {},
): Promise<{ blob: Blob; name: string } | null> {
  const plugin = await storage.userPlugins.getById(pluginId)
  if (!plugin) return null
  const zip = new JSZip()
  await buildUserPluginFolder(zip, '', plugin)
  const blob = await finalizeEntityZip(zip, options.lfsOverrides)
  return { blob, name: plugin.entityId || plugin.id }
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
      const rec: Record<string, unknown> = dropForeignAuthorId({ ...f, [fkKey]: targetId })
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

  // data-catalog / dq-rule-set / schema-preset repos hold the entity's full
  // metadata (and, for DQ, its checks) at the repo root. The record was created
  // at import from the workspace marker; the clone re-applies the repo's content.
  if (type === 'data-catalog') {
    const catalog = await readJson<DataCatalog>('catalog.json')
    if (!catalog) return false
    const { id: _id, workspaceId: _ws, ...changes } = dropForeignAuthorId(catalog) as DataCatalog
    await storage.dataCatalogs.update(targetId, changes).catch(() => {})
    return true
  }

  if (type === 'dq-rule-set') {
    const ruleSet = await readJson<DqRuleSet>('rule-set.json')
    if (!ruleSet) return false
    const { id: _id, workspaceId: _ws, ...changes } = dropForeignAuthorId(ruleSet) as DqRuleSet
    await storage.dqRuleSets.update(targetId, changes).catch(() => {})
    const checks = (await readJson<DqCustomCheck[]>('checks.json')) ?? []
    await storage.dqCustomChecks.deleteByRuleSet(targetId).catch(() => {})
    for (const c of checks) {
      const { ruleSetId: _rs, ...rest } = c
      await storage.dqCustomChecks.create({ ...rest, ruleSetId: targetId } as DqCustomCheck).catch(() => {})
    }
    return true
  }

  if (type === 'schema-preset') {
    const preset = await readJson<CustomSchemaPreset>('preset.json')
    if (!preset) return false
    await storage.schemaPresets.save(dropForeignAuthorId({ ...preset, presetId: targetId }) as CustomSchemaPreset).catch(() => {})
    return true
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
  zip.file(`${prefix}_pipeline.json`, json(stripInstanceFields(pipeline)))
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

  // --- workspace.json (without instance-specific fields) ---
  // organizationId is stripped as an instance field, then re-added deliberately:
  // an organization's UUID is stable across instances (it's the catalog index),
  // so a workspace keeps pointing at the org it was exported with. The full org
  // record travels alongside in organization.json.
  const { readme: wsReadme, ...wsMeta } = workspace
  zip.file('workspace.json', json({
    ...stripInstanceFields(wsMeta),
    ...(workspace.organizationId ? { organizationId: workspace.organizationId } : {}),
    appVersion: APP_VERSION,
  }))

  // --- organization.json ---
  // The linked organization travels with the workspace so an import can
  // reconstitute it (upsert by UUID) without a shared org registry.
  if (workspace.organizationId) {
    const org = await storage.organizations.getById(workspace.organizationId)
    if (org) zip.file('organization.json', json(org))
  }

  // --- README.md (+ README.<lang>.md per extra language) ---
  writeReadmeFiles(zip, '', wsReadme)

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
      const { todos: _t, notes: _n, readme: _rd, ...projectMeta } = project
      // Strip instance fields, then re-add gitRemoteConfig deliberately: here it's
      // the git *pointer* the portal follows to clone the linked project's repo.
      const projectMetaOut = { ...stripInstanceFields(projectMeta), ...(git ? { gitRemoteConfig: git } : {}), appVersion: APP_VERSION }

      if (git) {
        // Metadata + git pointer only — content comes from the linked repo at portal build time.
        zip.file(`projects/${folder}/project.json`, json(projectMetaOut))
        writeReadmeFiles(zip, `projects/${folder}/`, project.readme)
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
        writeReadmeFiles(zip, `projects/${folder}/`, project.readme)
      }
    }
  }

  // Helper: prefer entityId, fallback to slugified name or id. Name may be a
  // LocalizedString; the slug is language-independent (resolve to en/first).
  const eid = (entity: { entityId?: string; name?: LocalizedString | string; id: string }) =>
    entity.entityId || slugify(localized(entity.name, 'en') || entity.id || 'unknown')

  // --- wiki/ ---
  if (on('wiki')) {
    const wikiPages = await storage.wikiPages.getByWorkspace(workspaceId)
    if (wikiPages.length > 0) {
      const treeMeta = wikiPages.map(({ content: _, ...meta }) => meta)
      zip.file('wiki/_tree.json', json(treeMeta))

      for (const page of wikiPages) {
        const pageFolder = page.entityId || `${slugify(localized(page.title, 'en') || page.id)}--${page.id}`
        // Content is multilingual: <folder>.md holds en/first, <folder>.<lang>.md the rest.
        const content = toLocalized(page.content)
        const langs = Object.keys(content).filter((l) => content[l])
        const primary = langs.includes('en') ? 'en' : langs[0]
        if (langs.length === 0) {
          zip.file(`wiki/${pageFolder}.md`, '')
        } else {
          for (const lang of langs) {
            const suffix = lang === primary ? '' : `.${lang}`
            zip.file(`wiki/${pageFolder}${suffix}.md`, content[lang])
          }
        }
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
      const git = resolveGitRemote(sp)
      if (git) {
        // Metadata + git pointer only: the preset lives in schemas/<folder>/_schema.json
        // and the portal build points the manifest at that marker.
        const folder = slugify(sp.presetId)
        zip.file(`schemas/${folder}/_schema.json`, json(sp))
        gitLinks.push({ type: 'schema-preset', id: sp.presetId, folder, url: git.url, branch: git.branch })
        continue
      }
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
      const git = resolveGitRemote(rs)
      if (git) {
        // Metadata + git pointer only: the { ruleSet, checks } bundle lives in
        // data-quality/<folder>/_ruleset.json (same shape as the flat form).
        const folder = eid(rs)
        zip.file(`data-quality/${folder}/_ruleset.json`, json({ ruleSet: rs, checks }))
        gitLinks.push({ type: 'dq-rule-set', id: rs.id, folder, url: git.url, branch: git.branch })
        continue
      }
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
      const git = resolveGitRemote(cat)
      if (git) {
        // Metadata + git pointer only: the DataCatalog lives in catalogs/<folder>/_catalog.json
        // and the portal build points the manifest at that marker.
        const folder = eid(cat)
        zip.file(`catalogs/${folder}/_catalog.json`, json(cat))
        gitLinks.push({ type: 'data-catalog', id: cat.id, folder, url: git.url, branch: git.branch })
        continue
      }
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
  readme?: LocalizedString
}

export interface ParsedWorkspaceZip {
  workspace: Workspace & { appVersion?: string }
  /** Organization the workspace is linked to, travelling by UUID for cross-instance upsert. */
  organization?: Organization
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
  mappingProjects: { project: MappingProject; mappings: ConceptMapping[]; scoresFile?: File }[]
  sourceConceptIdRanges: SourceConceptIdRange[]
  sourceConceptIdEntries: SourceConceptIdEntry[]
  catalogs: DataCatalog[]
  serviceMappings: ServiceMapping[]
  plugins: UserPlugin[]
}

/** A git-linked entity discovered in a parsed workspace ZIP (metadata only — content lives in its repo). */
export interface GitLinkedEntity {
  type: 'project' | 'mapping-project' | 'sql-collection' | 'etl-pipeline' | 'data-catalog' | 'dq-rule-set' | 'schema-preset'
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
  for (const { collection } of parsed.sqlCollections) push('sql-collection', collection.id, localized(collection.name, 'en'), resolveGitRemote(collection) ?? undefined)
  for (const { pipeline } of parsed.etlPipelines) push('etl-pipeline', pipeline.id, localized(pipeline.name, 'en'), resolveGitRemote(pipeline) ?? undefined)
  for (const { project } of parsed.mappingProjects) push('mapping-project', project.id, localized(project.name, 'en'), resolveGitRemote(project) ?? undefined)
  for (const cat of parsed.catalogs) push('data-catalog', cat.id, localized(cat.name, 'en'), resolveGitRemote(cat) ?? undefined)
  for (const { ruleSet } of parsed.dqRuleSets) push('dq-rule-set', ruleSet.id, localized(ruleSet.name, 'en'), resolveGitRemote(ruleSet) ?? undefined)
  for (const sp of parsed.schemas) push('schema-preset', sp.presetId, localized(sp.mapping?.presetLabel, 'en') || sp.presetId, resolveGitRemote(sp) ?? undefined)
  return out
}

export async function parseWorkspaceZip(file: File): Promise<ParsedWorkspaceZip | null> {
  const zipData = stripRootFolder(await JSZip.loadAsync(file))

  // --- workspace.json ---
  const wsFile = zipData.files['workspace.json']
  if (!wsFile) return null
  const workspace = JSON.parse(await wsFile.async('string')) as Workspace & { appVersion?: string }
  if (!workspace?.id) return null

  // --- organization.json (optional) ---
  const orgFile = zipData.files['organization.json']
  const organization = orgFile
    ? (JSON.parse(await orgFile.async('string')) as Organization)
    : undefined

  // --- README.md (README.md = en, README.<lang>.md = other langs) ---
  const wsReadmeByLang: LocalizedString = {}
  for (const [path, file] of Object.entries(zipData.files)) {
    const m = /^README(?:\.([a-z]{2}))?\.md$/.exec(path)
    if (!m) continue
    wsReadmeByLang[m[1] ?? 'en'] = await file.async('string')
  }
  if (Object.keys(wsReadmeByLang).length > 0) {
    workspace.readme = wsReadmeByLang
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
      const readmeByLang: LocalizedString = {}
      for (const [path, file] of Object.entries(zipData.files)) {
        const m = new RegExp(`^${prefix}README(?:\\.([a-z]{2}))?\\.md$`).exec(path)
        if (!m) continue
        readmeByLang[m[1] ?? 'en'] = await file.async('string')
      }
      const readme = Object.keys(readmeByLang).length > 0 ? readmeByLang : undefined
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
  const wikiTreeMeta = await readJsonFile<Omit<WikiPage, 'content'>[]>(zipData, 'wiki/_tree.json')
  if (wikiTreeMeta) {
    for (const meta of wikiTreeMeta) {
      // Content lives in wiki/<folder>.md (en/first) + wiki/<folder>.<lang>.md.
      // <folder> is either the page.entityId or "<slug>--<id>".
      const folder = meta.entityId
      const content: LocalizedString = {}
      for (const [path, entry] of Object.entries(zipData.files)) {
        if (entry.dir || !path.startsWith('wiki/') || !path.endsWith('.md')) continue
        const rel = path.slice('wiki/'.length, -'.md'.length)
        const langMatch = /\.([a-z]{2})$/.exec(rel)
        const lang = langMatch ? langMatch[1] : 'en'
        const base = langMatch ? rel.slice(0, -3) : rel
        const matches = folder ? base === folder : base.endsWith(`--${meta.id}`)
        if (matches) content[lang] = await entry.async('string')
      }
      wikiPages.push({ ...meta, content } as WikiPage)
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

    // Optional precomputed similarity scores (opt-in on export — may be absent)
    let scoresFile: File | undefined
    const scoresEntry = zipData.files[`${prefix}similarity-scores.parquet`]
    if (scoresEntry && !scoresEntry.dir) {
      const buf = await scoresEntry.async('uint8array')
      // TS lib.dom's BlobPart rejects the generic Uint8Array<ArrayBufferLike>; runtime accepts it
      if (buf.byteLength > 0) scoresFile = new File([buf as BlobPart], `${project.id}.parquet`, { type: 'application/octet-stream' })
    }

    mappingProjects.push({ project, mappings, scoresFile })
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
    workspace, organization, projects, projectEntries, schemas, databases,
    wikiPages, wikiAttachmentsMeta, wikiAttachmentBlobs,
    sqlCollections, etlPipelines, dqRuleSets, conceptSets,
    mappingProjects, sourceConceptIdRanges, sourceConceptIdEntries,
    catalogs, serviceMappings, plugins,
  }
}
