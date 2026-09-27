/** ETL pipelines (scripts that build a database from another) and SQL script collections. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import type {
  EntityFilesConfig, EtlPipeline, EtlRunHistoryEntry, EtlRunLog, MappingProject, SqlScriptCollection,
} from '@/types'
import { buildPointer } from '@/lib/import-identity'
import { resolveRolePrefixes } from '@/lib/duckdb/role-prefix'
import { slugifyId, uniqueEntityId } from '@/lib/slugify-id'
import { nextEtlOrder, orderByNamePatch } from '@/features/warehouse/etl/etl-file-language'
import { formatRows } from './cohorts.js'
import {
  etlRoles, findByPath, formatRun, formatRunSummary, isSqlFile, mappingDataOf, moveChanges,
  normalizePath, pathsById, pipelineScripts, planMove, planWrite, pruneMarks, renameMarks, renderCollectionFiles,
  renderPipelineFiles, reorderPatch, rowsOutput, runErrorText, runReport, scriptDatabaseId,
  serverRoleSchemas, skipReason, type TreeFile,
} from './etl.js'
import { clip, pointerRows, subtreeIds } from './helpers.js'
import {
  DESTRUCTIVE, READ, WRITE, api, authored, failure, guard, loc, text, type Server, type ToolResult,
} from './shared.js'

// --- REST --------------------------------------------------------------------

type Pipeline = EtlPipeline
type Collection = SqlScriptCollection
type EtlNode = TreeFile & { pipelineId: string; createdAt?: string }
type SqlNode = TreeFile & { collectionId: string; createdAt?: string }

interface Db {
  id: string
  entityId?: string
  lineageId?: string
  workspaceId?: string | null
  name: Record<string, string> | string
  sourceType: string
  status: string
  isVocabularyReference?: boolean
  // Only `managed` is read: a server-owned DuckDB file, the one kind an ETL run may write.
  connectionConfig?: { managed?: boolean } | null
}

const enc = encodeURIComponent
const qs = (workspaceId?: string) => (workspaceId ? `?workspaceId=${enc(workspaceId)}` : '')

const etl = {
  list: (workspaceId?: string) => api.request<Pipeline[]>('GET', `/etl-pipelines${qs(workspaceId)}`),
  get: (id: string) => api.request<Pipeline>('GET', `/etl-pipelines/${enc(id)}`),
  create: (body: Record<string, unknown>) => api.request<Pipeline>('POST', '/etl-pipelines', body),
  update: (id: string, changes: Record<string, unknown>) => api.request<Pipeline>('PATCH', `/etl-pipelines/${enc(id)}`, changes),
  delete: (id: string) => api.request<void>('DELETE', `/etl-pipelines/${enc(id)}`),
  files: (id: string) => api.request<EtlNode[]>('GET', `/etl-pipelines/${enc(id)}/files`),
  deleteFiles: (id: string) => api.request<void>('DELETE', `/etl-pipelines/${enc(id)}/files`),
  createFile: (body: Record<string, unknown>) => api.request<EtlNode>('POST', '/etl-files', body),
  updateFile: (id: string, changes: Record<string, unknown>) => api.request<EtlNode>('PATCH', `/etl-files/${enc(id)}`, changes),
  deleteFile: (id: string) => api.request<void>('DELETE', `/etl-files/${enc(id)}`),
  runs: (id: string) => api.request<EtlRunHistoryEntry[]>('GET', `/etl-pipelines/${enc(id)}/runs`),
  // An upsert keyed by the run id: the same row is re-sent as the run advances.
  saveRun: (entry: EtlRunHistoryEntry) => api.request<EtlRunHistoryEntry>('POST', '/etl-runs', entry),
  run: (targetId: string, body: { sql: string; roles: Record<string, string>; mappingData: Record<string, string> }) =>
    api.request<{ rows: Record<string, unknown>[] }>('POST', `/data-sources/${enc(targetId)}/etl-run`, body),
}

const sql = {
  list: (workspaceId?: string) => api.request<Collection[]>('GET', `/sql-script-collections${qs(workspaceId)}`),
  get: (id: string) => api.request<Collection>('GET', `/sql-script-collections/${enc(id)}`),
  create: (body: Record<string, unknown>) => api.request<Collection>('POST', '/sql-script-collections', body),
  update: (id: string, changes: Record<string, unknown>) =>
    api.request<Collection>('PATCH', `/sql-script-collections/${enc(id)}`, changes),
  delete: (id: string) => api.request<void>('DELETE', `/sql-script-collections/${enc(id)}`),
  files: (id: string) => api.request<SqlNode[]>('GET', `/sql-script-collections/${enc(id)}/files`),
  deleteFiles: (id: string) => api.request<void>('DELETE', `/sql-script-collections/${enc(id)}/files`),
  createFile: (body: Record<string, unknown>) => api.request<SqlNode>('POST', '/sql-script-files', body),
  updateFile: (id: string, changes: Record<string, unknown>) =>
    api.request<SqlNode>('PATCH', `/sql-script-files/${enc(id)}`, changes),
  deleteFile: (id: string) => api.request<void>('DELETE', `/sql-script-files/${enc(id)}`),
}

const listDbs = () => api.request<Db[]>('GET', '/data-sources')
const listWorkspaces = () => api.request<{ id: string; name: Record<string, string> }[]>('GET', '/workspaces')

// --- Shared bits -------------------------------------------------------------

const isManaged = (db: Db | undefined) => !!db?.connectionConfig?.managed

/** The databases a pipeline or a collection may point at: the app's pickers (databaseOptions). */
const pickable = (dbs: Db[], workspaceId: string) =>
  dbs.filter((d) => d.workspaceId === workspaceId && d.sourceType === 'database' && !d.isVocabularyReference)

