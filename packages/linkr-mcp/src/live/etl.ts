/** Pure helpers for ETL pipelines and SQL script collections. */
import type { EntityFilesConfig, EtlFile, EtlRunHistoryEntry, EtlRunLog } from '@/types'
import { isReservedTreeName, treeNodePath } from '@/lib/entity-tree'
import { compareEtlFilesByOrder } from '@/lib/etl-file-order'
import { mappingExportNameOf } from '@/lib/duckdb/mapping-source'
import type { RoleSchemas } from '@/lib/duckdb/role-prefix'
import { formatDuration } from '@/lib/format-helpers'
import { inferEtlLanguage, safeEtlFileName } from '@/features/warehouse/etl/etl-file-language'
import { clip } from './helpers.js'

/** A node of a pipeline's or a collection's file tree, as the API returns it. */
export interface TreeFile {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  content?: string | null
  order: number
  language?: string | null
  dataSourceId?: string | null
  disabled?: boolean | null
}

const asTree = (f: TreeFile) => ({ ...f, content: f.content ?? undefined })

/** Every node's path inside its tree, keyed by id. */
export function pathsById(nodes: TreeFile[]): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, asTree(n)]))
  return new Map(nodes.map((n) => [n.id, treeNodePath(asTree(n), byId)]))
}

export function findByPath<T extends TreeFile>(nodes: T[], path: string): T | undefined {
  const paths = pathsById(nodes)
  return nodes.find((n) => paths.get(n.id) === path)
}

/** A path as the tree keys it: no leading/trailing slash, no empty or dot segment. */
export function normalizePath(raw: string): string {
  const parts = raw.trim().replace(/\\/g, '/').split('/').filter((p) => p !== '')
  if (parts.length === 0) throw new Error('The path is empty.')
  if (parts.some((p) => p === '.' || p === '..')) throw new Error(`"${raw}": "." and ".." are not allowed in a path.`)
  return parts.join('/')
}

/**
 * Where a new node at `path` goes: the deepest existing folder on its way, the
 * folders still to create under it (in order), and the node's own name.
 */
export function locatePath(nodes: TreeFile[], path: string): { parentId: string | null; missing: string[]; name: string } {
  const parts = normalizePath(path).split('/')
  const name = parts.pop()!
  let parentId: string | null = null
  let i = 0
  for (; i < parts.length; i++) {
    const folder = nodes.find((n) => n.parentId === parentId && n.name === parts[i])
    if (!folder) break
    if (folder.type !== 'folder') throw new Error(`"${parts.slice(0, i + 1).join('/')}" is a file, not a folder.`)
    parentId = folder.id
  }
  return { parentId, missing: parts.slice(i), name }
}

/** Why a name cannot be stored at the tree root (README, LICENSE, manifests…), or null. */
export function reservedNameReason(name: string, atRoot: boolean, etl: boolean): string | null {
  if (atRoot && isReservedTreeName(name, null)) {
    return `"${name}" is reserved at the root: the README and licence are fields of the entity itself (update tools).`
  }
  if (etl && !safeEtlFileName(name)) return `"${name}" is reserved for the pipeline's own structure.`
  return null
}

/** Why the folders to create under `parentId` cannot be, or null; only the first can sit at the root. */
export function folderNamesError(parentId: string | null, missing: string[], etl: boolean): string | null {
  for (const [i, name] of missing.entries()) {
    const reason = reservedNameReason(name, i === 0 && parentId === null, etl)
    if (reason) return reason
  }
  return null
}

/** Where a node lands at `path` (normalized): its folder, the folders to create, its name — or why it cannot. */
function placeAt(
  nodes: TreeFile[], path: string, etl: boolean,
): { error: string } | { parentId: string | null; missing: string[]; name: string } {
  const { parentId, missing, name } = locatePath(nodes, path)
  const reason = reservedNameReason(name, parentId === null && missing.length === 0, etl)
    ?? folderNamesError(parentId, missing, etl)
  return reason ? { error: reason } : { parentId, missing, name }
}

export type WritePlan =
  | { error: string }
  | { updateId: string }
  | { create: { parentId: string | null; missing: string[]; name: string; language?: EtlFile['language'] } }

