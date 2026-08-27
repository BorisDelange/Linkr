/**
 * Shared utilities for entity export/import (ZIP and JSON).
 */
import JSZip from 'jszip'
import {
  CONTENT_FILE, ENTITY_MANIFEST, MANIFEST, ROOT_FILE, SCRIPTS_DIR, SIDECAR, type LayoutKind,
  buildTabKeyMap, buildWidgetKeyMap, canonicalSchemaMapping,
  dashboardKey as sharedDashboardKey, slugify, type Issue,
} from '@linkr/format'
import type { Storage } from '@/lib/storage'
import { APP_VERSION } from '@/lib/version'
import { MAPPING_DIR } from '@/lib/duckdb/mapping-source'
import { deterministicId } from '@/lib/deterministic-id'
import { validateImportZip } from '@/lib/import-validation'
import {
  type PathNode, type TreeNode,
  type TreeFkKey,
  fromPathTree, readPathTree, storablePathNode, toPathTree, treeNodePath,
} from '@/lib/entity-tree'
import type {
  Project, IdeFile, Pipeline, Cohort, ConceptList, IdeConnection,
  Dashboard, DashboardTab, DashboardWidget, DashboardFilter,
  PatientDashboard, PatientDashboardTab, PatientDashboardWidget,
  DatasetFile, DatasetData, DatasetRawFile, DatasetAnalysis, ReadmeAttachment, ReadmeOwnerType,
  EntityLicense,
  Workspace, WikiPage, WikiAttachment,
  SqlScriptCollection, SqlScriptFile,
  EtlPipeline, EtlFile,
  DqRuleSet, DqCustomCheck,
  ConceptSet, MappingProject, ConceptMapping,
  SourceConceptIdRange, SourceConceptIdEntry,
  DataCatalog, ServiceMapping, UserPlugin,
  DataSource, CustomSchemaPreset,
  DatabaseConnectionConfig, StoredFile, SchemaMapping, SchemaSource,
  GitRemoteConfig,
  LocalizedString, TodoItem,
  Organization, OrganizationInfo,
  AuthorDetails,
} from '@/types'
import * as engine from '@/lib/duckdb/engine'
import { getSchemaPreset } from '@/lib/schema-presets'
import { localized, toLocalized } from '@/lib/localized'
import { README_FILE_RE } from '@/lib/entity-tree'
import { buildMappingProjectFolder, restoreFileSourceDataFromCsv } from '@/lib/concept-mapping/export'
import { isServerMode } from '@/lib/api-client'
import { importDatasetOnServer } from '@/lib/api/datasets'


/**
 * Which language `README.md` holds, when it is not English.
 *
 * A French-only readme used to be written to the suffix-free `README.md` (the
 * primary is the first language when there is no English) while the reader mapped
 * a suffix-free name to `'en'` unconditionally — so it came back as English, and
 * a pull then overwrote the real English readme with French text. The primary
 * language now travels in the entity JSON, the same split the license already
 * uses (text in the file, identity in the JSON): `README.md` stays the name git
 * and the portal render, and the round-trip stays lossless.
 */
export function readmeLangMeta(
  readme: LocalizedString | string | null | undefined,
): string | undefined {
  const primary = primaryReadmeLang(readme)
  return primary && primary !== 'en' ? primary : undefined
}

/** The language written to the suffix-free `README.md`, or undefined if empty. */
function primaryReadmeLang(
  readme: LocalizedString | string | null | undefined,
): string | undefined {
  if (!readme) return undefined
  const byLang = toLocalized(readme)
  const langs = Object.keys(byLang).filter((l) => byLang[l])
  if (langs.length === 0) return undefined
  return langs.includes('en') ? 'en' : langs[0]
}

/**
 * Write a project/workspace README as `README.md` (English or first language)
 * plus `README.<lang>.md` siblings, so it round-trips per language while
 * staying git/portal-readable. Accepts legacy plain strings.
 *
 * Which language landed in the suffix-free file is recorded by `readmeLangMeta`
 * in the entity JSON — see its note.
 */
export function writeReadmeFiles(
  zip: JSZip,
  dir: string,
  readme: LocalizedString | string | null | undefined,
): void {
  if (!readme) return
  const byLang = toLocalized(readme)
  const langs = Object.keys(byLang).filter((l) => byLang[l])
  if (langs.length === 0) return
  const primary = primaryReadmeLang(readme)
  for (const lang of langs) {
    const suffix = lang === primary ? '' : `.${lang}`
    zip.file(`${dir}README${suffix}.md`, byLang[lang])
  }
}

/**
 * Write an entity's license as `LICENSE.md` — the name both GitHub and GitLab
 * detect. Only the text lands in the file; which license it is stays in the
 * entity's JSON (see `licenseMeta`) so the id round-trips without parsing legalese.
 */
export function writeLicenseFile(zip: JSZip, dir: string, license: EntityLicense | null | undefined): void {
  if (!license?.text) return
  zip.file(`${dir}LICENSE.md`, license.text)
}

/** JSON-safe license: the text is stripped, it travels as LICENSE.md. */
export function licenseMeta(license: EntityLicense | null | undefined): { id: string; name?: string } | undefined {
  if (!license) return undefined
  return license.name ? { id: license.id, name: license.name } : { id: license.id }
}

/** Recombine an entity's license from its JSON metadata + its LICENSE.md text. */
export function readLicense(
  meta: { id?: string; name?: string } | null | undefined,
  text: string | undefined,
): EntityLicense | undefined {
  // A licence has two halves: its identity in the manifest, its text in
  // LICENSE.md. Requiring the text to keep the identity dropped the whole thing
  // for an entity that names a licence without shipping its full text — so an
  // export → import → re-export round trip silently erased `license`, and the
  // next git sync read that as a deletion nobody made.
  if (!text) return meta?.id ? { id: meta.id as EntityLicense['id'], ...(meta.name ? { name: meta.name } : {}) } : undefined
  return {
    id: (meta?.id as EntityLicense['id']) ?? 'custom',
    ...(meta?.name ? { name: meta.name } : {}),
    text,
  }
}

/** `attachments/_meta.json` + blobs for one entity folder. Owner fields are left
 *  out: they are re-stamped from context on import, so the ZIP stays portable. */
export async function writeAttachmentFiles(
  zip: JSZip,
  dir: string,
  storage: Storage,
  ownerType: ReadmeOwnerType,
  ownerId: string,
): Promise<void> {
  // Tolerate a storage without the attachment store (older server adapter, or a
  // narrow test double): an entity's docs must still export.
  const unordered = await (storage.readmeAttachments
    ?.getByOwner(ownerType, ownerId)
    .catch(() => [] as ReadmeAttachment[]) ?? Promise.resolve([] as ReadmeAttachment[]))
  if (unordered.length === 0) return
  // Sorted by id, because neither backend promises an order: the IDB index yields
  // insertion order and the server's SELECT has no ORDER BY (arbitrary by SQL
  // contract). With two attachments on one entity the two runtimes could emit
  // `_meta.json` in different orders — a false git diff flipping on every export,
  // which is exactly what the golden twins exist to prevent. Every other list in
  // these exporters is explicitly sorted for the same reason.
  const attachments = [...unordered].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const meta = attachments.map((att) => ({
    id: att.id,
    fileName: att.fileName,
    mimeType: att.mimeType,
    fileSize: att.fileSize,
    createdAt: att.createdAt,
  }))
  zip.file(`${dir}attachments/_meta.json`, json(meta))
  for (const att of attachments) {
    zip.file(`${dir}attachments/${att.id}-${att.fileName}`, att.data)
  }
}

/**
 * An entity's JSON metadata without the documentation that travels as files:
 * `readme` is dropped (it becomes README.md) and `license` keeps only its
 * identity (the text becomes LICENSE.md).
 *
 * `readmeLang` is kept when the suffix-free README.md is NOT English, so the
 * import knows which language it holds (see `readmeLangMeta`). Omitted for the
 * English case, so the common export is byte-identical to before.
 */
function stripEntityDocs<T extends { readme?: unknown; license?: EntityLicense }>(
  meta: T,
): Omit<T, 'readme' | 'license'> & {
  license?: { id: string; name?: string }
  readmeLang?: string
} {
  const { readme, license, ...rest } = meta
  const licence = licenseMeta(license)
  const lang = readmeLangMeta(readme as LocalizedString | string | null | undefined)
  return {
    ...rest,
    ...(licence ? { license: licence } : {}),
    ...(lang ? { readmeLang: lang } : {}),
  }
}

/** An entity's README attachments as they travel in a ZIP, owner-agnostic. */
export interface ParsedEntityAttachments {
  meta: Omit<ReadmeAttachment, 'data' | 'ownerType' | 'ownerId'>[]
  blobs: Map<string, ArrayBuffer>
}

/** Persist parsed attachments for an entity, stamping the resolved owner. */
export async function createEntityAttachments(
  storage: Storage,
  attachments: ParsedEntityAttachments | undefined,
  ownerType: ReadmeOwnerType,
  ownerId: string,
  workspaceId?: string,
): Promise<void> {
  if (!attachments) return
  // Re-importing the same entity must not stack duplicates of its images.
  await storage.readmeAttachments.deleteByOwner(ownerType, ownerId).catch(() => {})
  for (const meta of attachments.meta) {
    const data = attachments.blobs.get(meta.id)
    if (!data) continue
    await storage.readmeAttachments
      .create({ ...meta, ownerType, ownerId, workspaceId, data })
      .catch(() => {})
  }
}

/**
 * Read back the docs an entity folder carries as files: README.md (+ per-language
 * siblings), LICENSE.md, and the attachments metadata/blobs. The license id comes
 * from the entity's JSON, the text from the file.
 */
async function readEntityDocs(
  zipData: JSZip,
  prefix: string,
  meta: { license?: { id?: string; name?: string }; readmeLang?: string },
): Promise<{
  readme?: LocalizedString
  license?: EntityLicense
  attachmentsMeta: Omit<ReadmeAttachment, 'data' | 'ownerType' | 'ownerId'>[]
  attachmentBlobs: Map<string, ArrayBuffer>
}> {
  const readmeByLang: LocalizedString = {}
  for (const path of Object.keys(zipData.files)) {
    if (!path.startsWith(prefix)) continue
    const m = README_FILE_RE.exec(path.slice(prefix.length))
    if (m) {
      readmeByLang[m[1] ?? meta.readmeLang ?? 'en'] = await zipData.files[path].async('string')
    }
  }
  const licenseEntry = zipData.files[`${prefix}LICENSE.md`]
  const licenseText = licenseEntry ? await licenseEntry.async('string') : undefined

  const attachmentsMeta =
    (await readJsonFile<Omit<ReadmeAttachment, 'data' | 'ownerType' | 'ownerId'>[]>(
      zipData,
      `${prefix}attachments/_meta.json`,
    )) ?? []
  const attachmentBlobs = new Map<string, ArrayBuffer>()
  for (const att of attachmentsMeta) {
    const entry = zipData.files[`${prefix}attachments/${att.id}-${att.fileName}`]
    if (entry) attachmentBlobs.set(att.id, await entry.async('arraybuffer'))
  }

  return {
    readme: Object.keys(readmeByLang).length ? readmeByLang : undefined,
    license: readLicense(meta.license, licenseText),
    attachmentsMeta,
    attachmentBlobs,
  }
}

/**
 * Split README paths back into a LocalizedString, the inverse of
 * `writeReadmeFiles`: the suffix-free file holds `readmeLang` (English unless the
 * entity JSON says otherwise) and `README.<lang>.md` names the others.
 *
 * `readmeLang` is what stops a French-only readme coming back as English — see
 * `readmeLangMeta`. A repo written before that marker existed simply has none, so
 * the suffix-free file reads as English exactly as it did then.
 *
 * Takes already-read text keyed by path, so it serves every caller regardless of
 * where the bytes came from — a JSZip walk (project import), a parsed clone
 * record (entity pull), or a plain map. One rule, three call sites.
 */
export function readReadmeByLang(
  textByPath: Record<string, string>,
  readmeLang?: string | null,
): LocalizedString | undefined {
  const byLang: LocalizedString = {}
  for (const [path, text] of Object.entries(textByPath)) {
    const m = README_FILE_RE.exec(path)
    if (m) byLang[m[1] ?? readmeLang ?? 'en'] = text
  }
  return Object.keys(byLang).length > 0 ? byLang : undefined
}

/** Whether a path inside an entity folder is one of the docs files the export owns. */
export function isEntityDocsFile(path: string): boolean {
  return README_FILE_RE.test(path) || /^LICENSE\.md$/i.test(path) || path.startsWith('attachments/')
}

/** README.md + LICENSE.md + attachments/ for one entity folder. */
async function writeEntityDocs(
  zip: JSZip,
  dir: string,
  entity: { readme?: LocalizedString | string; license?: EntityLicense },
  storage: Storage,
  ownerType: ReadmeOwnerType,
  ownerId: string,
): Promise<void> {
  writeReadmeFiles(zip, dir, entity.readme)
  writeLicenseFile(zip, dir, entity.license)
  await writeAttachmentFiles(zip, dir, storage, ownerType, ownerId)
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
  await storage.readmeAttachments.deleteByOwner('project', uid).catch(() => {})

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

  // Patient dashboards (+ tabs + widgets)
  const patientBoards = await safe(storage.patientDashboards.getByProject(uid), [])
  for (const d of patientBoards) {
    const tabs = await safe(storage.patientDashboardTabs.getByDashboard(d.id), [])
    for (const tab of tabs)
      await storage.patientDashboardWidgets.deleteByTab(tab.id).catch(() => {})
    await storage.patientDashboardTabs.deleteByDashboard(d.id).catch(() => {})
    await storage.patientDashboards.delete(d.id).catch(() => {})
  }

  // Pipelines & cohorts
  const pipelines = await safe(storage.pipelines.getByProject(uid), [])
  for (const pl of pipelines) await storage.pipelines.delete(pl.id).catch(() => {})
  const cohorts = await safe(storage.cohorts.getByProject(uid), [])
  for (const c of cohorts) await storage.cohorts.delete(c.id).catch(() => {})
  const conceptLists = await safe(storage.conceptLists.getByProject(uid), [])
  for (const l of conceptLists) await storage.conceptLists.delete(l.id).catch(() => {})
}