const dbLabel = (dbs: Db[]) => (id: string | null | undefined) => {
  if (!id) return '(none)'
  const d = dbs.find((x) => x.id === id)
  return d ? `"${loc(d.name)}" (${id})` : `${id} (not found)`
}

/** A database picked for an entity, checked like the picker offers it. */
function pickDb(dbs: Db[], workspaceId: string, id: string, what: string): Db {
  const d = dbs.find((x) => x.id === id)
  if (!d) throw new Error(`No database ${id} (${what}). list_etl_pipelines with a workspace_id lists the workspace's databases.`)
  if (!pickable(dbs, workspaceId).includes(d)) {
    throw new Error(`Database ${id} cannot be the ${what}: it is not a database of workspace ${workspaceId} (or it is a vocabulary reference).`)
  }
  return d
}

function workspaceDbList(dbs: Db[], workspaceId: string): string {
  const own = pickable(dbs, workspaceId)
  if (own.length === 0) return 'No database in this workspace.'
  return 'Databases of this workspace (usable as source / target / default database):\n' + own.map((d) =>
    `  - "${loc(d.name)}" — database_id: ${d.id} · ${d.status}${isManaged(d) ? ' · writable ETL target (created from a schema)' : ''}`,
  ).join('\n')
}

const ifGiven = <T>(v: T | undefined, f: (v: T) => Record<string, unknown>) => (v === undefined ? {} : f(v))
const orNull = (v: string | null | undefined) => (v ? v : null)

// --- Tree edits shared by pipelines and collections --------------------------

interface TreeApi {
  kind: 'etl' | 'sql'
  owner: string
  fk: 'pipelineId' | 'collectionId'
  files: () => Promise<TreeFile[]>
  createFile: (body: Record<string, unknown>) => Promise<unknown>
  updateFile: (id: string, changes: Record<string, unknown>) => Promise<unknown>
  deleteFile: (id: string) => Promise<unknown>
  config: () => Promise<EntityFilesConfig | null | undefined>
  saveConfig: (config: EntityFilesConfig) => Promise<unknown>
  listTool: string
}

const etlTree = (pipelineId: string): TreeApi => ({
  kind: 'etl', owner: pipelineId, fk: 'pipelineId',
  files: () => etl.files(pipelineId),
  createFile: etl.createFile, updateFile: etl.updateFile, deleteFile: etl.deleteFile,
  config: async () => (await etl.get(pipelineId)).config,
  saveConfig: (config) => etl.update(pipelineId, { config }),
  listTool: 'get_etl_pipeline',
})

const sqlTree = (collectionId: string): TreeApi => ({
  kind: 'sql', owner: collectionId, fk: 'collectionId',
  files: () => sql.files(collectionId),
  createFile: sql.createFile, updateFile: sql.updateFile, deleteFile: sql.deleteFile,
  config: async () => (await sql.get(collectionId)).config,
  saveConfig: (config) => sql.update(collectionId, { config }),
  listTool: 'get_sql_collection',
})

/** The `order` a new node gets: the ETL Scripts tab's max + 1, the SQL dialog's node count. */
const newOrder = (t: TreeApi, files: TreeFile[]) => (t.kind === 'etl' ? nextEtlOrder(files) : files.length)

/** Create the folders missing on the way to a path (names checked by the plan); returns the id of the last one. */
async function ensureFolders(t: TreeApi, files: TreeFile[], parentId: string | null, missing: string[]): Promise<string | null> {
  let parent = parentId
  for (const name of missing) {
    const node = {
      id: randomUUID(), [t.fk]: t.owner, name, type: 'folder', parentId: parent,
      order: newOrder(t, files), createdAt: new Date().toISOString(),
    }
    await t.createFile(node)
    files.push(node as unknown as TreeFile)
    parent = node.id
  }
  return parent
}

async function readFile(t: TreeApi, path: string): Promise<ToolResult> {
  const node = findByPath(await t.files(), normalizePath(path))
  if (!node) return failure(`No file "${path}" — see ${t.listTool}.`)
  if (node.type === 'folder') return failure(`"${path}" is a folder.`)
  return text(node.content || '(empty file)')
}

async function writeFile(t: TreeApi, rawPath: string, content: string): Promise<ToolResult> {
  const path = normalizePath(rawPath)
  const files = await t.files()
  const plan = planWrite(files, path, t.kind === 'etl')
  if ('error' in plan) return failure(plan.error)
  if ('updateId' in plan) {
    await t.updateFile(plan.updateId, { content })
    return text(`Updated ${path} (${content.split('\n').length} lines).`)
  }
  const { parentId, missing, name, language } = plan.create
  const parent = await ensureFolders(t, files, parentId, missing)
  const node: Record<string, unknown> = {
    id: randomUUID(), [t.fk]: t.owner, name, type: 'file', parentId: parent, content,
    order: newOrder(t, files), createdAt: new Date().toISOString(), ...(language ? { language } : {}),
  }
  await t.createFile(node)
  const note = t.kind === 'etl' && language === 'sql'
    ? ` It runs last in the pipeline (order ${node.order}); reorder_etl_scripts changes that.` : ''
  return text(`Created ${path} (${content.split('\n').length} lines).${note}`)
}