/** What writing `path` (normalized) does: update the file there, or create it and the folders on its way. */
export function planWrite(nodes: TreeFile[], path: string, etl: boolean): WritePlan {
  const existing = findByPath(nodes, path)
  if (existing) return existing.type === 'folder' ? { error: `"${path}" is a folder.` } : { updateId: existing.id }
  const place = placeAt(nodes, path, etl)
  if ('error' in place) return place
  const language = etl ? inferEtlLanguage(place.name) : undefined
  return { create: { ...place, ...(language ? { language } : {}) } }
}

export type MovePlan =
  | { error: string }
  | { unchanged: true }
  | { node: TreeFile; parentId: string | null; missing: string[]; name: string }

/** What moving `path` to `newPath` (both normalized) does, before the missing folders are created. */
export function planMove(nodes: TreeFile[], path: string, newPath: string, etl: boolean, listTool: string): MovePlan {
  const node = findByPath(nodes, path)
  if (!node) return { error: `No file or folder "${path}" — see ${listTool}.` }
  if (path === newPath) return { unchanged: true }
  if (findByPath(nodes, newPath)) return { error: `"${newPath}" already exists.` }
  const { parentId } = locatePath(nodes, newPath)
  if (isInside(nodes, parentId, node.id)) return { error: 'A folder cannot move into itself.' }
  const place = placeAt(nodes, newPath, etl)
  return 'error' in place ? place : { node, ...place }
}

/** The PATCH a move sends once its folder exists; a renamed ETL script follows its new extension's language. */
export function moveChanges(node: TreeFile, name: string, parentId: string | null, etl: boolean): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  if (name !== node.name) changes.name = name
  if (parentId !== node.parentId) changes.parentId = parentId
  if (etl && node.type === 'file' && changes.name) {
    const language = inferEtlLanguage(name)
    if (language && language !== node.language) changes.language = language
  }
  return changes
}

/** Whether `folderId` is `nodeId` or lies under it — a folder cannot move into itself. */
export function isInside(nodes: TreeFile[], folderId: string | null, nodeId: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (let id = folderId; id; id = byId.get(id)?.parentId ?? null) if (id === nodeId) return true
  return false
}

// --- Versioning marks --------------------------------------------------------
// Same rules as lib/entity-versioning (renameVersioningMark / prunedConfigForTree),
// which cannot be imported here: it pulls in lib/entity-io and, through it, the
// DuckDB-WASM engine and the build-time version constant.

/** The config after a node moves from one path to another (its subtree with it), or null if no mark moved. */
export function renameMarks<T extends EntityFilesConfig>(config: T | null | undefined, from: string, to: string): T | null {
  if (!config || from === to) return null
  let touched = false
  const remap = (list: string[] | undefined) => (list ?? []).map((p) => {
    const moved = p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p
    if (moved !== p) touched = true
    return moved
  }).sort()
  const versionedDataFiles = remap(config.versionedDataFiles)
  const excludedFiles = remap(config.excludedFiles)
  return touched ? { ...config, versionedDataFiles, excludedFiles } : null
}

/** The config without marks on files that no longer exist, or null if every mark is live. */
export function pruneMarks<T extends EntityFilesConfig>(config: T | null | undefined, nodes: TreeFile[]): T | null {
  if (!config) return null
  const paths = pathsById(nodes)
  const alive = new Set(nodes.filter((n) => n.type === 'file').map((n) => paths.get(n.id)!))
  const keep = (list: string[] | undefined) => (list ?? []).filter((p) => alive.has(p))
  const versionedDataFiles = keep(config.versionedDataFiles)
  const excludedFiles = keep(config.excludedFiles)
  if (versionedDataFiles.length === (config.versionedDataFiles?.length ?? 0)
    && excludedFiles.length === (config.excludedFiles?.length ?? 0)) return null
  return { ...config, versionedDataFiles, excludedFiles }
}

// --- Running a pipeline ------------------------------------------------------

/** The scripts "Run pipeline" executes, in execution order (the Pipeline tab's list). */
export function pipelineScripts<T extends TreeFile>(files: T[]): T[] {
  return files.filter((f) => f.type === 'file' && f.language === 'sql').sort(compareEtlFilesByOrder)
}

export const isSqlFile = (f: TreeFile) =>
  f.type === 'file' && (f.language === 'sql' || f.name.toLowerCase().endsWith('.sql'))

