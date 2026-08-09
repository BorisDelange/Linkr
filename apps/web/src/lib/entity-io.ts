/**
 * Shared utilities for entity export/import (ZIP and JSON).
 */
import JSZip from 'jszip'
import type { Storage } from '@/lib/storage'
import { APP_VERSION } from '@/lib/version'
import { deterministicId } from '@/lib/deterministic-id'
import {
  type PathNode, type TreeNode,
  type TreeFkKey,
  fromPathTree, readPathTree, storablePathNode, toPathTree, treeNodePath,
} from '@/lib/entity-tree'
import type {
  Project, IdeFile, Pipeline, Cohort, IdeConnection,
  Dashboard, DashboardTab, DashboardWidget, DashboardFilter,
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
  AuthorDetails,
} from '@/types'
import { localized, toLocalized } from '@/lib/localized'
import { buildMappingProjectFolder, cleanMappingProjectMeta, restoreFileSourceDataFromCsv } from '@/lib/concept-mapping/export'
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
import { compareCodePoints } from '@/lib/concept-mapping/source-concept-ids-io'
export type { CompactSourceConceptIdEntries }
import {
  toPortableRanges,
  parseSourceConceptIdEntries,
  mergeSourceConceptIdRegistry,
  type SourceConceptIdGroup,
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
//   .gitignore                        — data files ignored; each versionedDataFiles entry re-included via !path
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
  // Reserved for future build options. Data-file inclusion is no longer a blanket
  // toggle: a data file is versioned iff its path is in project.config
  // versionedDataFiles (marked per-file in the sidebar) — see markedDataFiles().
  _reserved?: never
}

// Data-file extensions gitignored by default (anywhere in the tree, scripts/ and
// datasets/ alike). A file with one of these extensions is committed only when
// its EXPORT TREE PATH is marked in project.config.versionedDataFiles.
export const DATA_FILE_EXTENSIONS = ['.csv', '.parquet', '.pq', '.xlsx', '.xls']

export function isDataExtension(path: string): boolean {
  const p = path.toLowerCase()
  return DATA_FILE_EXTENSIONS.some((ext) => p.endsWith(ext))
}

/** Escape a path for use as a literal `.gitignore` pattern (after the `!`). Git
 * treats `[ ] * ? \` as glob metacharacters and `#`/`!` as line prefixes, so a
 * filename containing them would be read as a pattern and the `!path` re-inclusion
 * would silently miss the marked file. Trailing spaces are backslash-escaped so
 * git doesn't strip them. Client + server MUST escape identically (byte-parity). */