async function moveFile(t: TreeApi, rawPath: string, rawNewPath: string): Promise<ToolResult> {
  const path = normalizePath(rawPath)
  const newPath = normalizePath(rawNewPath)
  const files = await t.files()
  const plan = planMove(files, path, newPath, t.kind === 'etl', t.listTool)
  if ('error' in plan) return failure(plan.error)
  if ('unchanged' in plan) return text('Nothing to move.')
  const parent = await ensureFolders(t, files, plan.parentId, plan.missing)
  await t.updateFile(plan.node.id, moveChanges(plan.node, plan.name, parent, t.kind === 'etl'))
  // Versioning marks are keyed by path: carried to the new one, as the app's stores do.
  const next = renameMarks(await t.config(), path, newPath)
  if (next) await t.saveConfig(next)
  return text(`Moved ${path} → ${newPath}.`)
}

async function deleteFile(t: TreeApi, rawPath: string): Promise<ToolResult> {
  const path = normalizePath(rawPath)
  const files = await t.files()
  const node = findByPath(files, path)
  if (!node) return failure(`No file or folder "${path}" — see ${t.listTool}.`)
  const ids = subtreeIds(files, node.id)
  for (const id of ids) await t.deleteFile(id)
  const next = pruneMarks(await t.config(), files.filter((f) => !ids.includes(f.id)))
  if (next) await t.saveConfig(next)
  return text(`Deleted ${path}${ids.length > 1 ? ` and the ${ids.length - 1} node(s) under it` : ''}.`)
}

const PATH_PROPS = {
  path: { type: 'string', description: 'Path inside the tree, with extension, e.g. "10_person.sql" or "mapping/concept.csv".' },
} as const

// --- Running a pipeline ------------------------------------------------------