/** CSV text of the `mapping/<name>.csv` exports a pipeline holds, keyed by export name. */
export function mappingDataOf(files: TreeFile[]): Record<string, string> {
  const paths = pathsById(files)
  const data: Record<string, string> = {}
  for (const f of files) {
    if (f.type !== 'file' || !f.content) continue
    const name = mappingExportNameOf(paths.get(f.id)!)
    if (name) data[name] = f.content
  }
  return data
}

export interface RoleIds { sourceId?: string | null; targetId?: string | null; vocabId?: string | null }

/**
 * What `source.` / `target.` / `vocab.` resolve to on a server run (the server
 * branch of the app's computeRoleSchemas). A managed target runs through the
 * ETL endpoint, which ATTACHes each role under its own name; otherwise the one
 * database the query is sent to is reachable, unqualified, and the rest not.
 */
export function serverRoleSchemas(ids: RoleIds, targetIsManaged: boolean, runningOnId: string): RoleSchemas {
  const forRole = (role: string, id: string | null | undefined) =>
    !id ? undefined : targetIsManaged ? role : id === runningOnId ? '' : undefined
  return {
    source: forRole('source', ids.sourceId),
    target: forRole('target', ids.targetId),
    vocab: forRole('vocab', ids.vocabId),
  }
}

/** The databases attached read-only beside the target, by role. */
export function etlRoles(ids: RoleIds): Record<string, string> {
  const roles: Record<string, string> = {}
  if (ids.sourceId && ids.sourceId !== ids.targetId) roles.source = ids.sourceId
  if (ids.vocabId && ids.vocabId !== ids.targetId) roles.vocab = ids.vocabId
  return roles
}

export const rowsOutput = (rows: number, ms: number) =>
  `${rows} row${rows !== 1 ? 's' : ''} in ${formatDuration(ms)}`

/** The database a pipeline script runs against: its own, else the pipeline's target, else its source. */
export const scriptDatabaseId = (
  file: Pick<TreeFile, 'dataSourceId'>, p: { targetDataSourceId?: string | null; sourceDataSourceId?: string | null },
): string | null => file.dataSourceId ?? p.targetDataSourceId ?? p.sourceDataSourceId ?? null

/** Why a run skips a script, as the app's runner decides, or null to run it. */
export function skipReason(file: Pick<TreeFile, 'disabled' | 'content'>, databaseId: string | null): string | null {
  if (file.disabled) return 'disabled'
  if (!file.content) return 'empty'
  return databaseId ? null : 'no database'
}

const TIMEOUT_NOTE = ' — the call to the server was cut, probably by the client\'s 5-minute response timeout. '
  + 'The server may have stopped the script midway: check the target database (run_sql) before running it again.'

/** A script's failure as recorded, with what to check when the client cut the call. */
export function runErrorText(e: unknown): string {
  const err = e as Error & { cause?: { code?: string } }
  const cut = err.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' || /fetch failed|terminated/i.test(err.message ?? '')
  return `${err.message ?? String(e)}${cut ? TIMEOUT_NOTE : ''}`
}

/** A run's report around its per-script lines; `writableTarget` is the target's label, null when it is read-only. */
export function runReport(runId: string, failed: boolean, writableTarget: string | null, scriptLines: string[]): string[] {
  const head = `Run ${runId} ${failed ? 'failed' : 'finished'} on `
    + `${writableTarget ? `target ${writableTarget} (writable)` : 'a read-only database'}; recorded in the pipeline's run history.`
  const out = [head, ...scriptLines]
  if (!writableTarget) {
    out.push('The target is not a writable ETL database (one created from a schema), so the scripts ran read-only, '
      + 'as in the app: CREATE / INSERT statements fail there.')
  }
  return out
}

/** New `order` per file id so the scripts run in `ordered`, as the Pipeline tab's drag writes it. */
export function reorderPatch(ordered: Pick<EtlFile, 'id' | 'order'>[]): Map<string, number> {
  const patch = new Map<string, number>()
  ordered.forEach((f, i) => { if (f.order !== i) patch.set(f.id, i) })
  return patch
}

// --- Formatting --------------------------------------------------------------

const lines = (content: string | null | undefined) => (content ? content.split('\n').length : 0)