// ---------------------------------------------------------------------------
// Slugify
// ---------------------------------------------------------------------------

// Re-exported from `@linkr/format` rather than kept as a second copy: the two had
// already drifted on which combining marks they strip, and a slug computed two
// ways renames the file it keys.
export { slugify }

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
//   concept-lists/{slug}.json         — one file per user-authored concept list
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

/** Where a schema preset's DDL and mapping live, beside its entity.json. */
export const SCHEMA_PRESET_DDL_FILE = CONTENT_FILE.schemaDdl
export const SCHEMA_PRESET_MAPPING_FILE = CONTENT_FILE.schemaMapping

/**
 * Rebuild a preset's `SchemaMapping` from a split export.
 *
 * `mapping` moved out to its own file and lost four keys to the manifest root —
 * but `SchemaMapping` is what a DATABASE copies into its own row, where the
 * mapping is its only record of which schema it uses. `presetLabel` and
 * `presetId` are required there, so the reader puts them back and the asymmetry
 * stays confined to the export layer.
 *
 * `presetId` comes from `entityId`: they are the same value, which is exactly why
 * the export stopped writing it twice. An importer that mints a fresh local id
 * overrides it afterwards.
 *
 * `mappingFile` is undefined for a repo published before the split, where the
 * manifest still carries an inline `mapping` with those keys inside it.
 */
export function reassemblePresetMapping(
  meta: {
    entityId?: string
    presetId?: string
    name?: LocalizedString
    description?: LocalizedString
    mapping?: SchemaMapping
  },
  mappingFile: Partial<SchemaMapping> | undefined,
): SchemaMapping {
  const base = (mappingFile ?? meta.mapping ?? {}) as SchemaMapping
  return {
    ...base,
    presetId: base.presetId ?? meta.entityId ?? meta.presetId ?? '',
    presetLabel: base.presetLabel ?? meta.name ?? { en: '', fr: '' },
    ...(base.description ?? meta.description
      ? { description: base.description ?? meta.description }
      : {}),
  }
}

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
  return sharedDashboardKey(d.name, d.id)
}

// Dashboard tab/widget content keys now live in `@linkr/format` (src/keys.ts):
// the authoring serializer derives the same keys, and a key computed two
// different ways is not a cosmetic bug — a widget whose key drifts re-imports as
// a *different* widget, orphaning whatever pointed at it. The patient-dashboard
// helpers below stay local for now; they differ (flat tabs, own ordering rule)
// and have a byte-parity Python twin to keep in step.

/** Code-point order on the id, matching Python's `sorted(key=str)`. */
function byId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
}

// Patient-dashboard content keys — same scheme as the dashboard ones above, minus
// the sub-tab nesting (a patient board's tabs are a flat ordered list).

/** patientDashboardKey — slug of the English name, matching the export filename. */
function patientDashboardKey(d: PatientDashboard): string {
  return slugify(localized(d.name, 'en') || d.id)
}