export function gitignoreEscapePath(p: string): string {
  return p
    .replace(/([\\[\]*?#!])/g, '\\$1')
    .replace(/ +$/, (m) => m.replace(/ /g, '\\ '))
}

/** The set of EXPORT TREE PATHS the user marked "to version" — e.g.
 * "datasets/cohort/cohort.csv" or "scripts/reference/concepts.csv". A single
 * namespace across both sidebars: the key is always the file's path in the export
 * tree, which is exactly what the .gitignore `!path` exception matches. Lives in
 * project.config.versionedDataFiles so it persists and travels with the export. */
export function markedDataFiles(project: { config?: Record<string, unknown> } | null | undefined): Set<string> {
  const raw = project?.config?.versionedDataFiles
  return new Set(Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [])
}

/** The set of EXPORT TREE PATHS the user marked "do NOT version" — the inverse of
 * markedDataFiles for CODE files, which are versioned by default. Same namespace
 * (export tree path). Lives in project.config.excludedFiles. An excluded code file
 * is omitted from the export tree entirely (and from scripts/_tree.json), so the
 * sidebar's "unmarked" badge reflects what actually leaves the machine. */
export function excludedCodeFiles(project: { config?: Record<string, unknown> } | null | undefined): Set<string> {
  const raw = project?.config?.excludedFiles
  return new Set(Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [])
}

/** Marking keys (export tree paths) of the files that currently exist in the
 *  project — every IDE file's `scripts/<path>` and every dataset file's
 *  `datasets/<path>`. Mirrors the path computation buildProjectZip uses, so a mark
 *  is "live" iff its file is still there. Used to prune stale config entries. */
async function collectLiveMarkKeys(projectUid: string, storage: Storage): Promise<Set<string>> {
  const keys = new Set<string>()
  const rawIdeFiles = await storage.ideFiles.getByProject(projectUid)
  const syntheticRoot = rawIdeFiles.find((f) => f.parentId == null && f.type === 'folder' && f.name === 'scripts')
  const ideFiles = rawIdeFiles
    .filter((f) => f !== syntheticRoot)
    .map((f) => (syntheticRoot && f.parentId === syntheticRoot.id ? { ...f, parentId: null } : f))
  const ideById = new Map(ideFiles.map((f) => [f.id, f]))
  for (const f of ideFiles) if (f.type === 'file') keys.add(buildIdePath(f, ideById))
  const datasetFiles = await storage.datasetFiles.getByProject(projectUid)
  const dsById = new Map(datasetFiles.map((f) => [f.id, f]))
  for (const f of datasetFiles) if (f.type === 'file') keys.add(`datasets/${buildDatasetPath(f, dsById)}`)
  return keys
}

/** Return the project with config.versionedDataFiles / excludedFiles filtered to
 *  entries whose file still exists (key in `liveMarkKeys`). Order preserved; a
 *  shallow copy only when something changed. Byte-parity with the server's
 *  _prune_marked_paths. */
function pruneMarkedPaths<T extends { config?: Record<string, unknown> }>(project: T, liveMarkKeys: Set<string>): T {
  const config = project.config
  if (!config || typeof config !== 'object') return project
  let changed = false
  const newConfig = { ...config }
  for (const key of ['versionedDataFiles', 'excludedFiles'] as const) {
    const raw = config[key]
    if (!Array.isArray(raw)) continue
    const pruned = raw.filter((p): p is string => typeof p === 'string' && liveMarkKeys.has(p))
    if (pruned.length !== raw.length) {
      newConfig[key] = pruned
      changed = true
    }
  }
  return changed ? { ...project, config: newConfig } : project
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

/** An IdeFile's path RELATIVE to scripts/ — the key used inside
 *  `scripts/_tree.json`, which itself lives in that folder. */
function ideTreePath(file: IdeFile, byId: Map<string, IdeFile>): string {
  return buildIdePath(file, byId).replace(/^scripts\//, '')
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

// Dashboard content keys — uid-independent stable ids for the git round-trip.
//
// Dashboard/tab/widget ids are UUIDs, so a delete+reimport (fresh project uid)
// re-derives every id and churns the whole diff. Instead we strip the UUIDs on
// export and re-derive each id on import from a stable CONTENT key (like datasets,
// whose id is a slug/path). Keys are computed identically in export and import.
//
// Name uniqueness is only UI-enforced, so keys disambiguate on collision:
// tabs by displayOrder, widgets by grid position (y,x) then index.

/** dashboardKey — slug of the English name, matching the export filename.
 *  Falls back to the id like project-pull's dashboardNaturalKey, so an unnamed
 *  dashboard keeps a stable, non-colliding key on both sides (parity: Python
 *  _dashboard_key). */
function dashboardKey(d: Dashboard): string {
  return slugify(localized(d.name, 'en') || d.id)
}

/**
 * tabKeyMap — every tab id → its parent-qualified content key. Sub-tabs (one level
 * of nesting) are qualified by their parent tab's key; root tabs by their dashboard.
 * Siblings colliding on the same base slug get `#<displayOrder>` appended.
 */
function buildTabKeyMap(dashKey: string, tabs: DashboardTab[]): Map<string, string> {
  const keyOf = new Map<string, string>()
  const seen = new Set<string>()
  // Parents before children so a sub-tab's parent key is already resolved.
  const ordered = [...tabs].sort((a, b) => (a.parentTabId ? 1 : 0) - (b.parentTabId ? 1 : 0))
  for (const tab of ordered) {
    const base = slugify(localized(tab.name, 'en') || '')
    const parent = tab.parentTabId ? keyOf.get(tab.parentTabId) : null
    let key = `${parent ?? dashKey}/${base}`
    if (seen.has(key)) key = `${key}#${tab.displayOrder}`
    seen.add(key)
    keyOf.set(tab.id, key)
  }
  return keyOf
}

/**
 * widgetKeyMap — every widget id → its content key, qualified by its tab key and
 * disambiguated by grid position (widgets have no order field), then `#i` on a tie.
 */
function buildWidgetKeyMap(tabKeyMap: Map<string, string>, widgets: DashboardWidget[]): Map<string, string> {
  const keyOf = new Map<string, string>()
  const seen = new Set<string>()
  for (const w of widgets) {
    const tabKey = tabKeyMap.get(w.tabId) ?? ''
    const base = `${tabKey}/${slugify(localized(w.name, 'en') || '')}@${w.layout.y},${w.layout.x}`
    let key = base
    for (let i = 1; seen.has(key); i++) key = `${base}#${i}`
    seen.add(key)
    keyOf.set(w.id, key)
  }
  return keyOf
}

// Fields that are specific to the exporting instance/deployment, not portable
// project content: the owning user, the workspace placement, the git link
// (never commit a repo's own remote/token into itself), catalog/org metadata,
// and `updatedAt`. Stripped from every exported entity metadata so a round-trip
// export→import→export is stable across instances.
//
// `updatedAt` is stripped but `createdAt` is NOT: updatedAt moves on every edit
// (and is re-stamped on import), so versioning it churns the diff for no gain;
// createdAt is immutable provenance — the element's original creation date — kept
// like createdBy so it survives a cross-instance import. The import preserves the
// file's createdAt (front: `?? now` fallback / verbatim spread; back: the *Create
// schemas accept created_at) rather than re-stamping it.
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
  'updatedAt',
  // Child entities' back-reference to their local project/parent uid. Regenerated
  // on import (every create passes a fresh projectUid), so versioning it only
  // churns the diff — e.g. datasets/_tree.json flipping projectUid on reimport.
  'projectUid',
  // Local database (data source) UUIDs the project points at. Databases are an
  // instance-level resource that doesn't travel with the project, so these ids
  // are meaningless on another instance and only churn the diff — the importer
  // re-links its own databases. (Cf. the user's decision: databases stay unlinked.)
  'linkedDataSourceIds',
] as const

/** Return a copy of an entity's metadata without instance-specific fields.
 *  Accepts any object (interfaces without an index signature included). */
export function stripInstanceFields<T extends object>(meta: T): Partial<T> {
  const out: Partial<T> = { ...meta }
  for (const f of INSTANCE_FIELDS) delete (out as Record<string, unknown>)[f]
  // An empty createdAt is a legacy record predating creation-date tracking — omit
  // it rather than writing `"createdAt": ""` (no false date, no churn). A real
  // createdAt is kept as portable provenance.
  if (!(out as Record<string, unknown>).createdAt) delete (out as Record<string, unknown>).createdAt
  return out
}

/** parseOptions with its keys (and nested per-column maps) sorted, so the exported
 *  datasets/_tree.json order doesn't depend on the order the user set the options
 *  in. Mirrors the server's `_canonical_parse_options` — both builders emit
 *  insertion order verbatim for front/back byte-parity, so both must canonicalise. */
function canonicalParseOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(opts).sort()) {
    const v = opts[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((ck) => [ck, (v as Record<string, unknown>)[ck]]))
      : v
  }
  return out
}

/** A dataset file's export metadata: instance fields stripped + parseOptions keys
 *  canonicalised (parity-stable ordering). */
function datasetExportMeta(df: DatasetFile): Partial<DatasetFile> {
  const meta = stripInstanceFields(df) as Record<string, unknown>
  if (meta.parseOptions && typeof meta.parseOptions === 'object') {
    meta.parseOptions = canonicalParseOptions(meta.parseOptions as Record<string, unknown>)
  }
  return meta as Partial<DatasetFile>
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
  void options
  const project = await storage.projects.getById(projectUid)
  if (!project) return null
  const marked = markedDataFiles(project)

  const zip = new JSZip()

  // Prune config.versionedDataFiles / excludedFiles down to files that still exist,
  // so a marked (or excluded) file that was later deleted drops out of project.json
  // instead of lingering forever with no UI to clear it. Keys are export tree paths
  // (scripts/<path>, datasets/<path>) — the same namespace the marks use.
  const liveMarkKeys = await collectLiveMarkKeys(projectUid, storage)
  const prunedProject = pruneMarkedPaths(project, liveMarkKeys)

  // --- project.json (without readme/todos/notes — those go in separate files —
  // nor instance-specific fields like ownerId/workspaceId/gitRemoteConfig) ---
  // `uid` is the local primary key: a delete+reimport regenerates it, so writing it
  // would churn the diff. It's dropped here (NOT added to INSTANCE_FIELDS, which
  // children share); lineageId/parentLineageId stay for cross-instance identity.
  const { readme: _r, todos: _t, notes: _n, uid: _uid, ...projectMeta } = prunedProject
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
  // Front-only keeps a "scripts" container folder in IndexedDB (server mode's
  // disk tree is already root-less). Drop that container and reparent its direct
  // children to null, so scripts/_tree.json is a flat, git-authored tree either
  // way (no phantom root node / dangling parentId). No-op when absent.
  const rawIdeFiles = await storage.ideFiles.getByProject(projectUid)
  const syntheticRoot = rawIdeFiles.find((f) => f.parentId == null && f.type === 'folder' && f.name === 'scripts')
  const ideFiles = rawIdeFiles
    .filter((f) => f !== syntheticRoot)
    .map((f) => (syntheticRoot && f.parentId === syntheticRoot.id ? { ...f, parentId: null } : f))
  // Data files under scripts/ (e.g. a reference CSV) are gitignored like any other
  // data file; a marked one is re-included via a !path exception (key scripts/<path>).
  // Code files (non-data) are versioned by default; a file whose tree path is in
  // project.config.excludedFiles is omitted from the tree entirely (and _tree.json),
  // so an "unmarked" script never leaves the machine. Data files use the opposite
  // opt-in rule via `marked` (versionedDataFiles), so they're not excluded here.
  const excluded = excludedCodeFiles(project)
  const isExcludedCode = (treePath: string) => !isDataExtension(treePath) && excluded.has(treePath)
  const includedScriptDataPaths: string[] = []
  if (ideFiles.length > 0) {
    const byId = new Map(ideFiles.map(f => [f.id, f]))
    const treeFiles = ideFiles.filter((f) => !(f.type === 'file' && isExcludedCode(buildIdePath(f, byId))))
    // Only emit the tree when something survives the exclusions — otherwise every
    // script is excluded and we'd version a useless `scripts/_tree.json: []`.
    if (treeFiles.length > 0) {
      // Keyed by the path relative to scripts/ (see entity-tree.ts): no id/parentId
      // in the versioned tree, so a re-import can't churn them. Nothing outside the
      // tree references an IdeFile id, so deriving it from the path is safe here
      // (unlike datasets, whose ids widgets/filters point at).
      zip.file('scripts/_tree.json', json(
        treeFiles
          .map((f) => {
            const { id: _id, parentId: _p, name: _n, content: _c, projectUid: _uid, ...rest } = f
            return { path: ideTreePath(f, byId), ...rest }
          })
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ))
    }
    for (const f of ideFiles) {
      if (f.type === 'file' && f.content != null) {
        const treePath = buildIdePath(f, byId)
        if (isExcludedCode(treePath)) continue
        zip.file(treePath, f.content)
        if (isDataExtension(treePath) && marked.has(treePath)) {
          includedScriptDataPaths.push(treePath)
        }
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
  // Serialize with content keys (not UUID ids) so a delete+reimport re-derives the
  // same ids and the git diff stays byte-stable. See the key helpers above.
  const dashboards = (await storage.dashboards.getByProject(projectUid))
    .slice()
    .sort((a, b) => compareCodePoints(dashboardKey(a), dashboardKey(b)))
  for (const d of dashboards) {
    const tabs = await storage.dashboardTabs.getByDashboard(d.id)
    const widgets: DashboardWidget[] = []
    for (const tab of tabs) {
      widgets.push(...(await storage.dashboardWidgets.getByTab(tab.id)))
    }
    const dashKey = dashboardKey(d)
    const tabKeyMap = buildTabKeyMap(dashKey, tabs)
    const widgetKeyMap = buildWidgetKeyMap(tabKeyMap, widgets)

    const dashboardOut = stripInstanceFields(d) as Record<string, unknown>
    delete dashboardOut.id
    // projectUid is the parent's local PK (regenerated on reimport); import re-sets it.
    delete dashboardOut.projectUid
    if (Array.isArray(dashboardOut.filterConfig)) {
      dashboardOut.filterConfig = (dashboardOut.filterConfig as DashboardFilter[]).map((f) => {
        const out = { ...f } as Record<string, unknown>
        delete out.id
        if (f.scope?.type === 'tabs') {
          out.scope = { type: 'tabs', tabKeys: f.scope.tabIds.map((id) => tabKeyMap.get(id) ?? id) }
        } else if (f.scope?.type === 'widgets') {
          out.scope = { type: 'widgets', widgetKeys: f.scope.widgetIds.map((id) => widgetKeyMap.get(id) ?? id) }
        }
        return out
      })
    }

    // Sorted by their content key so array order is byte-stable across instances
    // (storage returns rows in PK order, which differs pre/post-reimport); import
    // re-links by key, not by position, so reordering is safe.
    const tabsOut = tabs.map((tab) => {
      const out = stripInstanceFields(tab) as Record<string, unknown>
      const key = tabKeyMap.get(tab.id)!
      const parentKey = tab.parentTabId ? tabKeyMap.get(tab.parentTabId) ?? null : null
      delete out.id
      delete out.dashboardId
      delete out.parentTabId
      return { ...out, key, parentKey }
    }).sort((a, b) => compareCodePoints(a.key, b.key))

    const widgetsOut = widgets.map((w) => {
      const out = stripInstanceFields(w) as Record<string, unknown>
      const key = widgetKeyMap.get(w.id)!
      const tabKey = tabKeyMap.get(w.tabId)!
      delete out.id
      delete out.tabId
      return { ...out, key, tabKey }
    }).sort((a, b) => compareCodePoints(a.tabKey, b.tabKey) || compareCodePoints(a.key, b.key))

    zip.file(
      `dashboards/${slugify(localized(d.name, 'en') || dashKey || d.id)}.json`,
      json({ dashboard: dashboardOut, tabs: tabsOut, widgets: widgetsOut }),
    )
  }

  // --- datasets/ (tree + analyses + optional data CSV) ---
  // Tree paths of data files actually written — each becomes a `!path` exception
  // in .gitignore so git tracks exactly the marked files and nothing else.
  const includedDataPaths: string[] = []
  const datasetFiles = await storage.datasetFiles.getByProject(projectUid)
  if (datasetFiles.length > 0) {
    const byId = new Map(datasetFiles.map(f => [f.id, f]))
    zip.file('datasets/_tree.json', json(datasetFiles.map(datasetExportMeta)))

    for (const df of datasetFiles) {
      if (df.type !== 'file') continue
      const dsPath = buildDatasetPath(df, byId)
      const folderName = dsPath.replace(/\.[^.]+$/, '')

      // columns (with label/description/valueLabels) travel inline in _tree.json;
      // the redundant _columns.json is no longer written (never read on import).

      const analyses = await storage.datasetAnalyses.getByDataset(df.id)
      for (const a of analyses) {
        zip.file(`datasets/${folderName}/${slugify(a.name || a.id)}.json`, json(stripInstanceFields(a)))
      }

      // A data file leaves the machine only when explicitly marked for versioning.
      // Marking key is the logical `datasets/<dsPath>`; the tree path is computed
      // here (datasets/<folder>/<file>) for the file write + the .gitignore exception.
      if (marked.has(`datasets/${dsPath}`)) {
        const data = await storage.datasetData.get(df.id)
        const raw = await storage.datasetRawFiles.get(df.id)

        if (raw?.blob) {
          // Original uploaded file (CSV/XLSX/parquet) kept verbatim for the user.
          zip.file(`datasets/${folderName}/${raw.fileName}`, raw.blob, { compression: 'STORE' })
          includedDataPaths.push(`datasets/${folderName}/${raw.fileName}`)
          // Parsed rows sidecar so import restores the table without re-parsing XLSX/parquet.
          if (data && data.rows.length > 0) {
            zip.file(`datasets/${folderName}/_data.json`, json({ rows: data.rows }))
            includedDataPaths.push(`datasets/${folderName}/_data.json`)
          }
        } else if (data && data.rows.length > 0) {
          // Computed dataset (no source file): reconstructed CSV, always named .csv.
          const baseName = (dsPath.split('/').pop() ?? df.name).replace(/\.[^.]+$/, '')
          zip.file(`datasets/${folderName}/${baseName}.csv`, datasetToCsv(df, data.rows))
          includedDataPaths.push(`datasets/${folderName}/${baseName}.csv`)
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

  // --- .gitignore ---
  // Data files are ignored by default EVERYWHERE — under datasets/ AND scripts/
  // (e.g. a reference CSV) — so health data is never committed by accident. Each
  // file the user marked for versioning is re-included via a `!path` exception
  // AFTER the ignore rules (git honours the last match). Glob patterns match at any
  // depth and leave parent dirs un-ignored, so the exceptions resolve.
  const gitignoreLines = ['**/*.csv', '**/*.parquet', '**/*.pq', '**/*.xlsx', '**/*.xls', '.cache/']
  for (const p of [...includedDataPaths, ...includedScriptDataPaths]) {
    gitignoreLines.push(`!${gitignoreEscapePath(p)}`)
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
// Parse project ZIP (v3 structured layout — see the layout comment above buildProjectZip)
// ---------------------------------------------------------------------------

// A git-versioned export strips the UUID ids from tabs/widgets and carries content
// keys instead (key/parentKey/tabKey); a legacy export still carries id/dashboardId/
// tabId/parentTabId. Import reads whichever is present, per record.
export type ParsedDashboardTab = DashboardTab & { key?: string; parentKey?: string | null }
export type ParsedDashboardWidget = DashboardWidget & { key?: string; tabKey?: string }

export interface ParsedProjectZip {
  project: Project
  /** Organization inherited from the parent workspace, bundled by UUID for cross-instance upsert. */
  organization?: Organization
  /** Path-keyed IDE tree nodes; local ids are derived from the target projectUid
   *  at import (attachTreeIds), not carried by the export. */
  ideFiles: TreeImportNode[]
  pipelines: Pipeline[]
  cohorts: Cohort[]
  connections: IdeConnection[]
  dashboards: Dashboard[]
  dashboardTabs: ParsedDashboardTab[]
  dashboardWidgets: ParsedDashboardWidget[]
  datasetFiles: DatasetFile[]
  datasetAnalyses: DatasetAnalysis[]
  /** CSV data parsed from _data/ folder, keyed by datasetFileId */
  datasetData: DatasetData[]
  /** Original uploaded files (CSV/XLSX/parquet) to restore into datasetRawFiles. */
  datasetRawFiles: DatasetRawFile[]
  attachmentsMeta: Omit<ReadmeAttachment, 'data'>[]
  /** Keyed by attachment id */
  attachmentBlobs: Map<string, ArrayBuffer>
  /** Managed-environment spec files (manifest + lockfile) under environments/<lang>/,
   *  restored on disk in server mode so the versioned env travels with the project.
   *  Optional: a ZIP without an environments/ folder simply has none. */
  envSpecs?: { language: string; name: string; content: string }[]
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
  // ZIP column id → final column id, matched BY NAME. Column ids are now deterministic
  // slugs of the name, so for a fresh export this map is identity (harmless). It stays as a
  // bridge for ANY id-shape difference between the ZIP and the freshly-parsed dataset —
  // chiefly a legacy export whose ids were the old `col-<timestamp>-<idx>`: without it,
  // widgets/analyses that store col ids in their config would point at columns the reparse
  // renamed. Only populated in server mode (front-only stores the ZIP's columns verbatim,
  // no reparse, so ids don't change there).
  const colIdMap = new Map<string, string>()
  const byId = new Map(parsed.datasetFiles.map(f => [f.id, f]))

  if (!isServerMode()) {
    for (const df of parsed.datasetFiles) {
      const id = mapId(df.id)
      // Folders carry no data: delete-then-create so a pull into an existing tree
      // doesn't ConstraintError on an ancestor folder (files stay insert-only —
      // a colliding FILE must keep failing loudly rather than silently merging).
      if (df.type === 'folder') await storage.datasetFiles.delete(id).catch(() => {})
      await storage.datasetFiles.create({ ...df, id, projectUid, parentId: df.parentId ? mapId(df.parentId) : null })
      datasetIdMap.set(df.id, id)
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

    // Bridge the ZIP's column ids to the server's freshly-parsed ones, matched by name
    // (identity for a deterministic-id export; the real work is for legacy col-<ts> ids).
    // Names and order are preserved by the parser, so match by index, falling back to name.
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
/** Pullable content groups of a project (each maps to a folder in the export).
 *  Databases are deliberately absent — they're an instance-level resource that
 *  doesn't travel with the project (see linkedDataSourceIds in INSTANCE_FIELDS). */
export type ProjectPullGroup =
  | 'dashboards'
  | 'scripts'
  | 'cohorts'
  | 'datasets'
  | 'pipeline'
  | 'readme'

export interface ImportProjectOptions {
  /** When set, only these groups are written; others are skipped entirely.
   *  Undefined = import everything (the plain import/clone path). The create loops
   *  are insert-only, so a pull that OVERWRITES an existing entity must delete its
   *  (deterministic) id first — see deleteDerivedProjectIds in project-pull.ts. */
  groups?: Set<ProjectPullGroup>
}

export async function importProjectContent(
  parsed: ParsedProjectZip,
  projectUid: string,
  storage: Storage,
  options: ImportProjectOptions = {},
): Promise<void> {
  const { groups } = options
  const wants = (g: ProjectPullGroup): boolean => !groups || groups.has(g)
  // A selective (pull) import narrows the content to the chosen groups by emptying
  // the arrays of the ones not wanted — the loops below stay unchanged. A plain
  // import passes no `groups`, so every array is kept. Dataset row data/raw files
  // ride with the dataset files.
  if (groups) {
    parsed = {
      ...parsed,
      ideFiles: wants('scripts') ? parsed.ideFiles : [],
      pipelines: wants('pipeline') ? parsed.pipelines : [],
      cohorts: wants('cohorts') ? parsed.cohorts : [],
      dashboards: wants('dashboards') ? parsed.dashboards : [],
      dashboardTabs: wants('dashboards') ? parsed.dashboardTabs : [],
      dashboardWidgets: wants('dashboards') ? parsed.dashboardWidgets : [],
      datasetFiles: wants('datasets') ? parsed.datasetFiles : [],
      datasetData: wants('datasets') ? parsed.datasetData : [],
      datasetRawFiles: wants('datasets') ? parsed.datasetRawFiles : [],
      datasetAnalyses: wants('datasets') ? parsed.datasetAnalyses : [],
      // Databases (connections) never travel with a project pull; readme/attachments
      // are handled by the pull module, not here.
      connections: [],
    }
  }
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

  // Dashboard/tab/widget ids: a git-versioned export carries content keys (re-derive
  // the id from the key → stable across re-imports into the same project) while a
  // legacy export carries UUID ids (fall back to mapId). Detection is per record.
  // The namespace is the LOCAL projectUid, NOT the lineage: dashboards/tabs/widgets
  // are global PKs, so scoping by lineage would collide when the same project (same
  // lineageId) is imported twice on one instance (e.g. into a second workspace) —
  // that surfaced as an unhandled 500 (UNIQUE constraint) on POST /dashboards. Cross-
  // instance identity stays on the project row's lineageId; internal widget ids need
  // only be locally unique + round-trip stable, which projectUid gives.
  const keyId = (key: string): string => deterministicId(projectUid, key)
  const dashKeyToId = new Map(parsed.dashboards.map((d) => [dashboardKey(d), keyId(dashboardKey(d))]))
  const tabKeyToId = new Map(
    parsed.dashboardTabs.filter((t) => t.key).map((t) => [t.key!, keyId(t.key!)]),
  )
  const widgetKeyToId = new Map(
    parsed.dashboardWidgets.filter((w) => w.key).map((w) => [w.key!, keyId(w.key!)]),
  )
  // A tabKey is `<dashboardKey-or-parentTabKey>/<slug>[#n]`; its dashboard portion is the
  // first segment, resolved back to the dashboard id for a tab's dashboardId.
  const dashIdForTabKey = (tabKey: string): string =>
    dashKeyToId.get(tabKey.split('/')[0]) ?? keyId(tabKey.split('/')[0])

  // IDE file ids derive from (projectUid, path): stable across re-imports of the
  // same project, distinct across projects, and absent from the versioned tree.
  for (const f of attachTreeIds<IdeFile>(parsed.ideFiles, projectUid, 'projectUid')) {
    await storage.ideFiles.create(f)
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
    const dashId = d.id ? mapId(d.id) : keyId(dashboardKey(d))
    const filterConfig = (d.filterConfig ?? []).map((f, index) => {
      // A key-based export drops the filter id and rewrites scope ids to keys; re-derive both.
      const scope = f.scope as
        | { type: 'tabs'; tabIds?: string[]; tabKeys?: string[] }
        | { type: 'widgets'; widgetIds?: string[]; widgetKeys?: string[] }
        | { type: 'all' }
        | undefined
      let rewrittenScope = f.scope
      if (scope?.type === 'tabs') {
        rewrittenScope = scope.tabKeys
          ? { type: 'tabs', tabIds: scope.tabKeys.map((k) => tabKeyToId.get(k) ?? keyId(k)) }
          : { type: 'tabs', tabIds: (scope.tabIds ?? []).map(mapId) }
      } else if (scope?.type === 'widgets') {
        rewrittenScope = scope.widgetKeys
          ? { type: 'widgets', widgetIds: scope.widgetKeys.map((k) => widgetKeyToId.get(k) ?? keyId(k)) }
          : { type: 'widgets', widgetIds: (scope.widgetIds ?? []).map(mapId) }
      }
      return {
        ...f,
        id: f.id ? mapId(f.id) : keyId(`${dashboardKey(d)}#f${index}`),
        datasetFileId: resolveDatasetId(f.datasetFileId),
        // Bridge the filter's columnId by name like widgets' config colIds — identity for a
        // deterministic-id export, the rescue path for a legacy col-<ts> export.
        columnId: colIdMap.get(f.columnId) ?? f.columnId,
        ...(f.scope ? { scope: rewrittenScope } : {}),
      }
    })
    await storage.dashboards.create(dropForeignAuthorId({
      ...d,
      id: dashId,
      projectUid,
      filterConfig,
      defaultDatasetFileId: d.defaultDatasetFileId ? resolveDatasetId(d.defaultDatasetFileId) : d.defaultDatasetFileId,
    }))
  }
  for (const tab of parsed.dashboardTabs) {
    const { key, parentKey, ...rest } = tab
    if (key) {
      await storage.dashboardTabs.create({
        ...rest,
        id: keyId(key),
        dashboardId: dashIdForTabKey(key),
        parentTabId: parentKey ? (tabKeyToId.get(parentKey) ?? keyId(parentKey)) : null,
      })
    } else {
      await storage.dashboardTabs.create({
        ...rest,
        id: mapId(tab.id),
        dashboardId: mapId(tab.dashboardId),
        parentTabId: tab.parentTabId ? mapId(tab.parentTabId) : (tab.parentTabId ?? null),
      })
    }
  }
  for (const w of parsed.dashboardWidgets) {
    const { key, tabKey, ...rest } = w
    await storage.dashboardWidgets.create({
      ...rest,
      id: key ? keyId(key) : mapId(w.id),
      tabId: tabKey ? (tabKeyToId.get(tabKey) ?? keyId(tabKey)) : mapId(w.tabId),
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

  // Managed-environment specs are on-disk (server mode only): write them back so the
  // versioned env (renv.lock / pyproject.toml) survives a clone and its packages show
  // up in Environments. Front-only has no managed env, so this is a no-op there. Only
  // on a full import (no `groups`) — a selective pull doesn't carry envs.
  if (!groups && isServerMode() && parsed.envSpecs?.length) {
    const { importEnvSpec } = await import('@/lib/api/environments')
    const byLang = new Map<'python' | 'r', { name: string; content: string }[]>()
    for (const s of parsed.envSpecs) {
      if (s.language !== 'python' && s.language !== 'r') continue
      const list = byLang.get(s.language) ?? []
      list.push({ name: s.name, content: s.content })
      byLang.set(s.language, list)
    }
    for (const [language, files] of byLang) {
      // Best-effort: a spec-restore failure must not fail the whole project import.
      await importEnvSpec(projectUid, language, files).catch(() => {})
    }
  }
}

export async function parseProjectZip(file: File): Promise<ParsedProjectZip | null> {
  const zipData = stripRootFolder(await JSZip.loadAsync(file))

  // --- Read project.json ---
  const projectFile = zipData.files['project.json']
  if (!projectFile) return null
  const projectRaw = JSON.parse(await projectFile.async('string'))
  // Clean git-versioned exports strip `uid` (the local PK) and identify the project
  // by its stable `projectId` (and `lineageId` when it has one); the target uid is
  // supplied by the caller, not read here. Accept any of the three as proof that
  // this is a real project.json — `lineageId` alone is often null on a fresh export.
  if (!projectRaw || (!projectRaw.uid && !projectRaw.projectId && !projectRaw.lineageId)) return null
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

  const parsed = await parseNewLayout(zipData, projectMeta)
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

/** Scan a folder for JSON files. */
function scanFolder(zip: JSZip, folder: string): [string, JSZip.JSZipObject][] {
  const results: [string, JSZip.JSZipObject][] = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    if (path.startsWith(folder)) {
      results.push([path, entry])
    }
  }
  return results
}

async function parseNewLayout(zip: JSZip, project: Project): Promise<ParsedProjectZip> {
  // --- IDE files (scripts/_tree.json) ---
  // The tree is keyed by path (ids are derived at import from the target
  // projectUid, which the parser doesn't know); `readPathTree` also accepts a
  // legacy id/parentId tree. Paths are relative to scripts/, where the tree lives.
  const ideFiles = readPathTree(await readJsonFile(zip, 'scripts/_tree.json'))
    .map((node) => ({ ...node })) as (PathNode & { content?: string })[]
  for (const f of ideFiles) {
    if (f.type !== 'file') continue
    const entry = zip.files[`scripts/${f.path}`]
    if (entry) f.content = await entry.async('string')
  }

  const pipelines = (await readJsonFile<Pipeline[]>(zip, 'pipeline/pipeline.json')) ?? []

  const cohorts: Cohort[] = []
  for (const [path, entry] of scanFolder(zip, 'cohorts/')) {
    if (path.endsWith('.json')) {
      cohorts.push(JSON.parse(await entry.async('string')))
    }
  }

  const connections: IdeConnection[] = []
  for (const [path, entry] of scanFolder(zip, 'databases/')) {
    if (path.endsWith('.json')) {
      connections.push(JSON.parse(await entry.async('string')))
    }
  }

  // --- Dashboards (each file = dashboard + tabs + widgets) ---
  const dashboards: Dashboard[] = []
  const dashboardTabs: DashboardTab[] = []
  const dashboardWidgets: DashboardWidget[] = []
  for (const [path, entry] of scanFolder(zip, 'dashboards/')) {
    if (path.endsWith('.json')) {
      const bundle = JSON.parse(await entry.async('string')) as {
        dashboard: Dashboard; tabs: DashboardTab[]; widgets: DashboardWidget[]
      }
      dashboards.push(bundle.dashboard)
      dashboardTabs.push(...(bundle.tabs ?? []))
      dashboardWidgets.push(...(bundle.widgets ?? []))
    }
  }

  const datasetFiles = (await readJsonFile<DatasetFile[]>(zip, 'datasets/_tree.json')) ?? []
  const datasetAnalyses: DatasetAnalysis[] = []
  for (const [path, entry] of scanFolder(zip, 'datasets/')) {
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

  const attachmentsMeta = (await readJsonFile<Omit<ReadmeAttachment, 'data'>[]>(zip, 'attachments/_meta.json')) ?? []
  const attachmentBlobs = new Map<string, ArrayBuffer>()
  for (const meta of attachmentsMeta) {
    const entry = zip.files[`attachments/${meta.id}-${meta.fileName}`]
    if (entry) attachmentBlobs.set(meta.id, await entry.async('arraybuffer'))
  }

  // Managed-environment specs: environments/<lang>/<file> (renv.lock, pyproject.toml…).
  // Kept as raw text; restored on disk server-side so the versioned env survives a
  // clone. `<file>` is a flat base name (the export writes no nested env files).
  const envSpecs: ParsedProjectZip['envSpecs'] = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const m = /^environments\/(python|r)\/([^/]+)$/.exec(path)
    if (!m) continue
    envSpecs.push({ language: m[1], name: m[2], content: await entry.async('string') })
  }

  return {
    project, ideFiles, pipelines, cohorts, connections,
    dashboards, dashboardTabs, dashboardWidgets,
    datasetFiles, datasetAnalyses, datasetData, datasetRawFiles, attachmentsMeta, attachmentBlobs,
    envSpecs,
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
//     _tree.json                              — tree keyed by path (type, order, …); ids derived on import
//     {path/to/script.sql}                    — script files at their folder path
//   etl/{slug}/
//     _pipeline.json                          — ETL pipeline metadata
//     _tree.json                              — tree keyed by path (type, order, …); ids derived on import
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

/**
 * Lay out a SQL script collection in a git-friendly tree under `prefix`:
 * `_collection.json` (metadata), `_tree.json` (the hierarchy keyed by path,
 * without content), and each script written at its real path with its raw
 * `.sql` content. See entity-tree.ts for why the tree carries no ids.
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
  const byId = new Map<string, TreeNode>(files.map(f => [f.id, f]))
  zip.file(`${prefix}_tree.json`, json(toPathTree(files, 'collectionId')))
  for (const f of files) {
    if (f.type === 'file' && f.content != null) {
      zip.file(`${prefix}${treeNodePath(f, byId)}`, f.content)
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
/**
 * Reduce an organization to its portable provenance snapshot: keep the stable
 * UUID + descriptive fields (the OrganizationInfo shape) and the createdAt
 * provenance, drop only `updatedAt` (which the importer re-stamps and which
 * churns the diff on every edit). Attaching a full Organization record verbatim
 * otherwise leaked updatedAt into the inline snapshot and produced a spurious
 * versioning diff on every re-export.
 */
function orgSnapshot(org: OrganizationInfo): OrganizationInfo {
  const { updatedAt: _u, ...rest } = org as OrganizationInfo & { updatedAt?: string; createdAt?: string }
  // The org is a JSON blob, so its inner createdAt escapes the datetime normalization
  // applied to first-class datetime fields — normalize it here to the same ms+Z form
  // (toISOString) so a server-stored second-precision date doesn't churn the diff.
  const createdAt = (rest as { createdAt?: string }).createdAt
  if (createdAt) {
    const d = new Date(createdAt)
    if (!Number.isNaN(d.getTime())) (rest as { createdAt?: string }).createdAt = d.toISOString()
  }
  return rest
}

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
  meta.organization = orgSnapshot(org)
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
  // Author provenance rides along like every other entity: createdBy + full
  // createdByDetails travel, createdById does not (a local id is meaningless
  // cross-instance — see stripInstanceFields / INSTANCE_FIELDS for projects).
  zip.file(`${prefix}_plugin.json`, json({
    id: plugin.id,
    entityId: plugin.entityId,
    createdBy: plugin.createdBy,
    createdByDetails: plugin.createdByDetails,
  }))
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
  // Inline the origin organization (full snapshot) so a single-plugin ZIP is
  // self-sufficient, matching single-project export.
  await attachEntityOrganization(zip, '_plugin.json', plugin, storage)
  const blob = await finalizeEntityZip(zip, options.lfsOverrides)
  return { blob, name: plugin.entityId || plugin.id }
}

/**
 * Reconstruct tree nodes (SqlScriptFile / EtlFile) from a parsed import ZIP using
 * the git-friendly layout (`_tree.json` keyed by path + raw files at those paths).
 * `parsed` keys are zip paths relative to the collection/pipeline root (after any
 * prefix is stripped by the caller). Folders carry no content.
 *
 * Nodes come back carrying their `path` but NO id: the caller only knows the
 * target collection/pipeline id (which namespaces the derived ids) once the
 * user has resolved an import conflict. Finish with `attachTreeIds`.
 */
export type TreeImportNode = PathNode & { content?: string }

export function reconstructTreeFiles(
  tree: unknown,
  parsed: Record<string, unknown>,
): TreeImportNode[] {
  return readPathTree(tree).map((node) => {
    if (node.type !== 'file') return node
    const raw = parsed[node.path]
    return typeof raw === 'string' ? { ...node, content: raw } : node
  })
}

/**
 * Derive the local ids for path-keyed tree nodes, once the owning
 * collection/pipeline id is known. Content already attached is preserved.
 */
export function attachTreeIds<T extends object>(
  nodes: TreeImportNode[],
  ownerId: string,
  fkKey: TreeFkKey,
): T[] {
  const contentByPath = new Map(nodes.map((n) => [n.path, n.content]))
  return fromPathTree<T & { path: string }>(nodes, ownerId, fkKey).map((rec) => {
    const content = contentByPath.get(rec.path)
    const node = storablePathNode(rec) as T
    if (content !== undefined) (node as Record<string, unknown>).content = content
    return node
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
  workspaceId?: string,
  gitRemoteConfig?: GitRemoteConfig,
): Promise<boolean> {
  const readJson = async <T>(name: string): Promise<T | null> => {
    const entry = zip.files[name]
    return entry ? (JSON.parse(await entry.async('string')) as T) : null
  }

  if (type === 'sql-collection' || type === 'etl-pipeline') {
    // The record itself (metadata) is re-applied from the repo's _collection.json /
    // _pipeline.json — the workspace only carried a minimal pointer. Then the files.
    const metaName = type === 'sql-collection' ? '_collection.json' : '_pipeline.json'
    const meta = await readJson<SqlScriptCollection | EtlPipeline>(metaName)
    if (meta) {
      const { id: _id, workspaceId: _ws, ...changes } = dropForeignAuthorId(meta) as SqlScriptCollection
      if (type === 'sql-collection') await storage.sqlScriptCollections.update(targetId, changes).catch(() => {})
      else await storage.etlPipelines.update(targetId, changes as Partial<EtlPipeline>).catch(() => {})
    }
    const fkKey = type === 'sql-collection' ? 'collectionId' : 'pipelineId'
    // Clear this collection's/pipeline's own files first, so a retry or a re-clone
    // over a prior pointer doesn't leave stale rows.
    if (type === 'sql-collection') await storage.sqlScriptFiles.deleteByCollection(targetId).catch(() => {})
    else await storage.etlFiles.deleteByPipeline(targetId).catch(() => {})
    // Ids are derived from (targetId, path), so they're stable across re-clones
    // into this collection and distinct from a sibling clone of the same repo —
    // no collision to recover from, and _tree.json carries no id to churn.
    const tree = readPathTree(await readJson('_tree.json'))
    for (const rec of fromPathTree<Record<string, unknown>>(tree, targetId, fkKey)) {
      if (rec.type === 'file') {
        const content = await zip.files[String(rec.path)]?.async('string')
        if (content !== undefined) rec.content = content
      }
      const node = dropForeignAuthorId(storablePathNode(rec))
      if (type === 'sql-collection') await storage.sqlScriptFiles.create(node as unknown as SqlScriptFile).catch(() => {})
      else await storage.etlFiles.create(node as unknown as EtlFile).catch(() => {})
    }
    return true
  }

  if (type === 'mapping-project') {
    // Full restore — same content the standalone git/ZIP import applies:
    // project.json (→ fileSourceData/source concepts), mappings.json,
    // source-concept-ids/, similarity-scores.parquet. Restoring only mappings
    // left the source-concept table empty ("imported but no concepts").
    const files: Record<string, unknown> = {}
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir || path === 'similarity-scores.parquet') continue
      const text = await entry.async('string')
      try { files[path] = JSON.parse(text) } catch { files[path] = text }
    }
    const scoresEntry = zip.files['similarity-scores.parquet']
    const scoresBytes = scoresEntry && !scoresEntry.dir ? await scoresEntry.async('uint8array') : null
    const { importMappingProjectContent } = await import('@/lib/concept-mapping/import')
    return importMappingProjectContent(
      { files, scoresBytes },
      { targetId, workspaceId: workspaceId ?? '', replaceExisting: true, gitRemoteConfig },
      storage,
    )
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
      // Re-mint the check id: it's a global PK, so the repo's original id collides
      // when the same rule-set repo is cloned into a second workspace or as a copy.
      const { id: _cid, ruleSetId: _rs, ...rest } = c
      await storage.dqCustomChecks.create({ ...rest, id: crypto.randomUUID(), ruleSetId: targetId } as DqCustomCheck).catch(() => {})
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
  // Delete-first so a retry after a partially-successful clone is idempotent:
  // importProjectContent derives sub-entity ids deterministically from targetId
  // and inserts without catch, so a re-run would collide and throw (leaving the
  // badge stuck 'failed'). The sql/etl/dq branches above delete-first for the
  // same reason.
  await deleteProjectData(storage, targetId)
  // Apply the project's own metadata BEFORE its content. The workspace only carried
  // a pointer (uid/name/gitRemoteConfig); the repo's project.json + README.md +
  // tasks.json are authoritative for the rest (readme/todos/notes included — the
  // lightweight workspace entry never carried them). Doing this first means a later
  // failure while importing sub-entities (a colliding dashboard id, a bad dataset)
  // still leaves the README, tasks and git link on the record instead of dropping
  // them — the previous order lost all three whenever content import threw. Keep the
  // local uid/workspaceId and re-apply the git pointer (the repo export strips
  // gitRemoteConfig as an instance field).
  const { uid: _uid, workspaceId: _ws, ...meta } = dropForeignAuthorId(parsed.project) as Project
  await storage.projects.update(targetId, {
    ...meta,
    ...(gitRemoteConfig ? { gitRemoteConfig } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  }).catch(() => {})
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
  const byId = new Map<string, TreeNode>(files.map(f => [f.id, f]))

  // Per-file versioning marks (pipeline.config): a code file the user excluded
  // never leaves the machine, so it is dropped from the tree as well as the
  // files — a _tree.json naming a file that is not there would break re-import.
  const excluded = new Set(pipeline.config?.excludedFiles ?? [])
  const isExcludedCode = (path: string) => !isDataExtension(path) && excluded.has(path)
  const kept = files.filter((f) => !(f.type === 'file' && isExcludedCode(treeNodePath(f, byId))))
  zip.file(`${prefix}_tree.json`, json(toPathTree(kept, 'pipelineId')))

  const includedDataPaths: string[] = []
  for (const f of kept) {
    if (f.type !== 'file' || f.content == null) continue
    const path = treeNodePath(f, byId)
    zip.file(`${prefix}${path}`, f.content)
    // A data file is gitignored by default; the mark re-includes it below.
    if (isDataExtension(path) && (pipeline.config?.versionedDataFiles ?? []).includes(path)) {
      includedDataPaths.push(path)
    }
  }

  // Standalone pipeline repo only: inside a workspace export the root .gitignore
  // already covers these, and a nested copy would just be noise.
  //
  // A pipeline's data files are gitignored like everywhere else in the app. This
  // matters most for mapping/*.csv: those rows are a mapping project's own
  // dictionary, kept out of the generated script precisely so they are not
  // committed — writing them here would put them back in the repo.
  if (!prefix) {
    const lines = DATA_FILE_EXTENSIONS.map((e) => `**/*${e}`)
    // After the ignores: git honours the last matching rule.
    lines.push(...includedDataPaths.map((p) => `!${gitignoreEscapePath(p)}`))
    zip.file('.gitignore', `${lines.join('\n')}\n`)
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
  // reconstitute it (upsert by UUID) without a shared org registry. orgSnapshot
  // drops updatedAt (re-stamped on import) and normalizes createdAt to ms+Z, so
  // this root org matches the inline snapshots and doesn't churn the diff.
  if (workspace.organizationId) {
    const org = await storage.organizations.getById(workspace.organizationId)
    if (org) zip.file('organization.json', json(orgSnapshot(org as unknown as OrganizationInfo)))
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
        // Pointer only — the linked repo's own project.json is the source of truth for
        // ALL metadata (name/description/version/author/…) + README. The workspace keeps
        // just enough to create the record and clone: uid, folder slug, display name, and
        // the git pointer. The clone (applyClonedEntity → importProjectContent) overwrites
        // the metadata from the repo. This kills the double-versioning where editing a
        // linked project rewrote its project.json in both its repo and the workspace branch.
        // createdAt rides along so the pointer-create records the real creation
        // date up front (the server stamps func.now() for an absent createdAt, and
        // the follow-up clone would only correct it if reached). Kept off the churn
        // list because it's immutable provenance, not volatile placement.
        // Omit createdAt when absent (legacy front-only projects) so it matches the
        // server builder byte-for-byte — Python emits `null` for a missing value,
        // JSON.stringify drops an undefined key, which would spuriously diverge.
        const pointer = {
          uid: project.uid,
          projectId: project.projectId,
          name: project.name,
          ...(project.createdAt ? { createdAt: project.createdAt } : {}),
          gitRemoteConfig: git,
        }
        zip.file(`projects/${folder}/project.json`, json(pointer))
        gitLinks.push({ type: 'project', id: project.uid, folder, url: git.url, branch: git.branch })
      } else if (includeData[project.uid]) {
        // Full project content nested under projects/<folder>/ (reuses buildProjectZip layout).
        // Data files are bundled per the project's own versionedDataFiles marking
        // (buildProjectZip reads project.config) — no blanket include flag anymore.
        const sub = await buildProjectZip(project.uid, storage, {})
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
        // Pointer only — the linked repo's preset.json is the source of truth. Keep
        // just presetId (create key + git detection), presetLabel (display), and the
        // git pointer; the clone (applyClonedEntity) re-applies the full preset.
        const folder = slugify(sp.presetId)
        const pointer = { presetId: sp.presetId, mapping: sp.mapping?.presetLabel ? { presetLabel: sp.mapping.presetLabel } : undefined, gitRemoteConfig: git }
        zip.file(`schemas/${folder}/_schema.json`, json(pointer))
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
      // Vocabulary references (ATHENA OMOP target vocabularies imported for
      // mapping) are an internal artifact, not a real database — the whole UI
      // hides them (isVocabularyReference). They must not be versioned either,
      // or the workspace shows a phantom "Databases (1)" with an empty list.
      if ((ds as { isVocabularyReference?: boolean }).isVocabularyReference) continue
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
        // Pointer only — the linked repo is the source of truth for the collection
        // metadata AND its scripts; the clone (applyClonedEntity) re-applies both.
        // createdAt rides along so the pointer-create records the real creation date
        // (an absent createdAt makes the server stamp func.now(), and a failed clone
        // would never correct it). Omit when absent for byte-parity with the server.
        zip.file(`sql-scripts/${folder}/_collection.json`, json({ id: collection.id, name: collection.name, ...(collection.createdAt ? { createdAt: collection.createdAt } : {}), gitRemoteConfig: git }))
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
        // Pointer only — the linked repo is the source of truth for the pipeline
        // metadata AND its files; the clone (applyClonedEntity) re-applies both.
        // createdAt rides along so the pointer-create records the real creation date
        // (an absent createdAt makes the server stamp func.now(), and a failed clone
        // would never correct it). Omit when absent for byte-parity with the server.
        zip.file(`etl/${folder}/_pipeline.json`, json({ id: pipeline.id, name: pipeline.name, ...(pipeline.createdAt ? { createdAt: pipeline.createdAt } : {}), gitRemoteConfig: git }))
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
      const git = resolveGitRemote(rs)
      if (git) {
        // Pointer only — the linked repo's rule-set.json + checks.json are the source
        // of truth; the clone (applyClonedEntity) re-applies metadata and checks.
        const folder = eid(rs)
        // createdAt rides along so the pointer-create records the real creation date
        // (an absent createdAt makes the server stamp func.now(), and a failed clone
        // would never correct it). Omit when absent for byte-parity with the server.
        zip.file(`data-quality/${folder}/_ruleset.json`, json({ ruleSet: { id: rs.id, name: rs.name, ...(rs.createdAt ? { createdAt: rs.createdAt } : {}), gitRemoteConfig: git }, checks: [] }))
        gitLinks.push({ type: 'dq-rule-set', id: rs.id, folder, url: git.url, branch: git.branch })
        continue
      }
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
        // Pointer only — the linked repo's project.json is the source of truth for all
        // metadata (+ mappings.json / source-concepts.csv). The clone re-applies it via
        // importMappingProjectContent(replaceExisting). Kills the createdAt/etc. churn
        // where versioning a linked mapping project rewrote its stub in the workspace.
        // createdAt rides along so the pointer-create records the real creation date
        // (an absent createdAt makes the server stamp func.now(), and a failed clone
        // would never correct it). Omit when absent for byte-parity with the server.
        zip.file(`mapping-projects/${folder}/project.json`, json({ id: mp.id, entityId: mp.entityId, name: mp.name, ...(mp.createdAt ? { createdAt: mp.createdAt } : {}), gitRemoteConfig: git }))
        gitLinks.push({ type: 'mapping-project', id: mp.id, folder, url: git.url, branch: git.branch })
        continue
      }

      if (!includeData[mp.id]) {
        // Unlinked, data not requested: metadata only (skip mappings + source concepts).
        // Same clean, portable project.json as the full export.
        zip.file(`mapping-projects/${folder}/project.json`, json(cleanMappingProjectMeta(mp)))
        continue
      }

      await buildMappingProjectFolder(zip, `mapping-projects/${folder}/`, mp, storage)
    }

    // --- source-concept-ids/ranges.json (whole-workspace badge allocation) ---
    // Ownership model (docs/architecture.md, "Versioning (as-built)"):
    // the RANGES (per-badge allocation window + nextId, shared across projects on
    // a badge) live at the workspace root — a single source of truth. The ENTRIES
    // are NOT written here anymore: they belong to each project and travel in
    // mapping-projects/{slug}/source-concept-ids/entries.json (written by
    // buildMappingProjectFolder above, or carried by a git-linked project's own
    // repo). Import/seed reconstruct the registry from the per-project entries +
    // a monotone merge of these ranges, so a stale root never regresses nextId.
    const idRanges = await storage.sourceConceptIdRanges.getByWorkspace(workspaceId)
    if (idRanges.length > 0) {
      zip.file('source-concept-ids/ranges.json', json(toPortableRanges(idRanges)))
    }
  }

  // --- catalogs/ + service-mappings/ ---
  if (on('catalogs')) {
    const catalogs = await storage.dataCatalogs.getByWorkspace(workspaceId)
    for (const cat of catalogs) {
      if (excluded[cat.id]) continue
      const git = resolveGitRemote(cat)
      if (git) {
        // Pointer only — the linked repo's catalog.json is the source of truth; the
        // clone (applyClonedEntity) re-applies the full catalog metadata.
        const folder = eid(cat)
        // createdAt rides along so the pointer-create records the real creation date
        // (an absent createdAt makes the server stamp func.now(), and a failed clone
        // would never correct it). Omit when absent for byte-parity with the server.
        zip.file(`catalogs/${folder}/_catalog.json`, json({ id: cat.id, name: cat.name, ...(cat.createdAt ? { createdAt: cat.createdAt } : {}), gitRemoteConfig: git }))
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
      zip.file(`plugins/${folder}/_plugin.json`, json({ id: plugin.id, entityId: plugin.entityId, workspaceId: plugin.workspaceId, createdBy: plugin.createdBy, createdByDetails: plugin.createdByDetails, createdAt: plugin.createdAt }))
      for (const [filename, content] of Object.entries(plugin.files)) {
        zip.file(`plugins/${folder}/${filename}`, content)
      }
    }
  }

  // --- git-links.json (manifest of git-linked entities; portal build derives .gitmodules from it) ---
  if (gitLinks.length > 0) {
    // Sort deterministically so adding/removing an unrelated link never reorders the rest
    // and churns the versioning diff. Key is (type, id) — id is an immutable UUID.
    const links = [...gitLinks].sort(
      (a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
    )
    zip.file('git-links.json', json({ appVersion: APP_VERSION, links }))
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
  const projects = new Map<string, ParsedProjectZip>()
  const projectEntries: ParsedProjectEntry[] = []
  const projectFolders = new Set<string>()
  for (const path of Object.keys(zipData.files)) {
    if (!path.startsWith('projects/')) continue
    const parts = path.split('/')
    if (parts.length >= 2 && parts[1]) projectFolders.add(parts[1])
  }
  // A lightweight entry (catalog-only) and a git-linked pointer carry only
  // project.json + README*.md; anything else under the folder means full nested
  // content in the buildProjectZip layout.
  const lightweightFile = /^(?:project\.json|README(?:\.[a-z]{2})?\.md)$/
  for (const folder of projectFolders) {
    const prefix = `projects/${folder}/`
    const hasFullContent = Object.entries(zipData.files).some(([p, entry]) =>
      !entry.dir && p.startsWith(prefix) && !lightweightFile.test(p.slice(prefix.length))
    )

    if (hasFullContent) {
      // Re-pack the subtree so the single project parser handles it.
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
    const files = fromPathTree<SqlScriptFile & { path: string }>(
      readPathTree(await readJsonFile(zipData, `${prefix}_tree.json`)),
      collection.id,
      'collectionId',
    )
    for (const f of files) {
      if (f.type !== 'file') continue
      const entry = zipData.files[`${prefix}${f.path}`]
      if (entry) f.content = await entry.async('string')
    }
    sqlCollections.push({ collection, files: files as SqlScriptFile[] })
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
    const files = fromPathTree<EtlFile & { path: string }>(
      readPathTree(await readJsonFile(zipData, `${prefix}_tree.json`)),
      pipeline.id,
      'pipelineId',
    )
    for (const f of files) {
      if (f.type !== 'file') continue
      const entry = zipData.files[`${prefix}${f.path}`]
      if (entry) f.content = await entry.async('string')
    }
    etlPipelines.push({ pipeline, files: files as EtlFile[] })
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
  // Each project's source-concept-ids/ subfolder is a registry group; the
  // ownership model puts the ENTRIES here (the root holds only ranges). Collected
  // and merged with the root below.
  const projectGroups: SourceConceptIdGroup[] = []
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

    // Per-project source-concept-ids (entries owned here; ranges act as a nextId floor).
    const pRanges = (await readJsonFile<SourceConceptIdRange[]>(zipData, `${prefix}source-concept-ids/ranges.json`)) ?? []
    const pRawEntries = await readJsonFile<CompactSourceConceptIdEntries | SourceConceptIdEntry[]>(zipData, `${prefix}source-concept-ids/entries.json`)
    const pEntries = pRawEntries ? parseSourceConceptIdEntries(pRawEntries, workspace.id) : []
    if (pRanges.length > 0 || pEntries.length > 0) projectGroups.push({ ranges: pRanges, entries: pEntries })

    mappingProjects.push({ project, mappings, scoresFile })
  }

  // --- source-concept-ids/ registry: root ranges + per-project entries, merged.
  // Root holds the whole-workspace ranges; each project subfolder owns its entries
  // (see the ownership plan). A legacy root entries.json is still read as a
  // fallback for keys no project group provided. mergeSourceConceptIdRegistry does
  // the monotone range merge + project-owned entry union.
  const rootRanges = (await readJsonFile<SourceConceptIdRange[]>(zipData, 'source-concept-ids/ranges.json')) ?? []
  const rootRawEntries = await readJsonFile<CompactSourceConceptIdEntries | SourceConceptIdEntry[]>(zipData, 'source-concept-ids/entries.json')
  const rootEntries = rootRawEntries ? parseSourceConceptIdEntries(rootRawEntries, workspace.id) : []
  const merged = mergeSourceConceptIdRegistry(projectGroups, { ranges: rootRanges, entries: rootEntries })
  // Re-hydrate into full SourceConceptIdRange/Entry shape the importer expects
  // (workspaceId/id are re-stamped by the caller; timestamps default there too).
  const sourceConceptIdRanges = merged.ranges.map((r) => ({ ...r, workspaceId: workspace.id } as SourceConceptIdRange))
  const sourceConceptIdEntries = merged.entries

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
    const pluginMeta = await readJsonFile<{ id: string; entityId?: string; workspaceId?: string; createdBy?: string; createdByDetails?: AuthorDetails; createdAt: string; updatedAt?: string }>(zipData, `${prefix}_plugin.json`)
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