/** A run's per-script badges, as the app restores them: a script left running by an interrupted run reads "stopped". */
export function lastStatuses(run: EtlRunHistoryEntry | undefined): Map<string, EtlRunLog> {
  const out = new Map<string, EtlRunLog>()
  for (const log of run?.scripts ?? []) out.set(log.fileId, log.status === 'running' ? { ...log, status: 'stopped' } : log)
  return out
}

/** A pipeline's scripts in run order, then its other files, with the last run's outcome per script. */
export function renderPipelineFiles(
  files: TreeFile[], lastRun: EtlRunHistoryEntry | undefined, dbName: (id: string) => string,
): string {
  if (files.length === 0) return 'No file yet.'
  const paths = pathsById(files)
  const statuses = lastStatuses(lastRun)
  const scripts = pipelineScripts(files)
  const out: string[] = []
  out.push(scripts.length ? 'Scripts in run order:' : 'No SQL script yet.')
  scripts.forEach((f, i) => {
    const s = statuses.get(f.id)
    const tags = [
      `order ${f.order}`, `${lines(f.content)} lines`,
      ...(f.disabled ? ['DISABLED (skipped by a full run)'] : []),
      ...(f.dataSourceId ? [`runs on ${dbName(f.dataSourceId)}`] : []),
      ...(s ? [`last run: ${s.status}${s.durationMs != null ? ` ${formatDuration(s.durationMs)}` : ''}`] : []),
    ]
    out.push(`  ${i + 1}. ${paths.get(f.id)} (${tags.join(' · ')})`)
  })
  const scriptIds = new Set(scripts.map((f) => f.id))
  const others = files.filter((f) => !scriptIds.has(f.id)).sort((a, b) => paths.get(a.id)!.localeCompare(paths.get(b.id)!))
  if (others.length) {
    out.push('Other files (not run):')
    for (const f of others) {
      out.push(`  - ${paths.get(f.id)}${f.type === 'folder' ? '/' : ` (${f.language ?? 'file'}, ${lines(f.content)} lines)`}`)
    }
  }
  return out.join('\n')
}

/** A collection's tree, folders first then by path. */
export function renderCollectionFiles(files: TreeFile[]): string {
  if (files.length === 0) return 'No script yet.'
  const paths = pathsById(files)
  return [...files]
    .sort((a, b) => paths.get(a.id)!.localeCompare(paths.get(b.id)!))
    .map((f) => {
      const p = paths.get(f.id)!
      const depth = p.split('/').length - 1
      return `${'  '.repeat(depth)}${f.name}${f.type === 'folder' ? '/' : ` (${lines(f.content)} lines)`}`
    })
    .join('\n')
}

const runDuration = (r: EtlRunHistoryEntry) =>
  r.completedAt ? ` · ${formatDuration(new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime())}` : ''

export function formatRunSummary(r: EtlRunHistoryEntry): string {
  const counts = new Map<string, number>()
  for (const s of r.scripts ?? []) counts.set(s.status, (counts.get(s.status) ?? 0) + 1)
  const tally = [...counts].map(([k, n]) => `${n} ${k}`).join(', ') || 'no script'
  return `- run_id: ${r.id} · started ${r.startedAt} · ${r.status}${runDuration(r)} · ${tally}`
}

/** One run in full: each script's outcome, output and error. */
export function formatRun(r: EtlRunHistoryEntry, files: TreeFile[]): string {
  const paths = pathsById(files)
  const out = [`Run ${r.id}: ${r.status}, started ${r.startedAt}${r.completedAt ? `, ended ${r.completedAt}` : ''}${runDuration(r)}.`]
  if (r.status === 'running') out.push('Marked running: either in progress now, or interrupted before it could record its end.')
  for (const s of r.scripts ?? []) {
    const name = paths.get(s.fileId) ?? `(deleted file ${s.fileId})`
    const detail = s.error ? `\n      error: ${clip(s.error, 1500)}` : s.output ? ` — ${s.output}` : ''
    const progress = s.status === 'running' && s.statementsTotal ? ` (statement ${s.statementsDone ?? 0}/${s.statementsTotal})` : ''
    out.push(`  - ${name}: ${s.status}${s.durationMs != null ? ` in ${formatDuration(s.durationMs)}` : ''}${progress}${detail}`)
  }
  if (!r.scripts?.length) out.push('  (no script recorded)')
  return out.join('\n')
}