/** Every tab id → `<boardKey>/<slug>`, `#<displayOrder>` on a sibling collision. */
function buildPatientTabKeyMap(
  boardKey: string,
  tabs: PatientDashboardTab[],
): Map<string, string> {
  const keyOf = new Map<string, string>()
  const seen = new Set<string>()
  // Fixed order: the `#` suffix that separates two same-named tabs is handed out
  // as we go, so iterating them in a different order gives the pair each other's
  // keys — swapped ids on reimport and a git diff with no change behind it. The
  // Python twin sorts identically.
  // Code-point order on the id, matching Python's str sort — localeCompare would
  // reorder ids differently per locale and reintroduce the drift on the tie-break.
  const ordered = [...tabs].sort((a, b) => {
    const byOrder = (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
    if (byOrder !== 0) return byOrder
    const x = String(a.id)
    const y = String(b.id)
    return x < y ? -1 : x > y ? 1 : 0
  })
  for (const tab of ordered) {
    const base = `${boardKey}/${slugify(localized(tab.name, 'en') || '')}`
    let key = base
    if (seen.has(key)) key = `${key}#${tab.displayOrder}`
    seen.add(key)
    keyOf.set(tab.id, key)
  }
  return keyOf
}

/** Every widget id → its key, qualified by tab key and disambiguated by grid
 *  position (widgets have no order field), then `#i` on a tie. */
function buildPatientWidgetKeyMap(
  tabKeyMap: Map<string, string>,
  widgets: PatientDashboardWidget[],
): Map<string, string> {
  const keyOf = new Map<string, string>()
  const seen = new Set<string>()
  for (const w of byId(widgets)) {
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
/**
 * A project's readable slug, under either of its two names.
 *
 * `entityId` is what every entity calls it; `projectId` is the same value under
 * its former name, still present on rows and repos written before the rename.
 */
export function projectSlug(p: { entityId?: string; projectId?: string }): string | undefined {
  return p.entityId ?? p.projectId
}

/** Do two projects carry the same readable slug? Matches across both names, so a
 *  repo published as `projectId` still recognises a row stored as `entityId`. */
export function sameProjectSlug(
  a: { entityId?: string; projectId?: string },
  b: { entityId?: string; projectId?: string },
): boolean {
  const left = projectSlug(a)
  return !!left && left === projectSlug(b)
}

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
  // `projectId` is the retired name of `entityId` — the same value written
  // twice. Every reader takes `entityId` first and falls back to it, so a repo
  // published before the rename still imports; nothing new needs to emit it.
  // (Same treatment as the preset's `presetId`.)
  const {
    readme: _r, todos: _t, notes: _n, uid: _uid, projectId: _retired,
    license: projectLicense, ...projectMeta
  } = prunedProject
  // `entityId` leads the file, carrying the slug under the name every entity
  // uses. Written explicitly rather than left to the spread: the server builder
  // emits it in this position and the shared golden fixture compares bytes.
  const projectSlug = project.entityId ?? project.projectId
  zip.file(ENTITY_MANIFEST, json({
    ...(projectSlug ? { entityId: projectSlug } : {}),
    type: 'project' as const,
    ...stripInstanceFields(projectMeta),
    ...(licenseMeta(projectLicense) ? { license: licenseMeta(projectLicense) } : {}),
    appVersion: APP_VERSION,
  }))

  // --- README.md (+ README.<lang>.md per extra language) ---
  writeReadmeFiles(zip, '', project.readme)

  // --- LICENSE.md ---
  writeLicenseFile(zip, '', projectLicense)

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

  // --- concept-lists/ ---
  // User-authored lists (distinct from workspace-scoped concept SETS, which are
  // imported data dictionaries and live in the workspace export).
  // Optional slice: partial storages (and pre-concept-list fixtures) omit it.
  const conceptLists = (await storage.conceptLists?.getByProject(projectUid)) ?? []
  for (const l of conceptLists) {
    // 'en' like every other export path: a file name must not depend on the
    // UI language, or the same project exports to different paths per user.
    const label = localized(l.name, 'en') || l.id
    zip.file(`concept-lists/${slugify(label)}.json`, json(stripInstanceFields(l)))
  }

  // --- databases/ (IDE connections) ---
  const connections = await storage.connections.getByProject(projectUid)
  for (const c of connections) {
    zip.file(`databases/${slugify(c.name || c.id)}.json`, json(stripInstanceFields(c)))
  }

  // Dataset ids as the export writes them (datasets/_tree.json, below), so widget and
  // analysis references can be checked against what the ZIP actually contains.
  const exportedDatasetIds = new Set(
    (await storage.datasetFiles.getByProject(projectUid)).map((f) => f.id),
  )

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
      // A widget can hold a datasetFileId that no longer names any dataset: configure it
      // front-only (ids are uuids), move the project to server mode (ids become paths),
      // and the reference is stale. Exporting it verbatim wrote a uuid into a ZIP whose
      // datasets/_tree.json is keyed by path, so the re-import silently produced a widget
      // pointing at nothing. Drop it instead: the widget then reads as unconfigured, which
      // is what it already is, and is fixable in one click.
      if (typeof out.datasetFileId === 'string' && !exportedDatasetIds.has(out.datasetFileId)) {
        delete out.datasetFileId
      }
      return { ...out, key, tabKey }
    }).sort((a, b) => compareCodePoints(a.tabKey, b.tabKey) || compareCodePoints(a.key, b.key))

    zip.file(
      `dashboards/${slugify(localized(d.name, 'en') || dashKey || d.id)}.json`,
      json({ dashboard: dashboardOut, tabs: tabsOut, widgets: widgetsOut }),
    )
  }

  // --- patient-dashboards/ (each board = board + tabs + widgets in one file) ---
  // Same content-key scheme as dashboards/ above, so a delete+reimport re-derives
  // the same ids and the git diff stays byte-stable.
  const patientBoards = (await storage.patientDashboards.getByProject(projectUid))
    .slice()
    .sort((a, b) => compareCodePoints(patientDashboardKey(a), patientDashboardKey(b)))
  for (const d of patientBoards) {
    const tabs = await storage.patientDashboardTabs.getByDashboard(d.id)
    const widgets: PatientDashboardWidget[] = []
    for (const tab of tabs) {
      widgets.push(...(await storage.patientDashboardWidgets.getByTab(tab.id)))
    }
    const boardKey = patientDashboardKey(d)
    const tabKeyMap = buildPatientTabKeyMap(boardKey, tabs)
    const widgetKeyMap = buildPatientWidgetKeyMap(tabKeyMap, widgets)

    const boardOut = stripInstanceFields(d) as Record<string, unknown>
    delete boardOut.id
    // projectUid is the parent's local PK (regenerated on reimport); import re-sets it.
    delete boardOut.projectUid

    const tabsOut = tabs
      .map((tab) => {
        const out = stripInstanceFields(tab) as Record<string, unknown>
        const key = tabKeyMap.get(tab.id)!
        delete out.id
        delete out.patientDashboardId
        return { ...out, key }
      })
      .sort((a, b) => compareCodePoints(a.key, b.key))

    const widgetsOut = widgets
      .map((w) => {
        const out = stripInstanceFields(w) as Record<string, unknown>
        const key = widgetKeyMap.get(w.id)!
        const tabKey = tabKeyMap.get(w.tabId)!
        delete out.id
        delete out.tabId
        return { ...out, key, tabKey }
      })
      .sort((a, b) => compareCodePoints(a.tabKey, b.tabKey) || compareCodePoints(a.key, b.key))

    zip.file(
      `patient-dashboards/${slugify(localized(d.name, 'en') || boardKey || d.id)}.json`,
      json({ patientDashboard: boardOut, tabs: tabsOut, widgets: widgetsOut }),
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
  await writeAttachmentFiles(zip, '', storage, 'project', projectUid)

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
  await attachEntityOrganization(zip, ENTITY_MANIFEST, project, storage)

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
export type ParsedPatientDashboardTab = PatientDashboardTab & { key?: string }
export type ParsedPatientDashboardWidget = PatientDashboardWidget & {
  key?: string
  tabKey?: string
}

export interface ParsedProjectZip {
  project: Project
  /** Format issues found in the incoming tree. Reported to the user, never
   *  blocking: the reads below are deliberately tolerant, so a legacy-but-working
   *  export must keep importing. Absent when the caller hand-built this object. */
  validation?: Issue[]
  /** Organization inherited from the parent workspace, bundled by UUID for cross-instance upsert. */
  organization?: Organization
  /** Path-keyed IDE tree nodes; local ids are derived from the target projectUid
   *  at import (attachTreeIds), not carried by the export. */
  ideFiles: TreeImportNode[]
  pipelines: Pipeline[]
  cohorts: Cohort[]
  conceptLists: ConceptList[]
  connections: IdeConnection[]
  dashboards: Dashboard[]
  dashboardTabs: ParsedDashboardTab[]
  dashboardWidgets: ParsedDashboardWidget[]
  /** Optional section: ZIPs exported before patient boards existed have none, and
   *  callers that hand-build a ParsedProjectZip (tests, pull) may omit it. */
  patientDashboards?: PatientDashboard[]
  patientDashboardTabs?: ParsedPatientDashboardTab[]
  patientDashboardWidgets?: ParsedPatientDashboardWidget[]
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
  | 'conceptLists'
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
      conceptLists: wants('conceptLists') ? (parsed.conceptLists ?? []) : [],
      dashboards: wants('dashboards') ? parsed.dashboards : [],
      dashboardTabs: wants('dashboards') ? parsed.dashboardTabs : [],
      dashboardWidgets: wants('dashboards') ? parsed.dashboardWidgets : [],
      datasetFiles: wants('datasets') ? parsed.datasetFiles : [],
      datasetData: wants('datasets') ? parsed.datasetData : [],
      datasetRawFiles: wants('datasets') ? parsed.datasetRawFiles : [],
      datasetAnalyses: wants('datasets') ? parsed.datasetAnalyses : [],
      // Patient boards have no pull group yet, so a selective pull carries them
      // through unfiltered (as a full import does) rather than dropping them.
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
  // Optional section: ZIPs exported before concept lists existed have no
  // `concept-lists/` folder, so the parser yields nothing here.
  for (const l of parsed.conceptLists ?? []) {
    await storage.conceptLists.create({ ...l, id: mapId(l.id), projectUid })
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
  // Patient boards: same key scheme, flat tabs (no parentKey). Optional section —
  // ZIPs exported before patient boards existed yield nothing here.
  const patientBoardKeyToId = new Map(
    (parsed.patientDashboards ?? []).map((d) => [
      patientDashboardKey(d),
      keyId(patientDashboardKey(d)),
    ]),
  )
  const patientTabKeyToId = new Map(
    (parsed.patientDashboardTabs ?? [])
      .filter((t) => t.key)
      .map((t) => [t.key!, keyId(t.key!)]),
  )
  const patientBoardIdForTabKey = (tabKey: string): string =>
    patientBoardKeyToId.get(tabKey.split('/')[0]) ?? keyId(tabKey.split('/')[0])

  for (const d of parsed.patientDashboards ?? []) {
    await storage.patientDashboards.create(
      dropForeignAuthorId({
        ...d,
        id: d.id ? mapId(d.id) : keyId(patientDashboardKey(d)),
        projectUid,
      }),
    )
  }
  for (const tab of parsed.patientDashboardTabs ?? []) {
    const { key, ...rest } = tab
    await storage.patientDashboardTabs.create(
      key
        ? { ...rest, id: keyId(key), patientDashboardId: patientBoardIdForTabKey(key) }
        : {
            ...rest,
            id: mapId(tab.id),
            patientDashboardId: mapId(tab.patientDashboardId),
          },
    )
  }
  for (const w of parsed.patientDashboardWidgets ?? []) {
    const { key, tabKey, ...rest } = w
    await storage.patientDashboardWidgets.create({
      ...rest,
      id: key ? keyId(key) : mapId(w.id),
      tabId: tabKey ? (patientTabKeyToId.get(tabKey) ?? keyId(tabKey)) : mapId(w.tabId),
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
  const attachmentWorkspaceId = parsed.attachmentsMeta.length
    ? (await storage.projects.getById(projectUid).catch(() => undefined))?.workspaceId
    : undefined
  for (const meta of parsed.attachmentsMeta) {
    const blobData = parsed.attachmentBlobs.get(meta.id)
    if (blobData) {
      await storage.readmeAttachments.create({
        ...meta,
        id: mapId(meta.id),
        ownerType: 'project',
        ownerId: projectUid,
        workspaceId: attachmentWorkspaceId,
        data: blobData,
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
  const projectFile = zipData.files[ENTITY_MANIFEST] ?? zipData.files[MANIFEST.project]
  if (!projectFile) return null
  const projectRaw = JSON.parse(await projectFile.async('string'))
  // Clean git-versioned exports strip `uid` (the local PK) and identify the project
  // by its stable `projectId` (and `lineageId` when it has one); the target uid is
  // supplied by the caller, not read here. Accept any of the three as proof that
  // this is a real project.json — `lineageId` alone is often null on a fresh export.
  if (!projectRaw || (!projectRaw.uid && !projectRaw.entityId && !projectRaw.projectId && !projectRaw.lineageId)) return null
  // Strip export-only fields
  const { appVersion: _av, ...projectMeta } = projectRaw as Project & { appVersion?: string }

  // Organization provenance snapshot: for a standalone project ZIP it's inlined
  // on project.json (project.organization). A legacy root organization.json is
  // still honored as a fallback. The snapshot stays on projectMeta so it's kept
  // as immutable provenance on the imported record (like createdByDetails) — it
  // is NOT re-linked to a local org entity.
  if (!projectMeta.organization) {
    const orgFile = zipData.files[ROOT_FILE.organization]
    if (orgFile) projectMeta.organization = JSON.parse(await orgFile.async('string')) as Organization
  }
  const organization = projectMeta.organization as Organization | undefined

  // Reconstruct readme (README.md holds readmeLang, README.<lang>.md the others)
  const readmeTexts: Record<string, string> = {}
  for (const [path, file] of Object.entries(zipData.files)) {
    if (README_FILE_RE.test(path)) readmeTexts[path] = await file.async('string')
  }
  // `readmeLang` is an export-only marker: it says which language the suffix-free
  // README.md holds, and must not survive onto the imported record.
  const withLang = projectMeta as typeof projectMeta & { readmeLang?: string }
  const readmeLang = withLang.readmeLang
  delete withLang.readmeLang
  const readmeByLang = readReadmeByLang(readmeTexts, readmeLang)
  if (readmeByLang) {
    projectMeta.readme = readmeByLang
  }
  const projectLicenseFile = zipData.files['LICENSE.md']
  if (projectLicenseFile) {
    projectMeta.license = readLicense(
      projectMeta.license as { id?: string; name?: string } | undefined,
      await projectLicenseFile.async('string'),
    )
  }
  const tasksFile = zipData.files['tasks.json']
  if (tasksFile) {
    const tasks = JSON.parse(await tasksFile.async('string'))
    projectMeta.todos = normalizeImportedTodos(tasks.todos)
    projectMeta.notes = toLocalized(tasks.notes)
  }

  const parsed = await parseNewLayout(zipData, projectMeta)
  // Runs on the same stripped ZIP the parse above read, so what is validated is
  // exactly what is imported. Never throws and never blocks — see ParsedProjectZip.
  const validation = await validateImportZip(zipData).catch(() => null)
  return { ...parsed, organization, ...(validation ? { validation: validation.issues } : {}) }
}

async function readJsonFile<T>(zip: JSZip, path: string): Promise<T | null> {
  const entry = zip.files[path]
  if (!entry) return null
  return JSON.parse(await entry.async('string')) as T
}

/**
 * Read an entity's manifest, accepting the shared `entity.json` or the kind's
 * historical filename.
 *
 * Readers stay tolerant permanently: it is a handful of lines here, and it is
 * what lets every already-published repo keep importing after the format flip.
 * Writers are NOT tolerant — one format out, no flag.
 */
async function readEntityManifest<T>(
  zip: JSZip,
  prefix: string,
  kind: LayoutKind,
  ...extraNames: string[]
): Promise<T | null> {
  for (const name of [ENTITY_MANIFEST, MANIFEST[kind], ...extraNames]) {
    const found = await readJsonFile<T>(zip, `${prefix}${name}`)
    if (found) return found
  }
  return null
}

/**
 * The immediate sub-folder names under `section` (e.g. `catalogs/`).
 *
 * Sections list their entities by folder, never by globbing `*.json`: a folder
 * holds a manifest AND its payload (checks.json, mapping.json, …), so a glob
 * ingests those as extra, phantom entities. Reading the manifest by name is what
 * keeps one folder = one entity.
 */
function entityFolders(zip: JSZip, section: string): Set<string> {
  const folders = new Set<string>()
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith(section)) continue
    const name = path.slice(section.length).split('/')[0]
    if (name && path.length > section.length + name.length) folders.add(name)
  }
  return folders
}

/**
 * An entity's file tree, from `scripts/` or from the entity root.
 *
 * Exports write the tree under `scripts/`; repos published before that keep it at
 * the root with the files scattered beside it. Returning the prefix the tree was
 * found under is what lets the caller resolve each file's real path either way.
 */
async function readScriptTree(
  zip: JSZip,
  prefix: string,
): Promise<{ nodes: TreeImportNode[]; filePrefix: string }> {
  const scripts = `${prefix}${SCRIPTS_DIR}/`
  const inScripts = await readJsonFile(zip, `${scripts}${SIDECAR.tree}`)
  if (inScripts) return { nodes: readPathTree(inScripts), filePrefix: scripts }
  return {
    nodes: readPathTree(await readJsonFile(zip, `${prefix}${SIDECAR.tree}`)),
    filePrefix: prefix,
  }
}

/**
 * Stamp an entity's `type` into its exported metadata, right after the identity
 * keys and before the rest.
 *
 * Kind used to be inferred from the manifest's filename, which cannot survive
 * one shared `entity.json`. Declaring it makes detection a field read — and
 * retires the `mappings.json` heuristic that told a mapping project from a plain
 * one. Position matters: the golden tests compare bytes, so it goes where the
 * Python twin puts it.
 */
/**
 * The provenance block, in the order every kind writes it.
 *
 * Ordered by what it answers: *when* it was made (`createdAt`), *by whom*
 * (`createdBy`, `createdByDetails`, `organization`), *from what*
 * (`lineageId`, `parentLineageId`), and *how it is published* (`version`,
 * `license`). Kept contiguous and last so the stable identity leads the file and
 * the churn collects at the bottom — which is what makes a diff readable.
 *
 * `organization` sits with the author, not with `version`/`license`, because it
 * is co-authorship rather than packaging: the Edit dialog's authoring section
 * (`authoring-fields.tsx`, "author + organization") edits the two together, and
 * `AuthoringValue` groups them in one type. It used to trail the block only
 * because `attachEntityOrganization` re-opens the file and appending was what a
 * plain assignment did.
 *
 * `appVersion` is deliberately NOT here: it is the format version of the whole
 * file rather than provenance, so it trails the block.
 */
const PROVENANCE_ORDER = [
  'createdAt', 'createdBy', 'createdByDetails', 'organization',
  'lineageId', 'parentLineageId', 'version', 'license',
] as const

/**
 * Move the provenance keys to the end, in the canonical order.
 *
 * Writers build their manifests in whatever order the record happened to carry,
 * which is why a project used to emit lineage before its author and `version`
 * before `createdAt`, and an ETL pipeline left `config` — payload — sitting in
 * the middle of the block. Anything not named here keeps its relative position
 * ahead of the block, so each kind's own payload stays where its writer put it.
 */
export function orderProvenance(meta: Record<string, unknown>): Record<string, unknown> {
  const provenance = new Set<string>(PROVENANCE_ORDER)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (!provenance.has(key)) out[key] = value
  }
  for (const key of PROVENANCE_ORDER) {
    if (key in meta) out[key] = meta[key]
  }
  return out
}

function withEntityType<T extends Record<string, unknown>>(
  meta: T,
  type: LayoutKind,
  /**
   * Stamp `appVersion` at the end. True for the kinds whose `organization` is
   * appended afterwards by `attachEntityOrganization` (so the stamp still ends
   * up just before it); false for a caller that writes both itself, since
   * re-assigning an existing key keeps its ORIGINAL position and would strand
   * the stamp mid-block.
   */
  stampVersion = true,
): Record<string, unknown> {
  // `id` never travels: it is the WRITING instance's local primary key, and an
  // importer either mints its own or keeps the row it already has. Where the
  // catalog install does adopt it, that is convenience, not identity —
  // `isSameEntity` matches on `lineageId` or the git remote and treats a shared
  // id as a hazard to defend against. `entityId` is the portable slug, and
  // `lineageId` the cross-instance identity; `id` had no third job.
  const { id: _localKey, entityId, ...rest } = meta
  return {
    ...(entityId !== undefined ? { entityId } : {}),
    type,
    ...orderProvenance(rest),
    // The export-format version belongs on every entity, not just the three that
    // happened to write it — a reader needs to know which format version produced
    // a tree whatever kind it is.
    ...(stampVersion ? { appVersion: APP_VERSION } : {}),
  }
}

/**
 * The manifest of a git-linked entity: identity + the pointer, nothing else.
 *
 * The linked repo's own `entity.json` is the source of truth for every other
 * field, so a workspace tree keeps only what it needs to create the record and
 * clone it. One helper because the five pointer writers had drifted into five
 * different shapes — one still nested its payload, two still wrote a retired id
 * field, and none declared `type`.
 *
 * `lineageId` rides along even when null: it is the cross-instance identity the
 * import matches on (`resolveByLineage`), so a pointer without it re-imports as
 * a duplicate rather than an update.
 */
function gitPointerManifest(
  type: LayoutKind,
  identity: {
    entityId?: string
    name?: unknown
    createdAt?: string | null
    lineageId?: string | null
    /** Projects only: the routing key, which is not derivable from the slug. */
    uid?: string
  },
  git: { url: string; branch: string },
): Record<string, unknown> {
  return {
    ...(identity.uid !== undefined ? { uid: identity.uid } : {}),
    ...(identity.entityId !== undefined ? { entityId: identity.entityId } : {}),
    type,
    ...(identity.name !== undefined ? { name: identity.name } : {}),
    // Omitted when absent rather than written as null: Python emits `null` for a
    // missing value while JSON.stringify drops an undefined key, and the golden
    // tests compare the two byte for byte.
    ...(identity.createdAt ? { createdAt: identity.createdAt } : {}),
    lineageId: identity.lineageId ?? null,
    gitRemoteConfig: git,
  }
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

  const conceptLists: ConceptList[] = []
  for (const [path, entry] of scanFolder(zip, 'concept-lists/')) {
    if (path.endsWith('.json')) {
      conceptLists.push(JSON.parse(await entry.async('string')))
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

  // --- Patient dashboards (each file = board + tabs + widgets) ---
  // `patient-dashboards/` does not start with `dashboards/`, so the scan above
  // does not pick these up.
  const patientDashboards: PatientDashboard[] = []
  const patientDashboardTabs: ParsedPatientDashboardTab[] = []
  const patientDashboardWidgets: ParsedPatientDashboardWidget[] = []
  for (const [path, entry] of scanFolder(zip, 'patient-dashboards/')) {
    if (path.endsWith('.json')) {
      const bundle = JSON.parse(await entry.async('string')) as {
        patientDashboard: PatientDashboard
        tabs: ParsedPatientDashboardTab[]
        widgets: ParsedPatientDashboardWidget[]
      }
      patientDashboards.push(bundle.patientDashboard)
      patientDashboardTabs.push(...(bundle.tabs ?? []))
      patientDashboardWidgets.push(...(bundle.widgets ?? []))
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
        if (rest === '_columns.json' || rest === '_data.json' || rest === SIDECAR.tree) continue
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
    project, ideFiles, pipelines, cohorts, conceptLists, connections,
    dashboards, dashboardTabs, dashboardWidgets,
    patientDashboards, patientDashboardTabs, patientDashboardWidgets,
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
  /**
   * Per-entity opt-out: when an entity id maps to true, that entity is omitted from the
   * export entirely (no metadata, no git-link entry). Entities are included by default.
   * Keyed by the entity's stable id (project.uid, mappingProject.id, sqlCollection.id,
   * etlPipeline.id, dataSource.id, schemaPreset.presetId, …).
   */
  excludeEntities?: Record<string, boolean>
}

/** A single git-linked entity recorded in the workspace's git-links.json manifest.
 *
 *  No `id`: entity ids are instance-local and re-minted on import (entity.json
 *  stopped carrying them for the same reason), so exporting one wrote a value
 *  that changed on every round trip. The portal's sync-git-links.sh reads only
 *  type/folder/url/branch, and nothing in this repo reads the file back. */
export interface GitLinkEntry {
  type: 'project' | 'mapping-project' | 'sql-collection' | 'etl-pipeline' | 'data-catalog' | 'dq-rule-set' | 'schema-preset' | 'database'
  /** Folder name used inside the workspace zip (projectId / entityId / slug). */
  folder: string
  url: string
  branch: string
  /** Sort key only — stripped before the file is written. `lineageId` is the
   *  cross-instance identity, so it holds still where an id does not. */
  lineageId?: string | null
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
 * Lay out a database in a git-friendly tree under `prefix`: `entity.json`
 * (metadata), `mapping.json` + `schema.ddl` (its schema mapping, split so the DDL
 * is readable and diffable), `README.md`, `LICENSE.md`, `attachments/`.
 *
 * Metadata only, and deliberately so. `connectionConfig` is reduced to what
 * `sanitizeConnectionConfig` allows (no host, no credentials, no local file
 * reference) and not a single row is written. A shared database repo — an open
 * dataset such as the MIMIC-IV demo — gets its data added by hand, outside the
 * app, so the app can never be the path by which patient data leaves.
 */
export async function buildDataSourceFolder(
  zip: JSZip,
  prefix: string,
  source: DataSource,
  storage: Storage,
): Promise<void> {
  const { connectionConfig, schemaMapping, ...rest } = stripInstanceFields(source) as unknown as Record<string, unknown>
  const meta = {
    ...stripEntityDocs(rest as unknown as DataSource),
    connectionConfig: connectionConfig
      ? sanitizeConnectionConfig(connectionConfig as Record<string, unknown>)
      : undefined,
  }
  zip.file(`${prefix}${ENTITY_MANIFEST}`, json(withEntityType(meta, 'database')))
  // The mapping and its DDL live beside the manifest, exactly as a schema preset
  // writes them: identity and provenance in `entity.json`, payload in files a
  // human can read and git can diff. A database's copy KEEPS the four fields the
  // preset's own export drops (presetLabel, description, presetId, templateId) —
  // there the mapping is this database's only record of which schema it uses.
  if (schemaMapping) {
    const { ddl, ...mapping } = schemaMapping as Record<string, unknown>
    zip.file(`${prefix}${SCHEMA_PRESET_MAPPING_FILE}`, json(canonicalSchemaMapping(mapping)))
    if (typeof ddl === 'string' && ddl) zip.file(`${prefix}${SCHEMA_PRESET_DDL_FILE}`, ddl)
  }
  await writeEntityDocs(zip, prefix, source, storage, 'data-source', source.id)
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
  zip.file(`${prefix}${ENTITY_MANIFEST}`, json(withEntityType(stripEntityDocs(stripInstanceFields(collection) as SqlScriptCollection), 'sql-collection')))
  await writeEntityDocs(zip, prefix, collection, storage, 'sql-collection', collection.id)
  const files = await storage.sqlScriptFiles.getByCollection(collection.id)
  const byId = new Map<string, TreeNode>(files.map(f => [f.id, f]))
  // Per-file versioning marks (collection.config), same rule and same reasoning
  // as buildEtlPipelineFolder: a file the user unmarked leaves the tree as well
  // as the zip. `_tree.json` naming a file the repo cannot contain breaks
  // re-import and makes every pull offer the phantom as an incoming change.
  //
  // Inlined rather than imported from lib/entity-versioning (`isVersioned`):
  // that module imports isDataExtension from HERE, so the import would be a
  // cycle. entity-io.test.ts asserts the two agree.
  const kept = files.filter(
    (f) => f.type !== 'file'
      || !(collection.config?.excludedFiles ?? []).includes(treeNodePath(f, byId)),
  )
  // The user's tree lives under scripts/, so its sidecar sits beside the files it
  // describes instead of at the entity root (where it had to be when the files
  // were scattered across it).
  const scripts = `${prefix}${SCRIPTS_DIR}/`
  zip.file(`${scripts}${SIDECAR.tree}`, json(toPathTree(kept, 'collectionId')))
  for (const f of kept) {
    if (f.type === 'file' && f.content != null) {
      zip.file(`${scripts}${treeNodePath(f, byId)}`, f.content)
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
  if (!org) return
  const entry = zip.files[metaPath]
  // A missing entry means the caller named a file this zip does not contain —
  // always a bug, and one that used to pass silently: two call sites kept asking
  // for `project.json` after the manifest rename, so every export they produced
  // quietly lost its publishing organization.
  if (!entry) throw new Error(`attachEntityOrganization: no ${metaPath} in the export`)
  const meta = JSON.parse(await entry.async('string')) as Record<string, unknown>
  // Re-ordered rather than assigned, so `organization` lands beside the author it
  // belongs with. Assigning appends (the key is new), which is the only reason it
  // used to trail the whole file — an artifact of re-opening it here, never a
  // decision. `appVersion` stays last: it is the format version of the file, not
  // part of the provenance.
  const { appVersion, ...rest } = meta
  zip.file(metaPath, json({
    ...orderProvenance({ ...rest, organization: orgSnapshot(org) }),
    ...(appVersion !== undefined ? { appVersion } : {}),
  }))
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
  await attachEntityOrganization(zip, ENTITY_MANIFEST, collection, storage)
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
  await attachEntityOrganization(zip, ENTITY_MANIFEST, pipeline, storage)
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
  storage: Storage,
): Promise<void> {
  zip.file(`${prefix}${ENTITY_MANIFEST}`, json(withEntityType(stripEntityDocs(stripInstanceFields(catalog) as DataCatalog), 'data-catalog')))
  await writeEntityDocs(zip, prefix, catalog, storage, 'data-catalog', catalog.id)
}

export async function buildDataCatalogZip(
  catalogId: string,
  storage: Storage,
  options: { lfsOverrides?: Map<string, boolean> } = {},
): Promise<{ blob: Blob; name: string } | null> {
  const catalog = await storage.dataCatalogs.getById(catalogId)
  if (!catalog) return null
  const zip = new JSZip()
  await buildDataCatalogFolder(zip, '', catalog, storage)
  await attachEntityOrganization(zip, ENTITY_MANIFEST, catalog, storage)
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
  zip.file(`${prefix}${ENTITY_MANIFEST}`, json(withEntityType(stripEntityDocs(stripInstanceFields(ruleSet) as DqRuleSet), 'dq-rule-set')))
  await writeEntityDocs(zip, prefix, ruleSet, storage, 'dq-rule-set', ruleSet.id)
  const checks = await storage.dqCustomChecks.getByRuleSet(ruleSet.id)
  if (checks.length > 0) zip.file(`${prefix}${CONTENT_FILE.dqChecks}`, json(checks))
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
  await attachEntityOrganization(zip, ENTITY_MANIFEST, ruleSet, storage)
  const blob = await finalizeEntityZip(zip, options.lfsOverrides)
  return { blob, name: localized(ruleSet.name, 'en') || ruleSet.id }
}

/**
 * Folder layout for one schema preset's git repo: its mapping config (stripped)
 * plus the DDL as a real `.ddl` file. Keyed on presetId (its primary key), not id.
 *
 * The DDL is split out rather than left inline in preset.json: it is ~50 kB of
 * SQL, and as a JSON string it lands on one line with every newline escaped —
 * a one-column type change then shows up as a whole-file diff nobody can read,
 * and no editor will syntax-highlight it. `preset.json` keeps the mapping
 * config, which is structured JSON and already diffs line by line.
 */
/**
 * Canonical mapping order lives in `@linkr/format` so the authoring writer emits
 * the same bytes this export does — re-exported here because it is part of this
 * module's public surface and its tests live alongside the other export tests.
 * The Python twin (`_canonical_schema_mapping`) still has to match.
 */
export { canonicalSchemaMapping }

export async function buildSchemaPresetFolder(
  zip: JSZip,
  prefix: string,
  preset: CustomSchemaPreset,
  storage: Storage,
): Promise<void> {
  const stripped = stripEntityDocs(stripInstanceFields(preset) as CustomSchemaPreset)
  const { ddl, ...mapping } = stripped.mapping
  // `presetId` is the retired identity. Writing it kept three fields alive for
  // two roles. Trees that carry one are still read — the importer falls back to
  // it — but nothing new emits it.
  const { id: _localKey, presetId: _retired, mapping: _payload, ...portable } = stripped
  // The identity block leads, in the order every kind uses. Spreading `portable`
  // first would keep whatever position `entityId` already held in the record and
  // push the rest to the end.
  // `appVersion` is dropped and re-added last: it describes the FILE, not the
  // entity, but an imported row keeps whatever the manifest carried. Re-assigning
  // an existing key keeps its original position, which would strand the stamp
  // mid-block on the next export and show as a diff with no content change.
  const { entityId: _slug, appVersion: _stamp, ...presetRest } = portable as Record<string, unknown>
  zip.file(`${prefix}${ENTITY_MANIFEST}`, json({
    entityId: preset.entityId ?? preset.presetId,
    type: 'schema-preset' as const,
    // A preset used to carry its label and blurb INSIDE `mapping`, where no
    // generic reader looks — the catalog scanner, the validator and the portal
    // all read `name`/`description` from the root for the other eight kinds and
    // had to special-case this one. They are the entity's, so they rise here.
    name: mapping.presetLabel ?? null,
    description: mapping.description ?? null,
    // Through orderProvenance like every other kind. Spreading the record's own
    // key order instead made the manifest depend on how the ROW happened to be
    // built: a freshly imported preset put `license` after `appVersion` where the
    // original had it before, so export → import → re-export produced a diff with
    // no content change in it.
    ...orderProvenance(presetRest),
    appVersion: APP_VERSION,
  }))
  // `mapping` is 83% of what this file used to be — identity buried under
  // payload, in the file a human opens first on the forge. The preset already
  // externalised its DDL for exactly this reason and simply stopped halfway.
  //
  // Four fields are dropped HERE only, in the preset's OWN export — a database
  // that copies this mapping keeps them, because there the mapping is that
  // database's only record of which schema it uses:
  //
  //   presetLabel, description — the entity's name and blurb; the root carries them.
  //   presetId                 — `entityId` under its former name, one level down.
  //                              Keeping it forced the export and the install to
  //                              re-sync the two by hand on every write.
  //   templateId               — the built-in preset a schema was created from,
  //                              back when the app shipped a picker of them. No
  //                              code has read it since; schemas are published
  //                              repos now, so it froze a dead reference into
  //                              every export.
  const {
    presetLabel: _label, description: _blurb, presetId: _retiredId, templateId: _dead,
    ...mappingPayload
  } = mapping
  zip.file(`${prefix}${SCHEMA_PRESET_MAPPING_FILE}`, json(canonicalSchemaMapping(mappingPayload)))
  if (ddl) zip.file(`${prefix}${SCHEMA_PRESET_DDL_FILE}`, ddl)
  // `organization` is an INSTANCE_FIELD, stripped above; every other entity puts
  // its provenance snapshot back here. A preset did not, so each re-export
  // silently dropped the publishing organization from the repo.
  await attachEntityOrganization(zip, `${prefix}${ENTITY_MANIFEST}`, preset, storage)
  await writeEntityDocs(zip, prefix, preset, storage, 'schema-preset', preset.entityId ?? preset.id)
}

export async function buildSchemaPresetZip(
  presetId: string,
  storage: Storage,
  options: { lfsOverrides?: Map<string, boolean> } = {},
): Promise<{ blob: Blob; name: string } | null> {
  const preset = await storage.schemaPresets.getById(presetId)
  if (!preset) return null
  const zip = new JSZip()
  await buildSchemaPresetFolder(zip, '', preset, storage)
  const blob = await finalizeEntityZip(zip, options.lfsOverrides)
  return { blob, name: preset.entityId ?? preset.id }
}

/** Folder layout for one user plugin's git repo: a metadata pointer plus each
 *  source file (filename → code) at the root, mirroring the workspace export. */
export async function buildUserPluginFolder(
  zip: JSZip,
  prefix: string,
  plugin: UserPlugin,
  storage: Storage,
): Promise<void> {
  // Author provenance rides along like every other entity: createdBy + full
  // createdByDetails travel, createdById does not (a local id is meaningless
  // cross-instance — see stripInstanceFields / INSTANCE_FIELDS for projects).
  // `name`/`description` are DERIVED from the bundled plugin.json rather than
  // stored on the row: a plugin names itself in its own functional manifest, and
  // duplicating that onto the entity would give two sources of truth to keep in
  // step. Every other kind carries them, so a generic reader finds them here too.
  const manifest = pluginManifest(plugin)
  // Through withEntityType like every other kind, rather than a hand-ordered
  // literal: this one wrote its provenance block in its own order (createdAt
  // after createdByDetails), which the server port — which does use the shared
  // helper — could never reproduce, so the two ends disagreed byte for byte.
  zip.file(`${prefix}${ENTITY_MANIFEST}`, json(withEntityType({
    entityId: plugin.entityId ?? null,
    name: manifest.name ?? null,
    description: manifest.description ?? null,
    createdBy: plugin.createdBy,
    createdByDetails: plugin.createdByDetails,
    // Provenance, like every other exportable entity: without the lineage a
    // published plugin was identifiable only by its git URL, and a fork recorded
    // nothing about where it came from.
    ...(plugin.lineageId ? { lineageId: plugin.lineageId } : {}),
    ...(plugin.parentLineageId ? { parentLineageId: plugin.parentLineageId } : {}),
    ...(plugin.createdAt ? { createdAt: plugin.createdAt } : {}),
    version: plugin.version ?? '0.1.0',
    // The licence's identity, as every other entity writes it — its text travels
    // as LICENSE.md. Writing the file without this block lost which licence it
    // was on every round trip.
    ...(licenseMeta(plugin.license) ? { license: licenseMeta(plugin.license) } : {}),
  }, 'user-plugin')))
  await writeEntityDocs(zip, prefix, plugin, storage, 'user-plugin', plugin.id)
  for (const [filename, content] of Object.entries(plugin.files)) {
    // README.md / LICENSE.md are the entity's own fields (written above); a stale
    // copy inside `files` would overwrite them.
    if (isEntityDocsFile(filename)) continue
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
  await buildUserPluginFolder(zip, '', plugin, storage)
  // Inline the origin organization (full snapshot) so a single-plugin ZIP is
  // self-sufficient, matching single-project export.
  await attachEntityOrganization(zip, ENTITY_MANIFEST, plugin, storage)
  const blob = await finalizeEntityZip(zip, options.lfsOverrides)
  return { blob, name: plugin.entityId || plugin.id }
}

/**
 * Reconstruct tree nodes (SqlScriptFile / EtlFile) from a parsed import ZIP using
 * the git-friendly layout (`_tree.json` keyed by path + raw files at those paths).
 * `parsed` keys are zip paths relative to the collection/pipeline root (after any
 * prefix is stripped by the caller). Folders carry no content.
 *
 * A file the tree declares but the ZIP has no blob for is dropped: data files are
 * gitignored unless marked for versioning, so a repo legitimately carries a tree
 * entry with no content behind it. Importing those produced empty files the user
 * never had — a phantom `mapping/source_to_concept_map.csv`. Folders are kept
 * (having no content is what they are), and so are legacy nodes carrying inline
 * content, which never had a raw file beside them.
 *
 * Nodes come back carrying their `path` but NO id: the caller only knows the
 * target collection/pipeline id (which namespaces the derived ids) once the
 * user has resolved an import conflict. Finish with `attachTreeIds`.
 */
export type TreeImportNode = PathNode & { content?: string }

export function reconstructTreeFiles(
  tree: unknown,
  parsed: Record<string, unknown>,
  /**
   * Where the tree's files physically live. Empty for a project's scripts (which
   * are keyed by their full path) and for the pre-`scripts/` layout; `scripts/`
   * for a collection or pipeline written since the folder move. A node the
   * prefix does not resolve falls back to the bare path, so one call reads both.
   */
  filePrefix = '',
): TreeImportNode[] {
  const out: TreeImportNode[] = []
  for (const node of readPathTree(tree)) {
    if (node.type !== 'file') { out.push(node); continue }
    const raw = parsed[`${filePrefix}${node.path}`] ?? parsed[node.path]
    if (raw === undefined) {
      // No blob in the ZIP. The oldest layout (files.json) carried content inline
      // on the node, so keep those; otherwise the tree is declaring a file the
      // repo does not have and there is nothing to import.
      if ((node as TreeImportNode).content != null) out.push(node)
      continue
    }
    // A `.json` file in the tree comes back parsed, not as a string.
    out.push({ ...node, content: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2) })
  }
  return out
}

/**
 * The entity metadata in a parsed import ZIP, whatever the layout named it.
 *
 * Tries `entity.json`, then the kind's own former manifest, then any extra
 * legacy names. Every importer used to spell this chain out inline, which is how
 * the `scripts/` move slipped past them: the duplicate button re-imports the
 * export it just wrote, so a name the writer had moved on from broke duplication
 * of an entity the user already had, not merely third-party ZIPs.
 */
export function readImportedManifest<T>(
  parsed: Record<string, unknown>,
  kind: LayoutKind,
  ...legacyNames: string[]
): T | undefined {
  for (const name of [ENTITY_MANIFEST, MANIFEST[kind], ...legacyNames]) {
    const found = parsed[name]
    if (found !== undefined) return found as T
  }
  return undefined
}

/**
 * A parsed ZIP's file tree plus the prefix its files sit behind — `scripts/`
 * since the folder move, empty in every layout before it.
 */
export function readImportedTree(
  parsed: Record<string, unknown>,
  ...legacyNames: string[]
): { tree: unknown; filePrefix: string } {
  const inScripts = parsed[`${SCRIPTS_DIR}/${SIDECAR.tree}`]
  if (inScripts !== undefined) return { tree: inScripts, filePrefix: `${SCRIPTS_DIR}/` }
  for (const name of [SIDECAR.tree, ...legacyNames]) {
    if (parsed[name] !== undefined) return { tree: parsed[name], filePrefix: '' }
  }
  return { tree: undefined, filePrefix: '' }
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

/** `_database.json` as a database repo publishes it (see @linkr/format serializeDatabase). */
interface DatabaseRepoMeta {
  id?: string
  alias?: string
  name?: LocalizedString | string
  description?: LocalizedString | string
  schema?: string | SchemaMapping
  schemaSource?: SchemaSource
  tables?: string[]
  inMemory?: boolean
  isVocabularyReference?: boolean
  version?: string
  createdAt?: string
}

/**
 * Import a database repo — the one entity tree that carries **data**.
 *
 * This is the read side of an asymmetry that is deliberate and load-bearing:
 * the app never *writes* a row (`buildDataSourceFolder` publishes metadata and
 * nothing else, so it can never be the path by which patient data leaves a
 * hospital), but it does *read* one, so an open dataset — MIMIC-IV demo,
 * synthetic data — can be installed from the catalog. The direction is what
 * makes it safe: nothing leaves. Do not "harmonise" the export to match.
 *
 * The Parquet arrives as real bytes because the server's clone resolves LFS
 * pointers before the tree gets here (`clone_to_zip`); catalog install is
 * server-mode-only, so that always holds.
 */
async function applyClonedDatabase(
  zip: JSZip,
  targetId: string,
  storage: Storage,
  workspaceId?: string,
  gitRemoteConfig?: GitRemoteConfig,
): Promise<boolean> {
  const metaEntry = zip.files[ENTITY_MANIFEST] ?? zip.files[MANIFEST.database]
  if (!metaEntry) return false
  const meta = JSON.parse(await metaEntry.async('string')) as DatabaseRepoMeta

  // The mapping is its own file since the split, with the DDL beside it — same
  // layout a schema preset uses. A tree written before that has it inline under
  // `schema`, and still imports.
  //
  // A bare name is the legacy form: it only resolves against the built-in preset
  // table, which is being retired now that schemas are installed from the catalog
  // rather than compiled in. Falling back to an empty mapping would import a
  // database the app cannot read one table from, with nothing saying why — so a
  // name that no longer resolves refuses instead.
  const mappingEntry = zip.files[SCHEMA_PRESET_MAPPING_FILE]
  const ddlEntry = zip.files[SCHEMA_PRESET_DDL_FILE]
  const fromFile = mappingEntry && !mappingEntry.dir
    ? JSON.parse(await mappingEntry.async('string')) as SchemaMapping
    : undefined
  const inlineMapping = typeof meta.schema === 'string'
    ? getSchemaPreset(meta.schema)
    : meta.schema
  const baseMapping = fromFile ?? inlineMapping
  const ddl = ddlEntry && !ddlEntry.dir ? await ddlEntry.async('string') : undefined
  const schemaMapping = baseMapping && ddl
    ? { ...baseMapping, ddl } as SchemaMapping
    : baseMapping
  if (!schemaMapping) {
    throw new Error(
      typeof meta.schema === 'string'
        ? `This database declares the schema "${meta.schema}", which is not installed. `
          + `Databases should carry their mapping in ${SCHEMA_PRESET_MAPPING_FILE}; re-export this `
          + 'repo, or install that schema preset first and retry.'
        : `This database carries no schema mapping (no ${SCHEMA_PRESET_MAPPING_FILE}, and nothing `
          + 'inline). Without it the app cannot read a single one of its tables.',
    )
  }

  const now = new Date().toISOString()
  const declared = meta.tables ?? []

  // Replace any previous files for this source so a re-clone is idempotent
  // rather than accumulating a second copy of every table.
  const previous = await storage.files.getByDataSource(targetId).catch(() => [])
  for (const file of previous) await storage.files.delete(file.id).catch(() => {})

  const connectionConfig: DatabaseConnectionConfig = {
    engine: 'duckdb',
    fileIds: [],
    fileNames: [],
    ...(meta.inMemory ? { inMemory: true } : {}),
  }

  const existing = await storage.dataSources.getById(targetId).catch(() => null)
  const record = {
    id: targetId,
    alias: meta.alias ?? targetId,
    name: toLocalized(meta.name ?? targetId),
    description: toLocalized(meta.description ?? ''),
    sourceType: 'database' as const,
    connectionConfig,
    schemaMapping,
    // Which published schema the inline mapping came from: the id recognizes it
    // across instances, the label names it here even when that preset is not
    // installed. Both travel with the repo.
    ...(meta.schemaSource ? { schemaSource: meta.schemaSource } : {}),
    status: 'configuring' as const,
    ...(meta.isVocabularyReference ? { isVocabularyReference: true } : {}),
    ...(meta.version ? { version: meta.version } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(gitRemoteConfig ? { gitRemoteConfig } : {}),
    // The repo's own date first: deleting the workspace and re-cloning left no
    // local row to recover it from, so every re-import read as brand new.
    createdAt: meta.createdAt ?? existing?.createdAt ?? now,
    updatedAt: now,
  }
  // README.md / LICENSE.md live as files in the repo, not in the metadata. For a
  // database the licence is not decoration: MIMIC-IV demo is ODbL, and the notice
  // has to travel with the data for redistribution to be legitimate.
  const docs = await readEntityDocs(zip, '', record as unknown as Record<string, unknown>)
  await createEntityAttachments(
    storage,
    { meta: docs.attachmentsMeta, blobs: docs.attachmentBlobs },
    'data-source',
    targetId,
    workspaceId,
  )
  const withDocs = dropForeignAuthorId({
    ...record,
    readme: docs.readme,
    license: docs.license,
  }) as unknown as DataSource
  if (existing) await storage.dataSources.update(targetId, withDocs).catch(() => {})
  else await storage.dataSources.create(withDocs as DataSource).catch(() => {})

  // The row has to exist BEFORE its files: in server mode `files.create` registers
  // each blob against the data source, and the API refuses an unknown one with a
  // bare 404 ("Not found") that says nothing about which row is missing.
  const storedFiles: StoredFile[] = []
  for (const table of declared) {
    const entry = zip.files[`data/${table}.parquet`]
    // Data files are gitignored in many trees, so a missing table is not fatal:
    // the metadata still imports and the user sees a database with fewer tables.
    if (!entry || entry.dir) continue
    const data = await entry.async('arraybuffer')
    const stored: StoredFile = {
      id: crypto.randomUUID(),
      dataSourceId: targetId,
      fileName: `${table}.parquet`,
      fileSize: data.byteLength,
      data,
      createdAt: now,
    }
    storedFiles.push(stored)
    await storage.files.create(stored)
  }
  // Point the source at what was just stored. Client-only reads these ids back
  // from IndexedDB to mount the tables; server mode resolves its files from
  // data_source_files by source id and ignores them, so the names are what
  // matter there.
  if (storedFiles.length > 0) {
    await storage.dataSources.update(targetId, {
      connectionConfig: {
        ...connectionConfig,
        fileIds: storedFiles.map((f) => f.id),
        fileNames: storedFiles.map((f) => f.fileName),
      },
    }).catch(() => {})
  }

  // Leave the source connected, not 'configuring'. Both modes have to do this
  // themselves: nothing else runs after an import, so a database that stayed
  // 'configuring' sat there with its data present but its Schema tab refusing
  // to browse it and its card reading "Configuring".
  //
  // Best-effort in both branches: the row and its files are already stored, so
  // failing to connect must not undo the import — the Databases page can always
  // retry, and losing the whole install over it would be far worse.
  if (storedFiles.length > 0) {
    try {
      if (isServerMode()) {
        // A Parquet database is a FILE source: the server attaches its files on
        // demand, so there is no live connection to test — the files being
        // uploaded is what "connected" means. (The /retest endpoint only knows
        // external engines and would answer `ok: false` for duckdb, marking a
        // perfectly good import as an error.)
        await storage.dataSources.update(targetId, {
          status: 'connected',
          errorMessage: undefined,
        })
      } else {
        const source = { ...withDocs, id: targetId } as DataSource
        await engine.mountDataSource(source, storedFiles)
        const stats = await engine.computeStats(targetId, schemaMapping)
        await storage.dataSources.update(targetId, { status: 'connected', stats })
      }
    } catch (e) {
      console.warn('[entity-io] database imported but not connected:', e)
    }
  }
  return true
}

/** What a database ZIP declares, read before deciding overwrite vs duplicate. */
export interface ParsedDatabaseZip {
  zip: JSZip
  /** The repo's own id — the row it overwrites when the user keeps it. */
  id: string
  name: LocalizedString
  tableCount: number
}

/**
 * Read a database repo ZIP far enough to ask the user what to do with it.
 *
 * Deliberately not `parseImportZip`: that decodes every entry as text, which
 * would corrupt `data/*.parquet`. The bytes stay untouched in the JSZip and are
 * read as arraybuffers by `importParsedDatabase` below.
 */
export async function parseDatabaseZip(file: File): Promise<ParsedDatabaseZip | null> {
  const zip = stripRootFolder(await JSZip.loadAsync(file))
  const metaEntry = zip.files[ENTITY_MANIFEST] ?? zip.files[MANIFEST.database]
  if (!metaEntry) return null
  const meta = JSON.parse(await metaEntry.async('string')) as DatabaseRepoMeta
  if (!meta.id) return null
  return {
    zip,
    id: meta.id,
    name: toLocalized(meta.name ?? meta.id),
    tableCount: meta.tables?.length ?? 0,
  }
}

/**
 * Import a parsed database ZIP. `duplicate` mints a fresh id so the incoming
 * database lands beside the existing one instead of replacing it — the same two
 * options every other per-page importer offers.
 */
export async function importParsedDatabase(
  parsed: ParsedDatabaseZip,
  storage: Storage,
  duplicate: boolean,
  workspaceId?: string,
  gitRemoteConfig?: GitRemoteConfig,
): Promise<string | null> {
  const targetId = duplicate ? crypto.randomUUID() : parsed.id
  const ok = await applyClonedDatabase(parsed.zip, targetId, storage, workspaceId, gitRemoteConfig)
  if (!ok) return null
  // The alias names the DuckDB schema, so a copy sharing the original's alias
  // would have both databases resolve to `ds_<alias>` — the copy silently
  // shadowing the original's tables. Only a duplicate can collide: an overwrite
  // reuses the row it replaces.
  if (duplicate) {
    const others = (await storage.dataSources.getAll().catch(() => []))
      .filter((ds) => ds.id !== targetId)
      .map((ds) => ds.alias)
      .filter((a): a is string => !!a)
    const created = await storage.dataSources.getById(targetId).catch(() => null)
    const unique = engine.ensureUniqueAlias(created?.alias ?? targetId, others)
    if (created && unique !== created.alias) {
      await storage.dataSources.update(targetId, { alias: unique }).catch(() => {})
    }
  }
  return targetId
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
  /** The cloned repo's manifest, under the shared name or the kind's own. */
  const readManifest = async <T>(kind: LayoutKind): Promise<T | null> =>
    (await readJson<T>(ENTITY_MANIFEST)) ?? (await readJson<T>(MANIFEST[kind]))
  const readText = async (name: string): Promise<string | null> => {
    const entry = zip.files[name]
    return entry && !entry.dir ? entry.async('string') : null
  }

  if (type === 'sql-collection' || type === 'etl-pipeline') {
    // The record itself (metadata) is re-applied from the repo's _collection.json /
    // _pipeline.json — the workspace only carried a minimal pointer. Then the files.
    const meta = await readManifest<SqlScriptCollection | EtlPipeline>(type)
    if (meta) {
      const { id: _id, workspaceId: _ws, ...changes } = dropForeignAuthorId(meta) as SqlScriptCollection
      // README.md / LICENSE.md / attachments/ live as files in the repo, not in the
      // metadata: fold them back onto the entity so the clone is complete.
      const docs = await readEntityDocs(zip, '', meta)
      const withDocs = { ...changes, readme: docs.readme, license: docs.license }
      const ownerType = type === 'sql-collection' ? 'sql-collection' : 'etl-pipeline'
      if (type === 'sql-collection') await storage.sqlScriptCollections.update(targetId, withDocs).catch(() => {})
      else await storage.etlPipelines.update(targetId, withDocs as Partial<EtlPipeline>).catch(() => {})
      await createEntityAttachments(
        storage,
        { meta: docs.attachmentsMeta, blobs: docs.attachmentBlobs },
        ownerType,
        targetId,
        workspaceId,
      )
    }
    const fkKey = type === 'sql-collection' ? 'collectionId' : 'pipelineId'
    // Clear this collection's/pipeline's own files first, so a retry or a re-clone
    // over a prior pointer doesn't leave stale rows.
    if (type === 'sql-collection') await storage.sqlScriptFiles.deleteByCollection(targetId).catch(() => {})
    else await storage.etlFiles.deleteByPipeline(targetId).catch(() => {})
    // Ids are derived from (targetId, path), so they're stable across re-clones
    // into this collection and distinct from a sibling clone of the same repo —
    // no collision to recover from, and _tree.json carries no id to churn.
    // The tree lives under scripts/ in a current export; a repo published before
    // that keeps it at the root with its files beside it.
    const inScripts = await readJson(`${SCRIPTS_DIR}/${SIDECAR.tree}`)
    const filePrefix = inScripts ? `${SCRIPTS_DIR}/` : ''
    const tree = readPathTree(inScripts ?? (await readJson(SIDECAR.tree)))
    for (const rec of fromPathTree<Record<string, unknown>>(tree, targetId, fkKey)) {
      if (rec.type === 'file') {
        const path = String(rec.path)
        // `mapping/` is machine-managed and stays at the entity root.
        const isMapping = path === MAPPING_DIR || path.startsWith(`${MAPPING_DIR}/`)
        const content = await zip.files[`${isMapping ? '' : filePrefix}${path}`]?.async('string')
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
  // The entity JSON carries only HALF of readme/license: `stripEntityDocs` writes
  // the licence's id + name there and its text to LICENSE.md beside it. Re-applying
  // the JSON alone would replace a complete local licence with a text-less stub —
  // the export then omits LICENSE.md (it reads as "deleted" on the next push) and
  // the licence editor breaks on the missing text. `readEntityDocs` recombines the
  // two halves, exactly as the sql/etl branch above does.
  const withEntityDocs = async <T extends object>(
    meta: T & { license?: { id?: string; name?: string }; readmeLang?: string },
    ownerType: Parameters<typeof createEntityAttachments>[2],
  ): Promise<T> => {
    const docs = await readEntityDocs(zip, '', meta)
    await createEntityAttachments(
      storage,
      { meta: docs.attachmentsMeta, blobs: docs.attachmentBlobs },
      ownerType,
      targetId,
      workspaceId,
    )
    return { ...meta, readme: docs.readme, license: docs.license }
  }

  if (type === 'data-catalog') {
    const catalog = await readManifest<DataCatalog>('data-catalog')
    if (!catalog) return false
    const { id: _id, workspaceId: _ws, ...rest } = dropForeignAuthorId(catalog) as DataCatalog
    const changes = await withEntityDocs(rest, 'data-catalog')
    // Not swallowed: a rejected write must reach the caller, or the import
    // reports success for an entity the server never stored.
    await storage.dataCatalogs.update(targetId, changes)
    return true
  }

  if (type === 'dq-rule-set') {
    const ruleSet = await readManifest<DqRuleSet>('dq-rule-set')
    if (!ruleSet) return false
    const { id: _id, workspaceId: _ws, ...rest } = dropForeignAuthorId(ruleSet) as DqRuleSet
    const changes = await withEntityDocs(rest, 'dq-rule-set')
    await storage.dqRuleSets.update(targetId, changes)
    const checks = (await readJson<DqCustomCheck[]>(CONTENT_FILE.dqChecks)) ?? []
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
    const preset = await readManifest<CustomSchemaPreset & { name?: LocalizedString; description?: LocalizedString }>('schema-preset')
    if (!preset) return false
    // The DDL is its own file in the repo; the manifest carries identity only. A
    // preset whose schema.ddl is missing would create every OMOP table with no
    // columns, so treat it as an unreadable repo rather than import a schema that
    // silently does nothing.
    const ddl = await readText(SCHEMA_PRESET_DDL_FILE)
    if (!ddl) return false
    // The mapping is its own file since the split; an older repo has it inline.
    const mappingFile = await readJson<Partial<SchemaMapping>>(SCHEMA_PRESET_MAPPING_FILE)
    const presetMapping = reassemblePresetMapping(preset, mappingFile ?? undefined)
    // A re-clone of a preset already here keeps that row's local ids.
    const existingPreset = await storage.schemaPresets.getById(targetId).catch(() => undefined)
    // `workspaceId` and `gitRemoteConfig` must be re-stamped from the caller: unlike
    // the other types here, a preset has no shell row to carry them (save() is an
    // upsert keyed by presetId, so createShell is a no-op for it), and the repo's own
    // values — if any — belong to another instance. Without workspaceId the preset is
    // saved outside every workspace and getByWorkspace() never returns it; without
    // gitRemoteConfig the catalog cannot tell it is installed (findInstalled matches
    // on lineageId or that URL), so the card keeps offering Install.
    const withDocs = await withEntityDocs(
      dropForeignAuthorId({
        ...preset,
        presetId: targetId,
        // A local key is local: the repo's belongs to whichever instance wrote
        // it, so this row keeps its own — the one already stored when this is a
        // re-clone of a preset that is here, a fresh uuid otherwise. Re-minting
        // unconditionally would change the row's key on every pull. The
        // published identity travels in `lineageId`, preserved by the spread.
        id: existingPreset?.id ?? crypto.randomUUID(),
        entityId: existingPreset?.entityId ?? preset.entityId ?? targetId,
        // A repo published before lineage existed carries none, and the spread
        // above would leave this row without one — unrecognisable to every other
        // instance, and to `findInstalled` except by git URL. Mint it here so the
        // identity exists from the first clone; a re-clone keeps what is stored,
        // and a repo that does carry one keeps the published value.
        lineageId: existingPreset?.lineageId ?? preset.lineageId ?? crypto.randomUUID(),
        workspaceId,
        ...(gitRemoteConfig ? { gitRemoteConfig } : {}),
        // `mapping.presetId` must follow the entity's id. Leaving the repo's
        // value made the two drift whenever the install minted a fresh id, and
        // a later ZIP import — which reads `mapping.presetId` as the entity id
        // and deletes whatever holds it — then deleted a different preset.
        mapping: { ...presetMapping, presetId: targetId, ddl },
      }) as CustomSchemaPreset,
      'schema-preset',
    )
    await storage.schemaPresets.save(withDocs)
    return true
  }

  if (type === 'database') {
    return applyClonedDatabase(zip, targetId, storage, workspaceId, gitRemoteConfig)
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
  zip.file(`${prefix}${ENTITY_MANIFEST}`, json(withEntityType(stripEntityDocs(stripInstanceFields(pipeline) as EtlPipeline), 'etl-pipeline')))
  await writeEntityDocs(zip, prefix, pipeline, storage, 'etl-pipeline', pipeline.id)
  const files = await storage.etlFiles.getByPipeline(pipeline.id)
  const byId = new Map<string, TreeNode>(files.map(f => [f.id, f]))

  // Per-file versioning marks (pipeline.config). A file that does not leave the
  // machine is dropped from the tree as well as from the zip: `_tree.json` naming a
  // file the repo cannot contain breaks re-import, and made every pull offer the
  // phantom as an incoming change ("Mapping files (1):
  // mapping/source_to_concept_map.csv" for a file that was never committed and
  // never could be, being gitignored as data).
  //
  // The rule is inlined rather than imported from features/warehouse/etl
  // (`isVersioned`): etl-versioning.ts imports isDataExtension from HERE, so the
  // import would be a cycle. entity-io.test.ts asserts the two agree.
  const isVersionedPath = (path: string) =>
    isDataExtension(path)
      ? (pipeline.config?.versionedDataFiles ?? []).includes(path)
      : !(pipeline.config?.excludedFiles ?? []).includes(path)
  const kept = files.filter(
    (f) => f.type !== 'file' || isVersionedPath(treeNodePath(f, byId)),
  )
  // The user's tree moves under scripts/ so `_tree.json` sits beside the files it
  // describes. `mapping/` does NOT: it is machine-managed (MAPPING_DIR), the
  // generated vocabulary script reads `mapping/<name>.csv` by that exact path, and
  // the readiness check looks for the folder at the pipeline root.
  const exportPath = (path: string) =>
    path === MAPPING_DIR || path.startsWith(`${MAPPING_DIR}/`)
      ? path
      : `${SCRIPTS_DIR}/${path}`
  // Every kept node stays IN the tree — it is what drives the import; only the
  // files' physical location changes. Dropping the mapping/ nodes here made the
  // marked vocabulary CSV vanish from the export entirely.
  zip.file(`${prefix}${SCRIPTS_DIR}/${SIDECAR.tree}`, json(toPathTree(kept, 'pipelineId')))

  const includedDataPaths: string[] = []
  for (const f of kept) {
    if (f.type !== 'file' || f.content == null) continue
    const path = exportPath(treeNodePath(f, byId))
    // Marked data files are re-included in the standalone .gitignore below.
    if (isDataExtension(path)) includedDataPaths.push(path)
    zip.file(`${prefix}${path}`, f.content)
  }

  // Standalone pipeline repo only: inside a workspace export unmarked data files
  // are physically absent (filtered above), so a nested copy would just be noise.
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
 * The only `connectionConfig` keys that may leave the machine.
 *
 * `engine` says what kind of database it is, `inMemory` and `managed` say how it
 * is held — none of the three can address or authenticate against anything.
 *
 * Keep this in sync with `_CONNECTION_CONFIG_EXPORTED` (workspace_export.py);
 * the golden tests compare the two builders byte for byte.
 */
const EXPORTED_CONNECTION_KEYS = ['engine', 'inMemory', 'managed'] as const

/**
 * Reduce a ConnectionConfig to the fields that are safe to publish.
 *
 * An ALLOWLIST, deliberately: a denylist keeps whatever it has not been taught
 * to remove, so the day someone adds `sslCert`, `dsn` or `apiKey` to a config,
 * a denylist would publish it and nothing would say so. Here a new field is
 * withheld until it is explicitly listed above — the failure mode is a missing
 * field in an export, not a credential in a public repo.
 *
 * Hosts, ports, database and schema names, usernames, passwords, tokens and
 * local file references therefore never leave the machine.
 */
export function sanitizeConnectionConfig(config: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const key of EXPORTED_CONNECTION_KEYS) {
    // `!= null` covers null too: JSON.stringify keeps an explicit null, and the
    // Python builder drops it — the two must agree byte for byte.
    if (config[key] != null) safe[key] = config[key]
  }
  return safe
}

/**
 * A user plugin's bundled `plugin.json` — its own FUNCTIONAL manifest, which is
 * not renamed and is where a plugin names itself for its ecosystem.
 *
 * The entity's `name`/`description` are derived from here rather than copied
 * onto the row: one source of truth, and no migration.
 */
function pluginManifest(plugin: UserPlugin): {
  id?: string
  name?: LocalizedString
  description?: LocalizedString
} {
  try {
    return JSON.parse(plugin.files[CONTENT_FILE.pluginManifest] ?? '{}')
  } catch {
    return {}
  }
}

/** Resolve a user plugin's manifest id from its bundled plugin.json (falls back to undefined). */
function pluginManifestId(plugin: UserPlugin): string | undefined {
  return pluginManifest(plugin).id
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
  const excluded = options.excludeEntities ?? {}

  // --- workspace.json (without instance-specific fields) ---
  // organizationId is stripped as an instance field, then re-added deliberately:
  // an organization's UUID is stable across instances (it's the catalog index),
  // so a workspace keeps pointing at the org it was exported with. The full org
  // record travels alongside in organization.json.
  // stripEntityDocs rather than a hand-rolled destructure: it also emits
  // `readmeLang` when the primary README is not English, which the server's
  // twin has always written. Doing it by hand here dropped that marker, so a
  // French-only workspace exported different bytes front vs back.
  // Resolved once and used twice: inline in the manifest, like the other eight
  // kinds, and in full as organization.json below.
  const workspaceOrg = workspace.organizationId
    ? ((await storage.organizations.getById(workspace.organizationId)) as unknown as OrganizationInfo | undefined)
    : undefined
  // A workspace is the container, not a published, versioned unit — `version` is
  // deliberately null rather than added to the type. `license` and the org
  // snapshot bring it in line with the other eight kinds; the root
  // organization.json stays, carrying the full record the import upserts. These
  // go through the shared ordering like every other kind's, so the provenance
  // block reads the same here as everywhere else.
  const workspaceMeta = withEntityType(
    {
      ...stripInstanceFields(stripEntityDocs(workspace)) as Record<string, unknown>,
      version: null,
      ...(licenseMeta(workspace.license) ? { license: licenseMeta(workspace.license) } : {}),
      organization: workspaceOrg ? orgSnapshot(workspaceOrg) : null,
    },
    'workspace',
    false,
  )
  zip.file(ENTITY_MANIFEST, json({
    ...workspaceMeta,
    appVersion: APP_VERSION,
  }))

  // --- organization.json ---
  // The linked organization travels with the workspace so an import can
  // reconstitute it (upsert by UUID) without a shared org registry. orgSnapshot
  // drops updatedAt (re-stamped on import) and normalizes createdAt to ms+Z, so
  // this root org matches the inline snapshots and doesn't churn the diff.
  if (workspaceOrg) zip.file(ROOT_FILE.organization, json(orgSnapshot(workspaceOrg)))

  // --- README.md (+ README.<lang>.md per extra language) ---
  writeReadmeFiles(zip, '', workspace.readme)
  writeLicenseFile(zip, '', workspace.license)
  // The workspace README's own images used to be left behind, so a readme that
  // embedded one exported with a dead link.
  await writeAttachmentFiles(zip, '', storage, 'workspace', workspace.id)

  // --- projects/ ---
  // Git-linked projects: metadata + README + git pointer only (full content lives in the project's own repo).
  // Unlinked projects: full content, nested via buildProjectZip.
  if (on('projects')) {
    const allProjects = await storage.projects.getAll()
    const wsProjects = allProjects.filter(p => p.workspaceId === workspaceId)
    for (const project of wsProjects) {
      if (excluded[project.uid]) continue
      const folder = project.entityId || project.projectId || slugify(resolveProjectName(project))
      const git = resolveGitRemote(project)

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
        const pointer = gitPointerManifest('project', {
          uid: project.uid,
          entityId: project.entityId ?? project.projectId,
          name: project.name,
          createdAt: project.createdAt,
          lineageId: project.lineageId,
        }, git)
        zip.file(`projects/${folder}/${ENTITY_MANIFEST}`, json(pointer))
        gitLinks.push({ type: 'project', lineageId: project.lineageId, folder, url: git.url, branch: git.branch })
      } else {
        // Full project content nested under projects/<folder>/ (reuses buildProjectZip layout).
        // Data files are bundled per the project's own versionedDataFiles marking
        // (buildProjectZip reads project.config) — no blanket include flag.
        const sub = await buildProjectZip(project.uid, storage, {})
        if (sub) {
          const subZip = await JSZip.loadAsync(sub.blob)
          await Promise.all(Object.keys(subZip.files).map(async (path) => {
            const entry = subZip.files[path]
            if (entry.dir) return
            zip.file(`projects/${folder}/${path}`, await entry.async('uint8array'))
          }))
        }
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
      // Stripped like every other section: the raw rows leaked this instance's
      // `workspaceId`/`createdById` and an `updatedAt` that churns on every edit.
      // `id`/`parentId` stay — they are the tree's own structure, and the import
      // re-keys them (mapWikiId) rather than adopting them.
      const treeMeta = wikiPages.map(({ content: _, ...meta }) => stripInstanceFields(meta as WikiPage))
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
      // Keyed on `id` like every other section — WsExportTab must list the same.
      if (excluded[sp.id ?? sp.presetId]) continue
      const git = resolveGitRemote(sp)
      // The folder name is read by a human browsing the repo, so it stays the
      // readable slug rather than the row's uuid.
      const slug = sp.entityId ?? sp.presetId
      if (git) {
        // Pointer only — the linked repo's entity.json is the source of truth. Keep
        // just the identity (create key + git detection), the display name, and the
        // git pointer; the clone (applyClonedEntity) re-applies the full preset.
        // `name` is the promoted root field (§3.4b), not the nested `mapping`
        // payload this used to inline.
        const folder = slugify(slug)
        const pointer = gitPointerManifest('schema-preset', {
          entityId: slug,
          name: sp.mapping?.presetLabel,
          createdAt: sp.createdAt,
          lineageId: sp.lineageId,
        }, git)
        zip.file(`schemas/${folder}/${ENTITY_MANIFEST}`, json(pointer))
        gitLinks.push({ type: 'schema-preset', lineageId: sp.lineageId, folder, url: git.url, branch: git.branch })
        continue
      }
      // Same folder layout as the standalone export, via the same builder: the
      // DDL becomes a readable schema.ddl instead of one escaped JSON string, the
      // name/description rise to the root, and the docs travel with it.
      await buildSchemaPresetFolder(zip, `schemas/${slugify(slug)}/`, sp, storage)
    }
  }

  // --- databases/ (always exported when section enabled; connection details and passwords never) ---
  if (on('databases')) {
    const dataSources = await storage.dataSources.getByWorkspace(workspaceId)
    for (const ds of dataSources) {
      if (excluded[ds.id]) continue
      // Vocabulary references (ATHENA OMOP target vocabularies imported for
      // mapping) are an internal artifact, not a real database — the whole UI
      // hides them (isVocabularyReference). They must not be versioned either,
      // or the workspace shows a phantom "Databases (1)" with an empty list.
      if ((ds as { isVocabularyReference?: boolean }).isVocabularyReference) continue
      // eid(), like every other section: prefers the stable entityId, so renaming
      // a database no longer moves its folder and churns the git diff.
      const folder = eid(ds)
      const git = resolveGitRemote(ds)
      if (git) {
        // Pointer only, like every other linked kind. This branch did not exist:
        // a linked database was inlined and never reached git-links.json, so the
        // clone never ran for it even though applyClonedEntity handles the type.
        zip.file(`databases/${folder}/${ENTITY_MANIFEST}`, json(gitPointerManifest('database', {
          entityId: folder,
          name: ds.name,
          createdAt: ds.createdAt,
          lineageId: ds.lineageId,
        }, git)))
        gitLinks.push({ type: 'database', lineageId: ds.lineageId, folder, url: git.url, branch: git.branch })
        continue
      }
      // Same folder layout as the standalone export, via the same builder. The
      // flat form was the only section calling NONE of the strip helpers, so it
      // leaked workspaceId/ownerId/updatedAt and inlined the whole DDL as one
      // escaped JSON string.
      await buildDataSourceFolder(zip, `databases/${folder}/`, ds, storage)
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
        zip.file(`sql-scripts/${folder}/${ENTITY_MANIFEST}`, json(gitPointerManifest('sql-collection', { entityId: eid(collection), name: collection.name, createdAt: collection.createdAt, lineageId: collection.lineageId }, git)))
        gitLinks.push({ type: 'sql-collection', lineageId: collection.lineageId, folder, url: git.url, branch: git.branch })
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
        zip.file(`etl/${folder}/${ENTITY_MANIFEST}`, json(gitPointerManifest('etl-pipeline', { entityId: eid(pipeline), name: pipeline.name, createdAt: pipeline.createdAt, lineageId: pipeline.lineageId }, git)))
        gitLinks.push({ type: 'etl-pipeline', lineageId: pipeline.lineageId, folder, url: git.url, branch: git.branch })
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
        // would never correct it).
        zip.file(`data-quality/${folder}/${ENTITY_MANIFEST}`, json(gitPointerManifest('dq-rule-set', {
          entityId: rs.entityId,
          name: rs.name,
          createdAt: rs.createdAt,
          lineageId: rs.lineageId,
        }, git)))
        gitLinks.push({ type: 'dq-rule-set', lineageId: rs.lineageId, folder, url: git.url, branch: git.branch })
        continue
      }
      // Same folder layout as the standalone export, via the same builder: checks
      // move to their own checks.json (they were bundled under a `ruleSet` wrapper
      // key that existed nowhere else in the format) and the docs travel too.
      await buildDqRuleSetFolder(zip, `data-quality/${eid(rs)}/`, rs, storage)
    }
  }

  // --- concept-sets/ ---
  // Workspace-scoped imported data dictionaries. parseWorkspaceZip has always read
  // these back (and ParsedWorkspaceZip carries them), but nothing ever wrote them —
  // so an export/reimport round trip silently dropped every concept set.
  if (on('conceptMapping')) {
    const conceptSets = await storage.conceptSets.getByWorkspace(workspaceId)
    for (const cs of conceptSets) {
      if (excluded[cs.id]) continue
      zip.file(`concept-sets/${slugify(cs.name || cs.id)}.json`, json(stripInstanceFields(cs)))
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
        zip.file(`mapping-projects/${folder}/${ENTITY_MANIFEST}`, json(gitPointerManifest('mapping-project', { entityId: mp.entityId, name: mp.name, createdAt: mp.createdAt, lineageId: mp.lineageId }, git)))
        gitLinks.push({ type: 'mapping-project', lineageId: mp.lineageId, folder, url: git.url, branch: git.branch })
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
        zip.file(`catalogs/${folder}/${ENTITY_MANIFEST}`, json(gitPointerManifest('data-catalog', { entityId: eid(cat), name: cat.name, createdAt: cat.createdAt, lineageId: cat.lineageId }, git)))
        gitLinks.push({ type: 'data-catalog', lineageId: cat.lineageId, folder, url: git.url, branch: git.branch })
        continue
      }
      // Same folder layout as the standalone export, via the same builder: a
      // workspace-embedded entity and its own repo are then the same tree, and the
      // README/LICENSE/attachments the flat form silently dropped travel too.
      await buildDataCatalogFolder(zip, `catalogs/${eid(cat)}/`, cat, storage)
    }

    const serviceMappings = await storage.serviceMappings.getByWorkspace(workspaceId)
    for (const sm of serviceMappings) {
      if (excluded[sm.id]) continue
      // Stripped like every other section: writing the row raw leaked
      // `workspaceId` (this instance's) and `updatedAt` (churns on every edit)
      // into the repo. Same bug the schema/DQ/catalog sections had.
      zip.file(`service-mappings/${slugify(sm.name || sm.id)}.json`, json(stripInstanceFields(sm)))
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
      // Same folder as the standalone export, via the same builder. The manifest
      // written here by hand carried four keys: no type, name, description,
      // version, licence or lineage — and it copied `files` verbatim, so a stale
      // README.md inside them overwrote the entity's own.
      await buildUserPluginFolder(zip, `plugins/${folder}/`, plugin, storage)
    }
  }

  // --- git-links.json (manifest of git-linked entities; portal build derives .gitmodules from it) ---
  if (gitLinks.length > 0) {
    // Sort deterministically so adding/removing an unrelated link never reorders the rest
    // and churns the versioning diff. Key is (type, lineageId, folder): lineageId is the
    // cross-instance identity, so it survives the re-minting that entity ids undergo on
    // import — sorting on an id reshuffled the whole file every round trip. `folder`
    // breaks the tie for a link published before lineage existed (null lineageId).
    // Code-point order, matching Python's tuple sort: localeCompare orders by the
    // reader's locale, so the same workspace could emit two different link orders
    // (and disagree with the server) for reasons no diff would explain.
    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
    const links = [...gitLinks]
      .sort((a, b) =>
        cmp(a.type, b.type) || cmp(a.lineageId ?? '', b.lineageId ?? '') || cmp(a.folder, b.folder))
      .map(({ lineageId: _l, ...entry }) => entry)
    zip.file(ROOT_FILE.gitLinks, json({ appVersion: APP_VERSION, links }))
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
  /** The workspace README's own images. */
  workspaceAttachments?: ParsedEntityAttachments
  wikiAttachmentsMeta: Omit<WikiAttachment, 'data'>[]
  wikiAttachmentBlobs: Map<string, ArrayBuffer>
  sqlCollections: { collection: SqlScriptCollection; files: SqlScriptFile[] }[]
  etlPipelines: { pipeline: EtlPipeline; files: EtlFile[]; attachments?: ParsedEntityAttachments }[]
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
  type: 'project' | 'mapping-project' | 'sql-collection' | 'etl-pipeline' | 'data-catalog' | 'dq-rule-set' | 'schema-preset' | 'database'
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
  for (const sp of parsed.schemas) push('schema-preset', sp.id ?? sp.presetId, localized(sp.mapping?.presetLabel, 'en') || sp.entityId || sp.presetId || sp.id, resolveGitRemote(sp) ?? undefined)
  // Databases were the one declared type never collected here, so a linked one
  // was imported but its repo never cloned.
  for (const ds of parsed.databases) {
    if (!ds.id) continue
    push('database', ds.id, localized(ds.name, 'en') || ds.entityId || ds.id, resolveGitRemote(ds) ?? undefined)
  }
  return out
}

export async function parseWorkspaceZip(file: File): Promise<ParsedWorkspaceZip | null> {
  const zipData = stripRootFolder(await JSZip.loadAsync(file))

  // --- workspace.json ---
  const wsFile = zipData.files[ENTITY_MANIFEST] ?? zipData.files[MANIFEST.workspace]
  if (!wsFile) return null
  const workspace = JSON.parse(await wsFile.async('string')) as Workspace & { appVersion?: string }
  if (!workspace) return null
  // A manifest no longer carries the writing instance's `id`. The importer mints
  // the local key, so what has to be present is a NAME — enough to build a
  // workspace from. `lineageId` is what identifies it across instances, and a
  // tree published before it existed simply gets one on import.
  if (!workspace.name && !workspace.id) return null
  if (!workspace.id) workspace.id = crypto.randomUUID()

  // --- organization.json (optional) ---
  const orgFile = zipData.files[ROOT_FILE.organization]
  const organization = orgFile
    ? (JSON.parse(await orgFile.async('string')) as Organization)
    : undefined

  // --- README.md (suffix-free = workspace.readmeLang, README.<lang>.md the rest) ---
  const wsWithLang = workspace as typeof workspace & { readmeLang?: string }
  const wsReadmeLang = wsWithLang.readmeLang
  delete wsWithLang.readmeLang
  const wsReadmeByLang: LocalizedString = {}
  for (const [path, file] of Object.entries(zipData.files)) {
    const m = README_FILE_RE.exec(path)
    if (!m) continue
    wsReadmeByLang[m[1] ?? wsReadmeLang ?? 'en'] = await file.async('string')
  }
  if (Object.keys(wsReadmeByLang).length > 0) {
    workspace.readme = wsReadmeByLang
  }
  const wsLicenseFile = zipData.files['LICENSE.md']
  if (wsLicenseFile) {
    workspace.license = readLicense(workspace.license, await wsLicenseFile.async('string'))
  }
  const workspaceAttachments = await readEntityDocs(zipData, '', {})

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
  const lightweightFile = (name: string) =>
    name === ENTITY_MANIFEST || name === MANIFEST.project || README_FILE_RE.test(name)
  for (const folder of projectFolders) {
    const prefix = `projects/${folder}/`
    const hasFullContent = Object.entries(zipData.files).some(([p, entry]) =>
      !entry.dir && p.startsWith(prefix) && !lightweightFile(p.slice(prefix.length))
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
      const projectJson = await readEntityManifest<Project & { appVersion?: string }>(zipData, prefix, 'project')
      if (!projectJson) continue
      const lightWithLang = projectJson as typeof projectJson & { readmeLang?: string }
      const lightReadmeLang = lightWithLang.readmeLang
      delete lightWithLang.readmeLang
      const readmeByLang: LocalizedString = {}
      for (const [path, file] of Object.entries(zipData.files)) {
        if (!path.startsWith(prefix)) continue
        const m = README_FILE_RE.exec(path.slice(prefix.length))
        if (!m) continue
        readmeByLang[m[1] ?? lightReadmeLang ?? 'en'] = await file.async('string')
      }
      const readme = Object.keys(readmeByLang).length > 0 ? readmeByLang : undefined
      projectEntries.push({ project: projectJson, readme })
    }
  }

  // --- schemas/ ---
  const schemas: CustomSchemaPreset[] = []
  for (const folder of entityFolders(zipData, 'schemas/')) {
    const prefix = `schemas/${folder}/`
    const sp = await readEntityManifest<CustomSchemaPreset>(zipData, prefix, 'schema-preset')
    if (!sp) continue
    // The mapping is its own file with the DDL beside it; the root carries the
    // promoted name/description. reassemblePresetMapping folds them back — a git
    // pointer has neither file, and keeps just its name.
    const mappingFile = await readJsonFile<SchemaMapping>(zipData, `${prefix}${SCHEMA_PRESET_MAPPING_FILE}`)
    const ddlEntry = zipData.files[`${prefix}${SCHEMA_PRESET_DDL_FILE}`]
    const ddl = ddlEntry && !ddlEntry.dir ? await ddlEntry.async('string') : undefined
    const mapping = reassemblePresetMapping(sp, mappingFile ?? undefined)
    sp.mapping = (ddl ? { ...mapping, ddl } : mapping) as SchemaMapping
    const docs = await readEntityDocs(zipData, prefix, sp)
    if (docs.readme) sp.readme = docs.readme
    if (docs.license) sp.license = docs.license
    schemas.push(sp)
  }
  // Flat form written before presets moved to a folder: the whole preset, mapping
  // and DDL inlined, in one file.
  for (const [path, entry] of Object.entries(zipData.files)) {
    if (!path.startsWith('schemas/') || !path.endsWith('.json') || entry.dir) continue
    if (path.slice('schemas/'.length).includes('/')) continue
    schemas.push(JSON.parse(await entry.async('string')))
  }

  // --- databases/ (sanitized connection metadata) ---
  const databases: Partial<DataSource>[] = []
  for (const folder of entityFolders(zipData, 'databases/')) {
    const prefix = `databases/${folder}/`
    const ds = await readEntityManifest<Partial<DataSource> & { schema?: unknown }>(zipData, prefix, 'database')
    if (!ds) continue
    // A manifest carries no local key (a pointer least of all), and the import
    // keys rows by id — mint one here, as the sql/etl sections do.
    if (!ds.id) ds.id = crypto.randomUUID()
    // The mapping is its own file with the DDL beside it, like a schema preset —
    // a pointer folder has neither, and the clone fills them in.
    const mappingFile = await readJsonFile<SchemaMapping>(zipData, `${prefix}${SCHEMA_PRESET_MAPPING_FILE}`)
    const ddlEntry = zipData.files[`${prefix}${SCHEMA_PRESET_DDL_FILE}`]
    const ddl = ddlEntry && !ddlEntry.dir ? await ddlEntry.async('string') : undefined
    const base = mappingFile ?? (ds.schemaMapping as SchemaMapping | undefined)
    if (base) ds.schemaMapping = (ddl ? { ...base, ddl } : base) as SchemaMapping
    const docs = await readEntityDocs(zipData, prefix, ds as { readmeLang?: string })
    if (docs.readme) ds.readme = docs.readme
    if (docs.license) ds.license = docs.license
    databases.push(ds)
  }
  // Flat form written before databases moved to a folder: the whole row, mapping
  // and DDL inlined, in one file.
  for (const [path, entry] of Object.entries(zipData.files)) {
    if (!path.startsWith('databases/') || !path.endsWith('.json') || entry.dir) continue
    if (path.slice('databases/'.length).includes('/')) continue
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
    const collection = await readEntityManifest<SqlScriptCollection>(zipData, prefix, 'sql-collection')
    if (!collection) continue
    // A manifest no longer carries the writing instance's key; the import mints
    // its own. One is minted here so the file ids below are namespaced by a real
    // value — the caller re-keys them if it lands the row under a different id.
    if (!collection.id) collection.id = crypto.randomUUID()
    const tree = await readScriptTree(zipData, prefix)
    const files = fromPathTree<SqlScriptFile & { path: string }>(
      tree.nodes,
      collection.id,
      'collectionId',
    )
    for (const f of files) {
      if (f.type !== 'file') continue
      const entry = zipData.files[`${tree.filePrefix}${f.path}`]
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
    const pipeline = await readEntityManifest<EtlPipeline>(zipData, prefix, 'etl-pipeline')
    if (!pipeline) continue
    if (!pipeline.id) pipeline.id = crypto.randomUUID()
    const tree = await readScriptTree(zipData, prefix)
    const files = fromPathTree<EtlFile & { path: string }>(
      tree.nodes,
      pipeline.id,
      'pipelineId',
    )
    for (const f of files) {
      if (f.type !== 'file') continue
      // `mapping/` stays at the entity root even when the scripts moved under
      // scripts/, so resolve it there rather than under the tree's prefix.
      const isMapping = f.path === MAPPING_DIR || f.path.startsWith(`${MAPPING_DIR}/`)
      const entry = zipData.files[`${isMapping ? prefix : tree.filePrefix}${f.path}`]
      if (entry) f.content = await entry.async('string')
    }
    const docs = await readEntityDocs(zipData, prefix, pipeline)
    if (docs.readme) pipeline.readme = docs.readme
    if (docs.license) pipeline.license = docs.license
    etlPipelines.push({
      pipeline,
      files: files as EtlFile[],
      attachments: { meta: docs.attachmentsMeta, blobs: docs.attachmentBlobs },
    })
  }

  // --- data-quality/ (also supports legacy 'dq/' prefix) ---
  const dqRuleSets: ParsedWorkspaceZip['dqRuleSets'] = []
  for (const section of ['data-quality/', 'dq/']) {
    for (const folder of entityFolders(zipData, section)) {
      const prefix = `${section}${folder}/`
      const ruleSet = await readEntityManifest<DqRuleSet>(zipData, prefix, 'dq-rule-set')
      if (!ruleSet) continue
      // A pointer folder has no checks.json — the linked repo owns the checks.
      const checks = (await readJsonFile<DqCustomCheck[]>(zipData, `${prefix}${CONTENT_FILE.dqChecks}`)) ?? []
      const docs = await readEntityDocs(zipData, prefix, ruleSet)
      if (docs.readme) ruleSet.readme = docs.readme
      if (docs.license) ruleSet.license = docs.license
      dqRuleSets.push({ ruleSet, checks })
    }
    // Flat form written before rule sets moved to a folder: the whole entity in
    // one file, checks bundled under a `ruleSet` wrapper key.
    for (const [path, entry] of Object.entries(zipData.files)) {
      if (!path.startsWith(section) || !path.endsWith('.json') || entry.dir) continue
      if (path.slice(section.length).includes('/')) continue
      const parsed = JSON.parse(await entry.async('string')) as
        | { ruleSet: DqRuleSet; checks?: DqCustomCheck[] }
        | (DqRuleSet & { checks?: DqCustomCheck[] })
      if ('ruleSet' in parsed && parsed.ruleSet) {
        dqRuleSets.push({ ruleSet: parsed.ruleSet, checks: parsed.checks ?? [] })
      } else if ((parsed as DqRuleSet).name || (parsed as DqRuleSet).entityId) {
        const { checks, ...ruleSet } = parsed as DqRuleSet & { checks?: DqCustomCheck[] }
        dqRuleSets.push({ ruleSet: ruleSet as DqRuleSet, checks: checks ?? [] })
      }
    }
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
    // A mapping project's metadata is `project.json`; `_project.json` is the
    // legacy name some published trees still use.
    const project = await readEntityManifest<MappingProject>(zipData, prefix, 'project', '_project.json')
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
  for (const folder of entityFolders(zipData, 'catalogs/')) {
    const prefix = `catalogs/${folder}/`
    const cat = await readEntityManifest<DataCatalog>(zipData, prefix, 'data-catalog')
    if (!cat) continue
    const docs = await readEntityDocs(zipData, prefix, cat)
    if (docs.readme) cat.readme = docs.readme
    if (docs.license) cat.license = docs.license
    catalogs.push(cat)
  }
  // Flat form written before catalogs moved to a folder.
  for (const [path, entry] of Object.entries(zipData.files)) {
    if (!path.startsWith('catalogs/') || !path.endsWith('.json') || entry.dir) continue
    if (path.slice('catalogs/'.length).includes('/')) continue
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
    const pluginMeta = await readEntityManifest<{ id: string; entityId?: string; workspaceId?: string; createdBy?: string; createdByDetails?: AuthorDetails; createdAt: string; updatedAt?: string }>(zipData, prefix, 'user-plugin')
    if (!pluginMeta) continue
    const files: Record<string, string> = {}
    for (const [path, entry] of Object.entries(zipData.files)) {
      if (!path.startsWith(prefix) || entry.dir) continue
      const relativePath = path.slice(prefix.length)
      // Both manifest names: the metadata pointer is not a plugin source file.
      if (relativePath === ENTITY_MANIFEST || relativePath === MANIFEST['user-plugin']) continue
      // Nor are the entity's own docs — the export writes them from the row's
      // readme/license, and reading them back as source would both duplicate them
      // and decode attachment blobs as text.
      if (isEntityDocsFile(relativePath)) continue
      files[relativePath] = await entry.async('string')
    }
    const docs = await readEntityDocs(zipData, prefix, pluginMeta)
    plugins.push({
      ...pluginMeta,
      files,
      ...(docs.readme ? { readme: docs.readme } : {}),
      ...(docs.license ? { license: docs.license } : {}),
    } as UserPlugin)
  }

  return {
    workspace, organization, projects, projectEntries, schemas, databases,
    workspaceAttachments: { meta: workspaceAttachments.attachmentsMeta, blobs: workspaceAttachments.attachmentBlobs },
    wikiPages, wikiAttachmentsMeta, wikiAttachmentBlobs,
    sqlCollections, etlPipelines, dqRuleSets, conceptSets,
    mappingProjects, sourceConceptIdRanges, sourceConceptIdEntries,
    catalogs, serviceMappings, plugins,
  }
}