async function vocabIdOf(p: Pipeline): Promise<string | undefined> {
  if (!p.mappingProjectId) return undefined
  try {
    return (await api.getMappingProject(p.mappingProjectId)).vocabularyDataSourceId ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The app's usePipelineRunner.runScripts: one history row for the run, each script
 * in turn against the pipeline's target, stopping at the first failure.
 */
async function runPipeline(p: Pipeline, scripts: EtlNode[], files: EtlNode[], showRows: number): Promise<ToolResult> {
  const dbs = await listDbs()
  const target = dbs.find((d) => d.id === p.targetDataSourceId)
  const managed = isManaged(target)
  const ids = { sourceId: p.sourceDataSourceId, targetId: p.targetDataSourceId, vocabId: await vocabIdOf(p) }
  const roles = etlRoles(ids)
  const mappingData = mappingDataOf(files)
  const paths = pathsById(files)

  const entry: EtlRunHistoryEntry = {
    id: `run-${Date.now()}`, pipelineId: p.id, startedAt: new Date().toISOString(), status: 'running', scripts: [],
  }
  await etl.saveRun(entry)
  const record = async (log: Omit<EtlRunLog, 'id' | 'pipelineId'>) => {
    entry.scripts.push({ id: `log-${log.fileId}-${Date.now()}`, pipelineId: p.id, ...log })
    await etl.saveRun(entry)
  }

  const report: string[] = []
  let lastRows: Record<string, unknown>[] = []
  let failed = false
  for (const file of scripts) {
    const name = paths.get(file.id)
    const dsId = scriptDatabaseId(file, p)
    const skip = skipReason(file, dsId)
    if (skip || !dsId || !file.content) {
      await record({ fileId: file.id, status: 'skipped' })
      report.push(`- ${name}: skipped (${skip})`)
      continue
    }
    const start = Date.now()
    const startedAt = new Date(start).toISOString()
    try {
      const resolved = resolveRolePrefixes(file.content, serverRoleSchemas(ids, managed, dsId))
      const rows = managed
        ? (await etl.run(target!.id, { sql: resolved, roles, mappingData })).rows
        : await api.query(dsId, resolved)
      const durationMs = Date.now() - start
      const output = rowsOutput(rows.length, durationMs)
      await record({
        fileId: file.id, status: 'success', startedAt, completedAt: new Date().toISOString(),
        durationMs, rowsAffected: rows.length, output,
      })
      report.push(`- ${name}: success — ${output}`)
      lastRows = rows
    } catch (e) {
      failed = true
      const error = runErrorText(e)
      await record({
        fileId: file.id, status: 'error', startedAt, completedAt: new Date().toISOString(),
        durationMs: Date.now() - start, error,
      })
      report.push(`- ${name}: ERROR — ${clip(error, 2000)}`)
      break
    }
  }
  entry.status = failed ? 'error' : 'success'
  entry.completedAt = new Date().toISOString()
  await etl.saveRun(entry)

  const out = runReport(entry.id, failed, managed ? dbLabel(dbs)(p.targetDataSourceId) : null, report)
  if (showRows > 0 && !failed && scripts.length === 1) out.push(`Result of the last statement:\n${formatRows(lastRows, showRows)}`)
  return { content: [{ type: 'text', text: out.join('\n') }], ...(failed ? { isError: true } : {}) }
}

// --- Tools -------------------------------------------------------------------

export function registerEtlTools(server: Server): void {
  // --- ETL pipelines ---------------------------------------------------------

  server.registerTool('list_etl_pipelines', {
    description:
      'List ETL pipelines: ordered SQL scripts, in a workspace, that build a TARGET database (usually OMOP) from '
      + 'a SOURCE database (e.g. a hospital export). With workspace_id, also lists that workspace\'s databases '
      + '(the ids to pick a source / target from). Without, every pipeline you can see, with its workspace id.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ workspace_id?: string }>({
      type: 'object', properties: { workspace_id: { type: 'string' } },
    }),
  }, guard(async ({ workspace_id }) => {
    const [pipelines, dbs] = await Promise.all([etl.list(workspace_id), listDbs()])
    const label = dbLabel(dbs)
    const out = pipelines.length === 0 ? ['No ETL pipeline.'] : pipelines.map((p) =>
      `- "${loc(p.name)}" — pipeline_id: ${p.id} · workspace ${p.workspaceId} · ${p.status}`
      + ` · ${label(p.sourceDataSourceId)} → ${label(p.targetDataSourceId)}`)
    if (workspace_id) out.push('', workspaceDbList(dbs, workspace_id))
    else {
      const ws = await listWorkspaces()
      out.push('', 'Workspaces: ' + ws.map((w) => `"${loc(w.name)}" (${w.id})`).join(', '))
    }
    return text(out.join('\n'))
  }))

  server.registerTool('get_etl_pipeline', {
    description:
      'One ETL pipeline: its source and target databases, the concept-mapping project whose vocabulary scripts read '
      + 'as `vocab.`, its scripts in run order (disabled ones, per-script database overrides, last run\'s outcome) '
      + 'and its latest runs. Scripts address the databases by role: `source.table`, `target.table`, `vocab.concept`; '
      + 'mapping exports as read_csv(\'mapping.<name>\').',
    annotations: READ,
    inputSchema: fromJsonSchema<{ pipeline_id: string }>({
      type: 'object', properties: { pipeline_id: { type: 'string' } }, required: ['pipeline_id'],
    }),
  }, guard(async ({ pipeline_id }) => {
    const [p, files, runs, dbs] = await Promise.all([etl.get(pipeline_id), etl.files(pipeline_id), etl.runs(pipeline_id), listDbs()])
    const label = dbLabel(dbs)
    const target = dbs.find((d) => d.id === p.targetDataSourceId)
    let mapping = '(none)'
    if (p.mappingProjectId) {
      try {
        const mp: MappingProject = await api.getMappingProject(p.mappingProjectId)
        mapping = `"${loc(mp.name)}" (${mp.id}) · vocab. = ${label(mp.vocabularyDataSourceId)}`
      } catch {
        mapping = `${p.mappingProjectId} (not found)`
      }
    }
    const out = [
      `Pipeline "${loc(p.name)}" — pipeline_id: ${p.id} · workspace ${p.workspaceId} · ${p.status} · version ${p.version ?? '0.1.0'}`,
      ...(loc(p.description) ? [`Description: ${loc(p.description)}`] : []),
      `Source (source.): ${label(p.sourceDataSourceId)}`,
      `Target (target.): ${label(p.targetDataSourceId)}${target ? (isManaged(target)
        ? ' — writable (created from a schema): scripts can write to it'
        : ' — NOT a writable ETL database: scripts run read-only there') : ''}`,
      `Mapping project: ${mapping}`,
      '',
      renderPipelineFiles(files, runs[0], label),
    ]
    if (runs.length) out.push('', 'Latest runs:', ...runs.slice(0, 3).map(formatRunSummary))
    return text(out.join('\n'))
  }))

  server.registerTool('create_etl_pipeline', {
    description:
      'Create an ETL pipeline in a workspace, as the app\'s New pipeline dialog does (status draft, a README). '
      + 'The target should be a writable database created from a schema (list_etl_pipelines with workspace_id marks '
      + 'them); scripts are added with write_etl_file.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      name: string; source_database_id?: string; target_database_id?: string; workspace_id?: string
      description?: string; version?: string
    }>({
      type: 'object',
      properties: {
        name: { type: 'string' },
        source_database_id: { type: 'string', description: 'The database the scripts read (`source.`).' },
        target_database_id: { type: 'string', description: 'The database the scripts build (`target.`).' },
        workspace_id: { type: 'string', description: 'Default: the source database\'s workspace.' },
        description: { type: 'string' },
        version: { type: 'string', description: 'Semver, default 0.1.0.' },
      },
      required: ['name'],
    }),
  }, guard(async ({ name, source_database_id, target_database_id, workspace_id, description, version }) => {
    const title = name.trim()
    if (!title) return failure('The name is empty.')
    const dbs = await listDbs()
    const workspaceId = workspace_id ?? dbs.find((d) => d.id === source_database_id)?.workspaceId
    if (!workspaceId) return failure('Pass workspace_id (list_etl_pipelines lists the workspaces).')
    if (source_database_id) pickDb(dbs, workspaceId, source_database_id, 'source')
    if (target_database_id) pickDb(dbs, workspaceId, target_database_id, 'target')
    const taken = (await etl.list()).map((p) => p.entityId).filter((x): x is string => !!x)
    const now = new Date().toISOString()
    const body = {
      id: randomUUID(),
      entityId: uniqueEntityId(slugifyId(title), taken),
      workspaceId,
      name: { en: title },
      description: description?.trim() ? { en: description.trim() } : {},
      sourceDataSourceId: source_database_id,
      sourceDataSourceRef: buildPointer(pointerRows(dbs), source_database_id),
      targetDataSourceId: target_database_id,
      targetDataSourceRef: buildPointer(pointerRows(dbs), target_database_id),
      badges: [],
      status: 'draft',
      version: version?.trim() || '0.1.0',
      readme: { en: `# ${title}\n` },
      ...(await authored()), lineageId: randomUUID(),
      createdAt: now,
      updatedAt: now,
    }
    const p = await etl.create(body)
    const warn = target_database_id && !isManaged(dbs.find((d) => d.id === target_database_id))
      ? '\nNote: the target is not a writable ETL database, so scripts will run read-only on it.' : ''
    return text(`Created pipeline "${title}" — pipeline_id: ${p.id}.${warn}`)
  }))

  server.registerTool('update_etl_pipeline', {
    description:
      'Change an ETL pipeline: name, description, README (Markdown), version, its source / target database, or the '
      + 'concept-mapping project whose vocabulary database scripts read as `vocab.`. Only the fields given change; '
      + 'an empty string clears a database or the mapping project.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      pipeline_id: string; name?: string; description?: string; readme?: string; version?: string
      source_database_id?: string; target_database_id?: string; mapping_project_id?: string
    }>({
      type: 'object',
      properties: {
        pipeline_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        readme: { type: 'string' },
        version: { type: 'string' },
        source_database_id: { type: 'string' },
        target_database_id: { type: 'string' },
        mapping_project_id: { type: 'string', description: 'See list_mapping_projects.' },
      },
      required: ['pipeline_id'],
    }),
  }, guard(async (a) => {
    const p = await etl.get(a.pipeline_id)
    const dbs = await listDbs()
    if (a.source_database_id) pickDb(dbs, p.workspaceId, a.source_database_id, 'source')
    if (a.target_database_id) pickDb(dbs, p.workspaceId, a.target_database_id, 'target')
    let mappingRef: unknown = null
    if (a.mapping_project_id) {
      const mp = await api.getMappingProject(a.mapping_project_id)
      mappingRef = buildPointer([mp], mp.id) ?? null
    }
    const changes: Record<string, unknown> = {
      ...ifGiven(a.name, (v) => ({ name: { ...p.name, en: v.trim() } })),
      ...ifGiven(a.description, (v) => ({ description: { ...p.description, en: v } })),
      ...ifGiven(a.readme, (v) => ({ readme: { ...(p.readme ?? {}), en: v } })),
      ...ifGiven(a.version, (v) => ({ version: v.trim() || '0.1.0' })),
      ...ifGiven(a.source_database_id, (v) => ({
        sourceDataSourceId: orNull(v), sourceDataSourceRef: buildPointer(pointerRows(dbs), v || undefined) ?? null,
      })),
      ...ifGiven(a.target_database_id, (v) => ({
        targetDataSourceId: orNull(v), targetDataSourceRef: buildPointer(pointerRows(dbs), v || undefined) ?? null,
      })),
      ...ifGiven(a.mapping_project_id, (v) => ({ mappingProjectId: orNull(v), mappingProjectRef: mappingRef })),
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    await etl.update(p.id, changes)
    return text(`Updated pipeline ${p.id}: ${Object.keys(changes).filter((k) => !k.endsWith('Ref')).join(', ')}.`)
  }))

  server.registerTool('delete_etl_pipeline', {
    description: 'Delete an ETL pipeline with its scripts and run history (the databases are kept). '
      + 'Ask the user first: this cannot be undone.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ pipeline_id: string }>({
      type: 'object', properties: { pipeline_id: { type: 'string' } }, required: ['pipeline_id'],
    }),
  }, guard(async ({ pipeline_id }) => {
    const p = await etl.get(pipeline_id)
    await etl.deleteFiles(p.id)
    await etl.delete(p.id)
    return text(`Deleted pipeline "${loc(p.name)}".`)
  }))

  // --- Pipeline files --------------------------------------------------------

  server.registerTool('read_etl_file', {
    description: 'The content of one file of an ETL pipeline (a script, a Markdown note, a mapping export CSV).',
    annotations: READ,
    inputSchema: fromJsonSchema<{ pipeline_id: string; path: string }>({
      type: 'object', properties: { pipeline_id: { type: 'string' }, ...PATH_PROPS }, required: ['pipeline_id', 'path'],
    }),
  }, guard(async ({ pipeline_id, path }) => readFile(etlTree(pipeline_id), path)))

  server.registerTool('write_etl_file', {
    description:
      'Create or overwrite a file of an ETL pipeline (.sql scripts run in the pipeline; .md is documentation). '
      + 'A new script is appended at the END of the run order. Overwriting replaces the whole file: read it first. '
      + 'Scripts use `source.` / `target.` / `vocab.` qualifiers, never a database\'s internal schema name.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ pipeline_id: string; path: string; content: string }>({
      type: 'object',
      properties: { pipeline_id: { type: 'string' }, ...PATH_PROPS, content: { type: 'string' } },
      required: ['pipeline_id', 'path', 'content'],
    }),
  }, guard(async ({ pipeline_id, path, content }) => writeFile(etlTree(pipeline_id), path, content)))

  server.registerTool('move_etl_file', {
    description: 'Rename or move a file (or folder) of an ETL pipeline. Its place in the run order is kept.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ pipeline_id: string; path: string; new_path: string }>({
      type: 'object',
      properties: { pipeline_id: { type: 'string' }, ...PATH_PROPS, new_path: { type: 'string' } },
      required: ['pipeline_id', 'path', 'new_path'],
    }),
  }, guard(async ({ pipeline_id, path, new_path }) => moveFile(etlTree(pipeline_id), path, new_path)))

  server.registerTool('delete_etl_file', {
    description: 'Delete a file (or a folder with its content) of an ETL pipeline. Ask the user first: this cannot be undone.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ pipeline_id: string; path: string }>({
      type: 'object', properties: { pipeline_id: { type: 'string' }, ...PATH_PROPS }, required: ['pipeline_id', 'path'],
    }),
  }, guard(async ({ pipeline_id, path }) => deleteFile(etlTree(pipeline_id), path)))

  server.registerTool('update_etl_script', {
    description:
      'Per-script settings of a pipeline script: disabled (a full run skips it) and the database it runs against '
      + '(default: the pipeline\'s target; an empty string restores that).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ pipeline_id: string; path: string; disabled?: boolean; database_id?: string }>({
      type: 'object',
      properties: {
        pipeline_id: { type: 'string' }, ...PATH_PROPS,
        disabled: { type: 'boolean' },
        database_id: { type: 'string' },
      },
      required: ['pipeline_id', 'path'],
    }),
  }, guard(async ({ pipeline_id, path, disabled, database_id }) => {
    const node = findByPath(await etl.files(pipeline_id), normalizePath(path))
    if (!node || node.type !== 'file') return failure(`No script "${path}" — see get_etl_pipeline.`)
    const changes: Record<string, unknown> = {
      ...ifGiven(disabled, (v) => ({ disabled: v })),
      ...ifGiven(database_id, (v) => ({ dataSourceId: orNull(v) })),
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    if (database_id) {
      const p = await etl.get(pipeline_id)
      pickDb(await listDbs(), p.workspaceId, database_id, 'script\'s database')
    }
    await etl.updateFile(node.id, changes)
    return text(`Updated ${path}.`)
  }))

  server.registerTool('reorder_etl_scripts', {
    description:
      'Set the run order of a pipeline\'s SQL scripts: either list every script path in the new order, or '
      + 'by_name to sort them by name (the 00_ / 10_ / 35_ prefix convention), as the Pipeline tab\'s Sort by name.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ pipeline_id: string; paths?: string[]; by_name?: boolean }>({
      type: 'object',
      properties: {
        pipeline_id: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Every SQL script of the pipeline, in run order.' },
        by_name: { type: 'boolean' },
      },
      required: ['pipeline_id'],
    }),
  }, guard(async ({ pipeline_id, paths, by_name }) => {
    const files = await etl.files(pipeline_id)
    const scripts = pipelineScripts(files)
    let patch: Map<string, number>
    if (by_name) {
      patch = orderByNamePatch(scripts)
    } else if (paths?.length) {
      const wanted = paths.map(normalizePath)
      const byPath = new Map([...pathsById(files)].filter(([id]) => scripts.some((s) => s.id === id)).map(([id, p]) => [p, id]))
      const unknown = wanted.filter((p) => !byPath.has(p))
      if (unknown.length) return failure(`Not SQL scripts of this pipeline: ${unknown.join(', ')}.`)
      const missing = [...byPath.keys()].filter((p) => !wanted.includes(p))
      if (missing.length || new Set(wanted).size !== wanted.length) {
        return failure(`List every script exactly once. Missing: ${missing.join(', ') || '(none)'}.`)
      }
      patch = reorderPatch(wanted.map((p) => scripts.find((s) => s.id === byPath.get(p))!))
    } else {
      return failure('Pass paths (the full order) or by_name.')
    }
    for (const [id, order] of patch) await etl.updateFile(id, { order })
    const after = await etl.files(pipeline_id)
    const names = pathsById(after)
    return text(`${patch.size} script(s) moved. Run order:\n`
      + pipelineScripts(after).map((f, i) => `  ${i + 1}. ${names.get(f.id)}`).join('\n'))
  }))

  // --- Runs ------------------------------------------------------------------

  server.registerTool('run_etl_pipeline', {
    description:
      'Run an ETL pipeline as the app\'s Run button does: its enabled SQL scripts in run order (or only the scripts '
      + 'given, even disabled ones), each against the pipeline\'s target, stopping at the first error; the run is '
      + 'recorded in the pipeline\'s run history. On a writable target this WRITES to that database (scripts often '
      + 'drop and rebuild tables), and can overwrite or delete its data: ask the user before running. Waits for the '
      + 'end; a single script over ~5 minutes exceeds the client timeout.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ pipeline_id: string; paths?: string[]; show_rows?: number; ignore_running?: boolean }>({
      type: 'object',
      properties: {
        pipeline_id: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Only these scripts (run in pipeline order). Default: the whole pipeline.' },
        show_rows: { type: 'number', description: 'For a single-script run: show up to this many rows of its last statement\'s result (default 0; max 200). Patient-level rows only if the user asked.' },
        ignore_running: { type: 'boolean', description: 'Run even though the latest run is still marked running (only when it is known to be stale).' },
      },
      required: ['pipeline_id'],
    }),
  }, guard(async ({ pipeline_id, paths, show_rows, ignore_running }) => {
    const [p, files, runs] = await Promise.all([etl.get(pipeline_id), etl.files(pipeline_id), etl.runs(pipeline_id)])
    if (!p.targetDataSourceId) return failure('This pipeline has no target database: set one with update_etl_pipeline.')
    if (runs[0]?.status === 'running' && !ignore_running) {
      return failure(`The latest run (${runs[0].id}, started ${runs[0].startedAt}) is still marked running — maybe the `
        + 'user is running the pipeline in Linkr. Ask them; pass ignore_running only if that run is known to be stale.')
    }
    let scripts: EtlNode[]
    if (paths?.length) {
      const picked = paths.map((raw) => ({ raw, node: findByPath(files, normalizePath(raw)) }))
      const bad = picked.filter(({ node }) => !node || !isSqlFile(node)).map(({ raw }) => raw)
      if (bad.length) return failure(`Not SQL scripts of this pipeline: ${bad.join(', ')} — see get_etl_pipeline.`)
      const chosen = new Set(picked.map(({ node }) => node!.id))
      // Singled out, so run even when disabled — as the app's per-script Run does.
      const ordered = [...pipelineScripts(files), ...files.filter((f) => isSqlFile(f) && f.language !== 'sql')]
      scripts = ordered.filter((f) => chosen.has(f.id)).map((f) => ({ ...f, disabled: false }))
    } else {
      scripts = pipelineScripts(files)
      if (scripts.length === 0) return failure('This pipeline has no SQL script.')
    }
    return runPipeline(p, scripts, files, Math.min(Math.max(show_rows ?? 0, 0), 200))
  }))

  server.registerTool('list_etl_runs', {
    description: 'A pipeline\'s past runs (newest first, the last 50 are kept): when, outcome, scripts per status.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ pipeline_id: string; limit?: number }>({
      type: 'object',
      properties: { pipeline_id: { type: 'string' }, limit: { type: 'number', description: 'Default 10.' } },
      required: ['pipeline_id'],
    }),
  }, guard(async ({ pipeline_id, limit }) => {
    const runs = await etl.runs(pipeline_id)
    if (runs.length === 0) return text('This pipeline has never run.')
    const n = Math.min(Math.max(limit ?? 10, 1), 50)
    return text(runs.slice(0, n).map(formatRunSummary).join('\n')
      + (runs.length > n ? `\n… ${runs.length - n} older run(s).` : ''))
  }))

  server.registerTool('get_etl_run', {
    description: 'One pipeline run in full: each script\'s status, duration, row count or error message.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ pipeline_id: string; run_id?: string }>({
      type: 'object',
      properties: { pipeline_id: { type: 'string' }, run_id: { type: 'string', description: 'Default: the latest run.' } },
      required: ['pipeline_id'],
    }),
  }, guard(async ({ pipeline_id, run_id }) => {
    const [runs, files] = await Promise.all([etl.runs(pipeline_id), etl.files(pipeline_id)])
    const run = run_id ? runs.find((r) => r.id === run_id) : runs[0]
    if (!run) return failure(run_id ? `No run ${run_id} — see list_etl_runs.` : 'This pipeline has never run.')
    return text(formatRun(run, files))
  }))

  // --- SQL script collections ------------------------------------------------

  server.registerTool('list_sql_collections', {
    description:
      'List SQL script collections: folders of reusable SQL queries kept in a workspace, each with a default database '
      + 'they run on. With workspace_id, also lists that workspace\'s databases.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ workspace_id?: string }>({
      type: 'object', properties: { workspace_id: { type: 'string' } },
    }),
  }, guard(async ({ workspace_id }) => {
    const [collections, dbs] = await Promise.all([sql.list(workspace_id), listDbs()])
    const label = dbLabel(dbs)
    const out = collections.length === 0 ? ['No SQL script collection.'] : collections.map((c) =>
      `- "${loc(c.name)}" — collection_id: ${c.id} · workspace ${c.workspaceId} · database ${label(c.defaultDataSourceId)}`)
    if (workspace_id) out.push('', workspaceDbList(dbs, workspace_id))
    return text(out.join('\n'))
  }))

  server.registerTool('get_sql_collection', {
    description: 'One SQL script collection: its description, default database and file tree.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ collection_id: string }>({
      type: 'object', properties: { collection_id: { type: 'string' } }, required: ['collection_id'],
    }),
  }, guard(async ({ collection_id }) => {
    const [c, files, dbs] = await Promise.all([sql.get(collection_id), sql.files(collection_id), listDbs()])
    return text([
      `Collection "${loc(c.name)}" — collection_id: ${c.id} · workspace ${c.workspaceId} · version ${c.version ?? '0.1.0'}`,
      ...(loc(c.description) ? [`Description: ${loc(c.description)}`] : []),
      `Default database: ${dbLabel(dbs)(c.defaultDataSourceId)}`,
      '',
      renderCollectionFiles(files),
    ].join('\n'))
  }))

  server.registerTool('create_sql_collection', {
    description: 'Create a SQL script collection in a workspace, as the app\'s New collection dialog does (with a README).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ name: string; database_id?: string; workspace_id?: string; description?: string; version?: string }>({
      type: 'object',
      properties: {
        name: { type: 'string' },
        database_id: { type: 'string', description: 'The database its scripts run on by default.' },
        workspace_id: { type: 'string', description: 'Default: the database\'s workspace.' },
        description: { type: 'string' },
        version: { type: 'string' },
      },
      required: ['name'],
    }),
  }, guard(async ({ name, database_id, workspace_id, description, version }) => {
    const title = name.trim()
    if (!title) return failure('The name is empty.')
    const dbs = await listDbs()
    const workspaceId = workspace_id ?? dbs.find((d) => d.id === database_id)?.workspaceId
    if (!workspaceId) return failure('Pass workspace_id (list_etl_pipelines lists the workspaces).')
    if (database_id) pickDb(dbs, workspaceId, database_id, 'default database')
    const taken = (await sql.list()).map((c) => c.entityId).filter((x): x is string => !!x)
    const now = new Date().toISOString()
    const c = await sql.create({
      id: randomUUID(),
      entityId: uniqueEntityId(slugifyId(title), taken),
      workspaceId,
      name: { en: title },
      description: { en: description?.trim() ?? '' },
      defaultDataSourceId: database_id,
      defaultDataSourceRef: buildPointer(pointerRows(dbs), database_id),
      badges: [],
      version: version?.trim() || '0.1.0',
      readme: { en: `# ${title}\n` },
      ...(await authored()), lineageId: randomUUID(),
      createdAt: now,
      updatedAt: now,
    })
    return text(`Created collection "${title}" — collection_id: ${c.id}.`)
  }))

  server.registerTool('update_sql_collection', {
    description: 'Change a SQL script collection: name, description, README (Markdown), version or default database '
      + '(empty string clears it). Only the fields given change.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      collection_id: string; name?: string; description?: string; readme?: string; version?: string; database_id?: string
    }>({
      type: 'object',
      properties: {
        collection_id: { type: 'string' },
        name: { type: 'string' }, description: { type: 'string' }, readme: { type: 'string' },
        version: { type: 'string' }, database_id: { type: 'string' },
      },
      required: ['collection_id'],
    }),
  }, guard(async (a) => {
    const c = await sql.get(a.collection_id)
    const dbs = await listDbs()
    if (a.database_id) pickDb(dbs, c.workspaceId, a.database_id, 'default database')
    const changes: Record<string, unknown> = {
      ...ifGiven(a.name, (v) => ({ name: { ...c.name, en: v.trim() } })),
      ...ifGiven(a.description, (v) => ({ description: { ...c.description, en: v } })),
      ...ifGiven(a.readme, (v) => ({ readme: { ...(c.readme ?? {}), en: v } })),
      ...ifGiven(a.version, (v) => ({ version: v.trim() || '0.1.0' })),
      ...ifGiven(a.database_id, (v) => ({
        defaultDataSourceId: orNull(v), defaultDataSourceRef: buildPointer(pointerRows(dbs), v || undefined) ?? null,
      })),
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    await sql.update(c.id, changes)
    return text(`Updated collection ${c.id}: ${Object.keys(changes).filter((k) => !k.endsWith('Ref')).join(', ')}.`)
  }))

  server.registerTool('delete_sql_collection', {
    description: 'Delete a SQL script collection with all its scripts. Ask the user first: this cannot be undone.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ collection_id: string }>({
      type: 'object', properties: { collection_id: { type: 'string' } }, required: ['collection_id'],
    }),
  }, guard(async ({ collection_id }) => {
    const c = await sql.get(collection_id)
    await sql.deleteFiles(c.id)
    await sql.delete(c.id)
    return text(`Deleted collection "${loc(c.name)}".`)
  }))

  server.registerTool('read_sql_collection_file', {
    description: 'The content of one file of a SQL script collection.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ collection_id: string; path: string }>({
      type: 'object', properties: { collection_id: { type: 'string' }, ...PATH_PROPS }, required: ['collection_id', 'path'],
    }),
  }, guard(async ({ collection_id, path }) => readFile(sqlTree(collection_id), path)))

  server.registerTool('write_sql_collection_file', {
    description: 'Create or overwrite a file of a SQL script collection (.sql, or .md notes); folders are created as '
      + 'needed. Overwriting replaces the whole file: read it first.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ collection_id: string; path: string; content: string }>({
      type: 'object',
      properties: { collection_id: { type: 'string' }, ...PATH_PROPS, content: { type: 'string' } },
      required: ['collection_id', 'path', 'content'],
    }),
  }, guard(async ({ collection_id, path, content }) => writeFile(sqlTree(collection_id), path, content)))

  server.registerTool('move_sql_collection_file', {
    description: 'Rename or move a file or folder of a SQL script collection.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ collection_id: string; path: string; new_path: string }>({
      type: 'object',
      properties: { collection_id: { type: 'string' }, ...PATH_PROPS, new_path: { type: 'string' } },
      required: ['collection_id', 'path', 'new_path'],
    }),
  }, guard(async ({ collection_id, path, new_path }) => moveFile(sqlTree(collection_id), path, new_path)))

  server.registerTool('delete_sql_collection_file', {
    description: 'Delete a file (or a folder with its content) of a SQL script collection. Ask the user first: this cannot be undone.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ collection_id: string; path: string }>({
      type: 'object', properties: { collection_id: { type: 'string' }, ...PATH_PROPS }, required: ['collection_id', 'path'],
    }),
  }, guard(async ({ collection_id, path }) => deleteFile(sqlTree(collection_id), path)))

  server.registerTool('run_sql_collection_script', {
    description:
      'Run one script of a SQL script collection on its default database (or database_id), as the collection '
      + 'editor\'s Run does: read-only, statements in order, the last one\'s rows returned. A .md file is returned as text.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ collection_id: string; path: string; database_id?: string; max_rows?: number }>({
      type: 'object',
      properties: {
        collection_id: { type: 'string' }, ...PATH_PROPS,
        database_id: { type: 'string', description: 'Run on this database instead of the collection\'s default (not saved).' },
        max_rows: { type: 'number', description: 'Rows shown, default 50, max 500. Aggregate rather than list.' },
      },
      required: ['collection_id', 'path'],
    }),
  }, guard(async ({ collection_id, path, database_id, max_rows }) => {
    const [c, files] = await Promise.all([sql.get(collection_id), sql.files(collection_id)])
    const node = findByPath(files, normalizePath(path))
    if (!node || node.type !== 'file') return failure(`No script "${path}" — see get_sql_collection.`)
    if (node.name.toLowerCase().endsWith('.md')) return text(node.content || '(empty file)')
    if (!node.content?.trim()) return failure(`${path} is empty.`)
    const dbId = database_id ?? c.defaultDataSourceId
    if (!dbId) return failure('The collection has no default database: pass database_id, or set one with update_sql_collection.')
    const start = Date.now()
    const rows = await api.query(dbId, node.content)
    return text(`${rowsOutput(rows.length, Date.now() - start)} on database ${dbId}.\n`
      + formatRows(rows, Math.min(Math.max(max_rows ?? 50, 1), 500)))
  }))
}
