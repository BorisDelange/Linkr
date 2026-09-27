/**
 * Lab extras: dataset editing (the op log, types, import options, analyses),
 * the project Pipeline diagram, Patient data boards, workspace plugins, and the
 * dashboard actions tools-lab.ts leaves out (duplicate, reorder, move).
 */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { columnId, retypeAddedColumn, type DatasetCellValue, type DatasetOp, type DatasetOpColumnType } from '@linkr/format'
import { copyName } from '@/lib/copy-name'
import { coerceValue, fitsColumnType } from '@/lib/dataset-utils'
import { buildPointer } from '@/lib/import-identity'
import { computePluginContentHash } from '@/lib/plugin-hash'
import { userToAuthorDetails } from '@/lib/user-identity'
import type {
  DashboardWidget, LocalizedString, PatientDashboard, PatientDashboardTab,
  PatientDashboardWidget, Pipeline, PipelineNodeType,
} from '@/types'
import type { PluginManifest } from '@/types/plugin'
import type { DatasetNode } from './api.js'
import { bilingual, findColumn, layoutSchema, placeWidget, resolveColumns, type DatasetColumn, type Layout } from './lab.js'
import {
  COLUMN_TYPES, PIPELINE_NODE_TYPES, buildRowFilters, cellValue, checkNodeFields, checkPatientConfig, checkPluginFiles,
  columnOrderWith, connectError, describePipeline, formatRowPage, listPatientPlugins, newPipelineNode, nextAddedRow,
  nextNodePosition, nodeData, opBase, patientWidgetSize, reorderIds, resolveTimelineMapping, scaffoldManifest,
  scaffoldTemplate, summarizeOps, templateFile, undoStart, withoutNode,
  type NodeFields, type PluginLanguage, type PluginScope, type RowFilterInput,
} from './lab-extra.js'
import { findPlugin, pluginDoc, pluginSummary } from './plugins.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, text, type Server } from './shared.js'

const q = encodeURIComponent

const LAYOUT_SCHEMA = layoutSchema('rows')

// --- REST wrappers ------------------------------------------------------------

type DsNode = DatasetNode & { parseOptions?: Record<string, unknown> | null; ops?: DatasetOp[] | null }

interface DatasetAnalysis {
  id: string; projectUid: string; datasetPath: string; name: string; type: string; config: Record<string, unknown>
}

interface UserPluginRow {
  id: string; entityId?: string | null; workspaceId: string; files: Record<string, string>; version?: string
  lineageId?: string | null; readme?: unknown; updatedAt?: string
}

const ds = {
  meta: (projectUid: string, path: string) =>
    api.request<DsNode>('GET', `/dataset-files/meta?projectUid=${q(projectUid)}&path=${q(path)}`),
  ops: (projectUid: string, path: string, ops: DatasetOp[], replace = false) =>
    api.request<{ node: DsNode; ops: DatasetOp[] }>('POST', '/dataset-files/ops', { projectUid, path, ops, replace }),
  rows: (projectUid: string, path: string, body: Record<string, unknown>) =>
    api.request<{ rows: Record<string, unknown>[]; total: number }>(
      'POST', `/dataset-files/rows/query?projectUid=${q(projectUid)}&path=${q(path)}`, body,
    ),
  distinct: (projectUid: string, path: string, colId: string, limit: number, search?: string) =>
    api.request<unknown>(
      'GET', `/dataset-files/columns/${q(colId)}/distinct?projectUid=${q(projectUid)}&path=${q(path)}&limit=${limit}`
        + (search ? `&search=${q(search)}` : ''),
    ),
  reimport: (projectUid: string, path: string, parseOptions: Record<string, unknown>) =>
    api.request<DsNode>('POST', '/dataset-files/reimport', { projectUid, path, parseOptions }),
  previewPath: (projectUid: string, path: string, parseOptions: Record<string, unknown>) =>
    api.request<{ columns: DatasetColumn[]; preview: Record<string, unknown>[]; rowCount: number; sheetNames?: string[] | null }>(
      'POST', '/dataset-files/preview-path', { projectUid, path, parseOptions },
    ),
  analyses: (projectUid: string, path: string) =>
    api.request<DatasetAnalysis[]>('GET', `/dataset-files/analyses?projectUid=${q(projectUid)}&path=${q(path)}`),
}

const patient = {
  list: (projectUid: string) => api.request<PatientDashboard[]>('GET', `/patient-dashboards?projectUid=${q(projectUid)}`),
  get: (id: string) => api.request<PatientDashboard>('GET', `/patient-dashboards/${q(id)}`),
  create: (body: Record<string, unknown>) => api.request<PatientDashboard>('POST', '/patient-dashboards', body),
  update: (id: string, body: Record<string, unknown>) => api.request<PatientDashboard>('PATCH', `/patient-dashboards/${q(id)}`, body),
  remove: (id: string) => api.request<void>('DELETE', `/patient-dashboards/${q(id)}`),
  tabs: (id: string) => api.request<PatientDashboardTab[]>('GET', `/patient-dashboards/${q(id)}/tabs`),
  tab: (id: string) => api.request<PatientDashboardTab>('GET', `/patient-dashboards/tabs/${q(id)}`),
  createTab: (body: Record<string, unknown>) => api.request<PatientDashboardTab>('POST', '/patient-dashboards/tabs', body),
  updateTab: (id: string, body: Record<string, unknown>) => api.request<PatientDashboardTab>('PATCH', `/patient-dashboards/tabs/${q(id)}`, body),
  removeTab: (id: string) => api.request<void>('DELETE', `/patient-dashboards/tabs/${q(id)}`),
  widgets: (tabId: string) => api.request<PatientDashboardWidget[]>('GET', `/patient-dashboards/tabs/${q(tabId)}/widgets`),
  widget: (id: string) => api.request<PatientDashboardWidget>('GET', `/patient-dashboards/widgets/${q(id)}`),
  createWidget: (body: Record<string, unknown>) => api.request<PatientDashboardWidget>('POST', '/patient-dashboards/widgets', body),
  updateWidget: (id: string, body: Record<string, unknown>) => api.request<PatientDashboardWidget>('PATCH', `/patient-dashboards/widgets/${q(id)}`, body),
  removeWidget: (id: string) => api.request<void>('DELETE', `/patient-dashboards/widgets/${q(id)}`),
}

const plugins = {
  list: (workspaceId: string) => api.request<UserPluginRow[]>('GET', `/user-plugins?workspaceId=${q(workspaceId)}`),
  get: (id: string) => api.request<UserPluginRow>('GET', `/user-plugins/${q(id)}`),
  create: (body: Record<string, unknown>) => api.request<UserPluginRow>('POST', '/user-plugins', body),
  update: (id: string, body: Record<string, unknown>) => api.request<UserPluginRow>('PATCH', `/user-plugins/${q(id)}`, body),
  remove: (id: string) => api.request<void>('DELETE', `/user-plugins/${q(id)}`),
}

// --- Shared lookups -----------------------------------------------------------

async function me() {
  const user = await api.me()
  const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.username
  return {
    by: String(user.id),
    authored: {
      createdById: user.id, createdBy: name,
      createdByDetails: userToAuthorDetails(user as unknown as Parameters<typeof userToAuthorDetails>[0]),
    },
  }
}

function columnsOf(node: DsNode): (DatasetColumn & Record<string, unknown>)[] {
  return (node.columns ?? []) as (DatasetColumn & Record<string, unknown>)[]
}

const colList = (cols: DatasetColumn[]) => cols.map((c) => c.name).join(', ')

/** A manifest parsed from a plugin row, or null when plugin.json is unreadable. */
function manifestOf(row: UserPluginRow): PluginManifest | null {
  try { return JSON.parse(row.files['plugin.json'] ?? '') as PluginManifest } catch { return null }
}

/** Rows the app seeds from its own built-ins: listed, but their code is in the bundle. */
const isBuiltinRow = (m: PluginManifest | null) => !!m?.id?.startsWith('linkr-')

async function workspaceOfProject(projectUid: string): Promise<string | null> {
  return (await api.getProject(projectUid)).workspaceId ?? null
}

/** A plugin by manifest id: built-in first, then the workspace's own. */
async function resolvePlugin(
  pluginId: string, scope: PluginScope, workspaceId: string | null,
): Promise<{ manifest: PluginManifest; templates: Record<string, string> } | null> {
  const builtIn = scope === 'lab'
    ? findPlugin(pluginId)
    : listPatientPlugins().find((p) => p.id === pluginId || p.id === `linkr-widget-${pluginId}`)
  if (builtIn) return { manifest: builtIn, templates: builtIn.templates ?? {} }
  if (!workspaceId) return null
  for (const row of await plugins.list(workspaceId)) {
    const m = manifestOf(row)
    if (!m || (m.id !== pluginId && row.id !== pluginId) || isBuiltinRow(m)) continue
    if ((m.scope ?? 'lab') !== scope) return null
    const templates: Record<string, string> = {}
    for (const [f, content] of Object.entries(row.files)) {
      if (f.endsWith('.py.template')) templates.python = content
      else if (f.endsWith('.R.template')) templates.r = content
    }
    return { manifest: m, templates }
  }
  return null
}

/** The language a script plugin runs in: the one asked for if it has a template,
 *  else Python when it has one, else R. Undefined for a component plugin. */
function scriptLanguage(
  manifest: PluginManifest, templates: Record<string, string>, requested?: PluginLanguage,
): { language?: PluginLanguage; error?: string } {
  if (manifest.runtime?.includes('component') || Object.keys(templates).length === 0) return {}
  if (requested) {
    return templates[requested] ? { language: requested } : { error: `${manifest.id} has no ${requested} template (has: ${Object.keys(templates).join(', ')}).` }
  }
  return { language: templates.python ? 'python' : 'r' }
}

// --- Pipeline -----------------------------------------------------------------

async function projectPipeline(projectUid: string, create: boolean): Promise<Pipeline | null> {
  const [existing] = await api.request<Pipeline[]>('GET', `/pipelines?projectUid=${q(projectUid)}`)
  if (existing || !create) return existing ?? null
  return api.request<Pipeline>('POST', '/pipelines', {
    id: randomUUID(), projectUid, name: bilingual('Main pipeline'), nodes: [], edges: [],
  })
}

const savePipeline = (p: Pipeline, nodes: Pipeline['nodes'], edges: Pipeline['edges']) =>
  api.request<Pipeline>('PATCH', `/pipelines/${q(p.id)}`, { nodes, edges })

/** Refuse links to entities the project does not have: the node panel would show
 *  an empty picker and the diagram a dangling reference. */
async function checkNodeLinks(projectUid: string, f: NodeFields): Promise<string | null> {
  if (f.dataSourceId) {
    const linked = (await api.getProject(projectUid)).linkedDataSourceIds ?? []
    if (!linked.includes(f.dataSourceId)) return `Database ${f.dataSourceId} is not linked to this project (see get_project_context).`
  }
  if (f.cohortId && !(await api.listCohorts(projectUid)).some((c) => c.id === f.cohortId)) {
    return `No cohort ${f.cohortId} in this project (see list_cohorts).`
  }
  if (f.dashboardId && !(await api.listDashboards(projectUid)).some((d) => d.id === f.dashboardId)) {
    return `No dashboard ${f.dashboardId} in this project (see list_dashboards).`
  }
  if (f.scripts?.length) {
    const paths = new Set((await api.listScripts(projectUid)).filter((s) => s.type === 'file').map((s) => s.path))
    const missing = f.scripts.filter((s) => !paths.has(s))
    if (missing.length) return `No script ${missing.join(', ')} in this project (see list_scripts).`
  }
  return null
}

const NODE_FIELD_SCHEMA = {
  label: { type: 'string', description: 'Shown on the node. Default: its type.' },
  database_id: { type: 'string', description: 'database node: a database linked to the project.' },
  cohort_id: { type: 'string', description: 'cohort node: one of the project\'s cohorts.' },
  dashboard_id: { type: 'string', description: 'dashboard node: one of the project\'s dashboards.' },
  dataset_name: { type: 'string', description: 'dataset node: the output dataset\'s name.' },
  scripts: { type: 'array', items: { type: 'string' }, description: 'scripts node: IDE script paths, in run order (replaces the list).' },
} as const

interface NodeArgs {
  label?: string; database_id?: string; cohort_id?: string; dashboard_id?: string; dataset_name?: string; scripts?: string[]
}

const nodeFields = (a: NodeArgs): NodeFields => ({
  label: a.label, dataSourceId: a.database_id, cohortId: a.cohort_id, dashboardId: a.dashboard_id,
  datasetName: a.dataset_name, scripts: a.scripts,
})

// --- Patient boards -----------------------------------------------------------

async function describePatientBoard(board: PatientDashboard): Promise<string> {
  const tabs = (await patient.tabs(board.id)).sort((a, b) => a.displayOrder - b.displayOrder)
  const out = [`Patient board "${loc(board.name)}" — board_id: ${board.id} · database: ${board.dataSourceId ?? '(first usable)'}`]
  if (board.description) out.push(`  ${loc(board.description)}`)
  const flags = [
    board.showWidgetTitles !== undefined && `widget titles ${board.showWidgetTitles ? 'shown' : 'hidden'}`,
    board.fitToHeight && 'fit to height', board.widgetSpacing !== undefined && `spacing ${board.widgetSpacing}px`,
    board.collection && `manual collection into ${board.collection.datasetFileId}`,
  ].filter(Boolean)
  if (flags.length) out.push(`  ${flags.join(' · ')}`)
  for (const tab of tabs) {
    out.push(`  tab "${loc(tab.name)}" — tab_id: ${tab.id}`)
    for (const w of await patient.widgets(tab.id)) {
      const l = w.layout
      out.push(`    widget "${loc(w.name)}" — widget_id: ${w.id} · ${w.pluginId}${w.language ? ` (${w.language})` : ''} · `
        + `layout x${l.x} y${l.y} w${l.w} h${l.h} · config ${JSON.stringify(w.config).slice(0, 400)}`
        + (w.customSql ? ' · custom SQL' : ''))
    }
  }
  if (tabs.length === 0) out.push('  (no tab)')
  return out.join('\n')
}

/** Resolve the dataset mappings of a Timeline config against the project's datasets. */
async function resolveDatasetFields(
  projectUid: string, manifest: PluginManifest, config: Record<string, unknown>,
): Promise<string[]> {
  const errors: string[] = []
  for (const [key, field] of Object.entries(manifest.configSchema ?? {})) {
    if (field.type !== 'dataset-select' || !Array.isArray(config[key])) continue
    const resolved: Record<string, unknown>[] = []
    for (const m of config[key] as Record<string, unknown>[]) {
      const path = typeof m?.datasetFileId === 'string' ? m.datasetFileId : ''
      if (!path) { errors.push(`${key}: each mapping needs datasetFileId (a dataset path, see list_datasets).`); continue }
      const node = await ds.meta(projectUid, path).catch(() => null)
      if (!node) { errors.push(`${key}: no dataset ${path}.`); continue }
      const r = resolveTimelineMapping(m, columnsOf(node))
      errors.push(...r.errors.map((e) => `${key}: ${e}`))
      resolved.push(r.mapping)
    }
    config[key] = resolved
  }
  return errors
}

/** The tab a widget may move or be copied to: on the widget's own dashboard (its
 *  dataset and filters are that project's), and a leaf — a tab with sub-tabs shows
 *  none of its own widgets. A readable refusal otherwise. */
async function widgetTargetTab(fromTabId: string, toTabId: string) {
  const [from, to] = await Promise.all([api.getTab(fromTabId), api.getTab(toTabId)])
  if (from.dashboardId !== to.dashboardId) return 'The target tab is on another dashboard.'
  if ((await api.listTabs(to.dashboardId)).some((t) => t.parentTabId === toTabId)) {
    return 'This tab holds sub-tabs: widgets go on one of its sub-tabs.'
  }
  return to
}

async function boardProject(board: PatientDashboard): Promise<string> {
  if (!board.projectUid) throw new Error('This board belongs to a database cohort, not a project; it is edited from that cohort in Linkr.')
  return board.projectUid
}

export function registerLabExtraTools(server: Server): void {
  // ===========================================================================
  // Datasets
  // ===========================================================================

  server.registerTool('create_dataset', {
    description:
      'Create an empty dataset (a table in the project\'s lab) from a list of columns — the start of a manual '
      + 'collection, filled row by row with add_dataset_rows. Stored as a CSV holding just the header. '
      + 'For a dataset from a database query, use create_dataset_from_query instead.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; columns: { name: string; type?: string }[] }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        path: { type: 'string', description: 'e.g. "collection/sofa" (.csv is added), or inside a folder.' },
        columns: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, type: { type: 'string', enum: COLUMN_TYPES } },
            required: ['name'],
          },
        },
      },
      required: ['project_uid', 'path', 'columns'],
    }),
  }, guard(async ({ project_uid, path, columns }) => {
    const file = /\.[a-z0-9]+$/i.test(path) ? path : `${path}.csv`
    if (!file.toLowerCase().endsWith('.csv')) return failure('An empty dataset is a CSV: use a .csv path or no extension.')
    const ids = columns.map((c) => columnId(c.name))
    const dup = ids.find((id, i) => ids.indexOf(id) !== i)
    if (dup) return failure(`Two columns resolve to the same id ${dup}: names must differ.`)
    const node = await api.request<DsNode>('POST', '/dataset-files/create-empty', {
      projectUid: project_uid, path: file,
      columns: columns.map((c, i) => ({ id: ids[i], name: c.name.trim(), type: c.type ?? 'string', order: i })),
    })
    return text(`Created dataset ${node.path} — columns: ${columnsOf(node).map((c) => `${c.id} (${c.type})`).join(', ')}`)
  }))

  server.registerTool('create_dataset_folder', {
    description: 'Create a folder in the project\'s datasets, to group datasets (move_dataset moves one in).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string }>({
      type: 'object', properties: { project_uid: { type: 'string' }, path: { type: 'string' } }, required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path }) => {
    const node = await api.request<DsNode>('POST', '/dataset-files/folder', { projectUid: project_uid, path })
    return text(`Created folder ${node.path}.`)
  }))

  server.registerTool('find_dataset_rows', {
    description:
      'Rows of a dataset matching filters, sorted and paged, each with its row number — the handle '
      + 'set_dataset_cells and remove_dataset_rows take. Row-level (often patient-level) data: use only when '
      + 'the values are needed, and prefer describe_dataset with stats for summaries.',
    annotations: READ,
    inputSchema: fromJsonSchema<{
      project_uid: string; path: string; filters?: RowFilterInput[]; sort?: { column: string; desc?: boolean }
      offset?: number; limit?: number; columns?: string[]
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        path: { type: 'string' },
        filters: {
          type: 'array',
          description: 'All must match. Per filter, one test: equals / one_of (any column), contains (text), '
            + 'min / max (numbers), from / to (dates, YYYY-MM-DD), missing (true = only empty, false = exclude empty).',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'Name or id.' },
              equals: { type: ['string', 'number', 'boolean'] },
              one_of: { type: 'array', items: { type: ['string', 'number'] } },
              contains: { type: 'string' },
              min: { type: 'number' }, max: { type: 'number' },
              from: { type: 'string' }, to: { type: 'string' },
              missing: { type: 'boolean' },
            },
            required: ['column'],
          },
        },
        sort: { type: 'object', properties: { column: { type: 'string' }, desc: { type: 'boolean' } }, required: ['column'] },
        offset: { type: 'number' },
        limit: { type: 'number', description: 'Default 20, max 100.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Only show these columns (names or ids).' },
      },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path, filters, sort, offset, limit, columns: pick }) => {
    const node = await ds.meta(project_uid, path)
    const cols = columnsOf(node)
    const built = buildRowFilters(filters ?? [], cols)
    const sortCol = sort ? findColumn(cols, sort.column) : undefined
    if (sort && !sortCol) built.errors.push(`No column "${sort.column}" to sort on.`)
    const shown = pick?.length ? pick.map((r) => findColumn(cols, r)) : cols
    if (shown.some((c) => !c)) built.errors.push(`Unknown column in columns (columns: ${colList(cols)}).`)
    if (built.errors.length) return failure(built.errors.join('\n'))
    const n = Math.min(limit ?? 20, 100)
    const start = Math.max(offset ?? 0, 0)
    const page = await ds.rows(project_uid, path, {
      offset: start, limit: n, filters: built.filters, na: built.na,
      ...(sortCol ? { sort: { colId: sortCol.id, dir: sort?.desc ? 'desc' : 'asc' } } : {}),
    })
    // An unedited dataset's cache has no row-number column: its rows are then the
    // raw file's, in order, which only holds for an unfiltered, unsorted page.
    const plain = !built.filters.length && !built.na.length && !sortCol
    const out = [`${page.total} matching row(s); showing ${start + 1}–${start + page.rows.length}.`,
      formatRowPage(page.rows, shown as DatasetColumn[], start, plain)]
    if (page.rows.length && !('__row_ord' in page.rows[0]) && !plain) {
      out.push('(Row numbers "?" are unknown here: the dataset has never been edited, so they are only reported '
        + 'for an unfiltered, unsorted listing.)')
    }
    return text(out.join('\n'))
  }))

  server.registerTool('list_column_values', {
    description: 'The distinct values of a dataset column, alphabetically (up to 1000), optionally matching a search '
      + 'term — to pick filter values or check codes. Aggregate, not row-level.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; column: string; search?: string; limit?: number }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' }, column: { type: 'string', description: 'Name or id.' },
        search: { type: 'string' }, limit: { type: 'number', description: 'Default 200, max 1000.' },
      },
      required: ['project_uid', 'path', 'column'],
    }),
  }, guard(async ({ project_uid, path, column, search, limit }) => {
    const cols = columnsOf(await ds.meta(project_uid, path))
    const col = findColumn(cols, column)
    if (!col) return failure(`No column "${column}" (columns: ${colList(cols)}).`)
    const res = await ds.distinct(project_uid, path, col.id, Math.min(limit ?? 200, 1000), search)
    const values = Array.isArray(res) ? res : ((res as { values?: unknown[] }).values ?? [])
    const body = JSON.stringify(values)
    return text(`${values.length} distinct value(s) of ${col.name}:\n${body.length > 8000 ? `${body.slice(0, 8000)}… (truncated)` : body}`)
  }))

  server.registerTool('add_dataset_column', {
    description:
      'Add an empty column to a dataset. Recorded in the dataset\'s edit history (undoable in Linkr); the raw file '
      + 'is never touched. Fill it with set_dataset_cells.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; name: string; type?: string; after?: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' }, name: { type: 'string' },
        type: { type: 'string', enum: COLUMN_TYPES, description: 'Default string.' },
        after: { type: 'string', description: 'Column (name or id) to insert after; "" for first. Default: last.' },
      },
      required: ['project_uid', 'path', 'name'],
    }),
  }, guard(async ({ project_uid, path, name, type, after }) => {
    const cols = columnsOf(await ds.meta(project_uid, path))
    const trimmed = name.trim()
    const id = columnId(trimmed)
    if (cols.some((c) => c.id === id)) return failure(`A column with id ${id} already exists.`)
    let index: number | undefined
    if (after !== undefined) {
      if (after === '') index = 0
      else {
        const prev = findColumn(cols, after)
        if (!prev) return failure(`No column "${after}" (columns: ${colList(cols)}).`)
        index = cols.findIndex((c) => c.id === prev.id) + 1
      }
    }
    const { by } = await me()
    await ds.ops(project_uid, path, [{
      ...opBase(randomUUID(), by, randomUUID()), type: 'addColumn', column: id, name: trimmed,
      colType: (type ?? 'string') as DatasetOpColumnType, ...(index !== undefined ? { index } : {}),
    }])
    return text(`Added column ${trimmed} (${id}, ${type ?? 'string'}).`)
  }))

  server.registerTool('set_dataset_column_type', {
    description:
      'Change the type of a dataset column (string, number, boolean, date) — the table\'s "Treat as…". Values that do '
      + 'not convert become empty in a parsed column, or are kept as typed in a column added by an edit; both are counted.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; column: string; type: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' }, column: { type: 'string', description: 'Name or id.' },
        type: { type: 'string', enum: COLUMN_TYPES },
      },
      required: ['project_uid', 'path', 'column', 'type'],
    }),
  }, guard(async ({ project_uid, path, column, type }) => {
    const node = await ds.meta(project_uid, path)
    const col = findColumn(columnsOf(node), column)
    if (!col) return failure(`No column "${column}" (columns: ${colList(columnsOf(node))}).`)
    const t = type as DatasetOpColumnType
    // A column the log added is rebuilt from its own op on every replay, so the
    // type lives there; a parsed column's lives in the parse options.
    const retyped = retypeAddedColumn(node.ops ?? [], col.id, t,
      (v) => (fitsColumnType(v, t) ? coerceValue(v, t) as DatasetCellValue : null))
    if (retyped.changed) {
      await ds.ops(project_uid, path, retyped.ops, true)
      return text(`${col.name} is now ${type}.${retyped.rejected.length ? ` ${retyped.rejected.length} value(s) do not fit and were kept as typed.` : ''}`)
    }
    const parseOptions = node.parseOptions ?? {}
    const columnTypes = { ...(parseOptions.columnTypes as Record<string, string> | undefined), [col.id]: type }
    const updated = await ds.reimport(project_uid, path, { ...parseOptions, columnTypes })
    const now = columnsOf(updated).find((c) => c.id === col.id)
    return text(`${col.name} is now ${now?.type ?? type}.`)
  }))

  server.registerTool('move_dataset_column', {
    description: 'Move a dataset column to another position (after a given column, or first). An edit-history entry.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; column: string; after?: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' }, column: { type: 'string', description: 'Name or id.' },
        after: { type: 'string', description: 'Column (name or id) to land after. Omit to move it first.' },
      },
      required: ['project_uid', 'path', 'column'],
    }),
  }, guard(async ({ project_uid, path, column, after }) => {
    const cols = columnsOf(await ds.meta(project_uid, path))
    const col = findColumn(cols, column)
    const prev = after ? findColumn(cols, after) : null
    if (!col || (after && !prev)) return failure(`No column "${!col ? column : after}" (columns: ${colList(cols)}).`)
    if (prev?.id === col.id) return failure('A column cannot move after itself.')
    const order = columnOrderWith(cols.map((c) => c.id), col.id, prev?.id ?? null)
    const { by } = await me()
    await ds.ops(project_uid, path, [{ ...opBase(randomUUID(), by, randomUUID()), type: 'reorderColumns', order }])
    return text(`Moved ${col.name}. Order: ${order.join(', ')}`)
  }))

  server.registerTool('set_dataset_cells', {
    description:
      'Write values into dataset cells, addressed by row number (from find_dataset_rows) and column. Each value is '
      + 'read into its column\'s type; a value that does not fit is refused. One undoable action in the edit history.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      project_uid: string; path: string; cells: { row: number; column: string; value: string | number | boolean | null }[]
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' },
        cells: {
          type: 'array', minItems: 1, maxItems: 500,
          items: {
            type: 'object',
            properties: {
              row: { type: 'number', description: 'Row number from find_dataset_rows.' },
              column: { type: 'string', description: 'Name or id.' },
              value: { type: ['string', 'number', 'boolean', 'null'], description: 'null or "" empties the cell.' },
            },
            required: ['row', 'column', 'value'],
          },
        },
      },
      required: ['project_uid', 'path', 'cells'],
    }),
  }, guard(async ({ project_uid, path, cells }) => {
    const cols = columnsOf(await ds.meta(project_uid, path))
    const errors: string[] = []
    const { by } = await me()
    const group = randomUUID()
    const ops: DatasetOp[] = []
    for (const c of cells) {
      const col = findColumn(cols, c.column)
      if (!col) { errors.push(`No column "${c.column}".`); continue }
      if (!Number.isInteger(c.row)) { errors.push(`Row ${c.row} is not a row number.`); continue }
      const v = cellValue(c.value, col.type)
      if ('error' in v) { errors.push(`row ${c.row}, ${col.name}: ${v.error}.`); continue }
      ops.push({ ...opBase(group, by, randomUUID()), type: 'setCell', row: c.row, column: col.id, value: v.value })
    }
    if (errors.length) return failure(`Nothing written:\n- ${errors.join('\n- ')}${errors.some((e) => e.startsWith('No column')) ? `\nColumns: ${colList(cols)}` : ''}`)
    await ds.ops(project_uid, path, ops)
    return text(`Wrote ${ops.length} cell(s). A row number that does not exist is ignored by the dataset; check with find_dataset_rows.`)
  }))

  server.registerTool('add_dataset_rows', {
    description:
      'Append rows to a dataset (a manual collection, a missing record…), values keyed by column name or id. '
      + 'Returns the new rows\' numbers. One undoable action in the edit history.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; rows: Record<string, string | number | boolean | null>[] }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' },
        rows: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', description: 'column → value' } },
      },
      required: ['project_uid', 'path', 'rows'],
    }),
  }, guard(async ({ project_uid, path, rows }) => {
    const node = await ds.meta(project_uid, path)
    const cols = columnsOf(node)
    const errors: string[] = []
    const { by } = await me()
    const group = randomUUID()
    let next = nextAddedRow(node.ops ?? [])
    const ops: DatasetOp[] = []
    rows.forEach((r, i) => {
      const values: Record<string, DatasetCellValue> = {}
      for (const [k, raw] of Object.entries(r)) {
        const col = findColumn(cols, k)
        if (!col) { errors.push(`row ${i + 1}: no column "${k}".`); continue }
        const v = cellValue(raw, col.type)
        if ('error' in v) errors.push(`row ${i + 1}, ${col.name}: ${v.error}.`)
        else values[col.id] = v.value
      }
      ops.push({ ...opBase(group, by, randomUUID()), type: 'addRow', row: next--, values })
    })
    if (errors.length) return failure(`Nothing added:\n- ${errors.join('\n- ')}\nColumns: ${colList(cols)}`)
    await ds.ops(project_uid, path, ops)
    return text(`Added ${ops.length} row(s): row numbers ${ops.map((o) => (o as { row: number }).row).join(', ')}.`)
  }))

  server.registerTool('remove_dataset_rows', {
    description: 'Remove rows from a dataset by row number (find_dataset_rows). The raw file is untouched and the '
      + 'removal is undoable in Linkr\'s edit history. Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; rows: number[] }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, path: { type: 'string' }, rows: { type: 'array', items: { type: 'number' }, minItems: 1 } },
      required: ['project_uid', 'path', 'rows'],
    }),
  }, guard(async ({ project_uid, path, rows }) => {
    const { by } = await me()
    const group = randomUUID()
    const res = await ds.ops(project_uid, path, rows.map((row) => ({ ...opBase(group, by, randomUUID()), type: 'removeRow' as const, row })))
    return text(`Removed ${rows.length} row(s); the dataset now has ${res.node.rowCount ?? '?'} rows.`)
  }))

  server.registerTool('get_dataset_edit_history', {
    description: 'A dataset\'s edit history: the actions recorded over its raw file (added columns, cell edits, '
      + 'removed rows…), newest first, with who made them.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string }>({
      type: 'object', properties: { project_uid: { type: 'string' }, path: { type: 'string' } }, required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path }) => text(summarizeOps((await ds.meta(project_uid, path)).ops ?? []))))

  server.registerTool('undo_dataset_edits', {
    description: 'Undo the last action(s) of a dataset\'s edit history (get_dataset_edit_history), like the Undo of '
      + 'Linkr\'s dataset table. The history is shared: check the last actions are the ones meant, and ask the user '
      + 'first when they are not yours.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; steps?: number }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, path: { type: 'string' }, steps: { type: 'number', description: 'Default 1.' } },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path, steps }) => {
    const log = (await ds.meta(project_uid, path)).ops ?? []
    if (!log.length) return failure('This dataset has no edit to undo.')
    const start = undoStart(log, Math.max(1, Math.floor(steps ?? 1)))
    await ds.ops(project_uid, path, log.slice(0, start), true)
    return text(`Undid ${log.length - start} op(s). ${summarizeOps(log.slice(0, start), 5)}`)
  }))

  server.registerTool('set_dataset_import_options', {
    description:
      'Re-read a dataset\'s raw file (CSV / Excel) with other import options: delimiter, encoding, rows to skip, '
      + 'header, Excel sheet, tokens read as missing. With preview, shows the resulting columns and first rows '
      + 'without changing anything.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      project_uid: string; path: string; delimiter?: string; encoding?: string; skip_rows?: number; has_header?: boolean
      sheet?: string; na_values?: string[]; preview?: boolean
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' },
        delimiter: { type: 'string', description: 'e.g. ",", ";", "\\t".' },
        encoding: { type: 'string', description: 'e.g. "utf-8", "latin-1".' },
        skip_rows: { type: 'number' }, has_header: { type: 'boolean' },
        sheet: { type: 'string', description: 'Excel sheet name.' },
        na_values: { type: 'array', items: { type: 'string' }, description: 'Read as missing, e.g. ["NA", "N/A", "-"].' },
        preview: { type: 'boolean', description: 'Only show the result. Default false.' },
      },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path, delimiter, encoding, skip_rows, has_header, sheet, na_values, preview }) => {
    const current = (await ds.meta(project_uid, path)).parseOptions ?? {}
    const changes = Object.fromEntries(Object.entries({
      delimiter, encoding, skipRows: skip_rows, hasHeader: has_header, sheet, naValues: na_values,
    }).filter(([, v]) => v !== undefined))
    if (Object.keys(changes).length === 0) return failure('Nothing to change: give at least one option.')
    const parseOptions = { ...current, ...changes }
    if (preview) {
      const p = await ds.previewPath(project_uid, path, parseOptions)
      return text([
        `${p.rowCount} rows; columns: ${p.columns.map((c) => `${c.name} (${c.type})`).join(', ')}`,
        ...(p.sheetNames?.length ? [`Sheets: ${p.sheetNames.join(', ')}`] : []),
        formatRowPage(p.preview.slice(0, 5), p.columns, 0, true),
      ].join('\n'))
    }
    const node = await ds.reimport(project_uid, path, parseOptions)
    return text(`Re-read ${path}: ${node.rowCount ?? '?'} rows; columns: ${columnsOf(node).map((c) => `${c.id} (${c.type})`).join(', ')}. `
      + 'Widgets or filters on columns whose id changed must be updated.')
  }))

  // --- Dataset analyses ------------------------------------------------------

  server.registerTool('list_dataset_analyses', {
    description: 'The analyses attached to a dataset: tabs beside its table in Linkr, each a plugin (table 1, plot, '
      + 'regression…) or custom R/Python code run on the dataset.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string }>({
      type: 'object', properties: { project_uid: { type: 'string' }, path: { type: 'string' } }, required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path }) => {
    const list = await ds.analyses(project_uid, path)
    if (list.length === 0) return text('No analysis on this dataset.')
    return text(list.map((a) => `- "${a.name}" — analysis_id: ${a.id} · ${a.type} · config ${JSON.stringify(a.config).slice(0, 300)}`).join('\n'))
  }))

  server.registerTool('create_dataset_analysis', {
    description:
      'Attach an analysis to a dataset: a lab plugin (list_plugins / describe_plugin, or a workspace plugin from '
      + 'list_user_plugins) with its config — columns by name or id — or custom code (plugin_id "inline" with '
      + 'language and code; the dataset is injected as `dataset`).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      project_uid: string; path: string; name: string; plugin_id: string; config?: Record<string, unknown>
      language?: PluginLanguage; code?: string
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' },
        name: { type: 'string', description: 'Tab title; unique among the dataset\'s analyses.' },
        plugin_id: { type: 'string' },
        config: { type: 'object' },
        language: { type: 'string', enum: ['python', 'r'], description: 'Script plugins and inline code.' },
        code: { type: 'string', description: 'inline only.' },
      },
      required: ['project_uid', 'path', 'name', 'plugin_id'],
    }),
  }, guard(async ({ project_uid, path, name, plugin_id, config, language, code }) => {
    const existing = await ds.analyses(project_uid, path)
    if (existing.some((a) => a.name.toLowerCase() === name.trim().toLowerCase())) {
      return failure(`An analysis "${name}" already exists on this dataset.`)
    }
    let type = plugin_id
    let stored: Record<string, unknown>
    if (plugin_id === 'inline') {
      if (!language) return failure('inline needs a language (python or r).')
      stored = { language, code: code ?? `# ${language} code here\n` }
    } else {
      const plugin = await resolvePlugin(plugin_id, 'lab', await workspaceOfProject(project_uid))
      if (!plugin) return failure(`Unknown lab plugin "${plugin_id}" (see list_plugins, list_user_plugins).`)
      const lang = scriptLanguage(plugin.manifest, plugin.templates, language)
      if (lang.error) return failure(lang.error)
      const cols = columnsOf(await ds.meta(project_uid, path))
      const resolved = resolveColumns(config ?? {}, plugin.manifest, cols)
      if (resolved.errors.length) return failure(`Not created:\n- ${resolved.errors.join('\n- ')}`)
      type = plugin.manifest.id
      stored = { ...resolved.config, ...(lang.language ? { language: lang.language } : {}) }
    }
    const a = await api.request<DatasetAnalysis>('POST', '/dataset-files/analyses', {
      id: randomUUID(), projectUid: project_uid, datasetPath: path, name: name.trim(), type, config: stored,
    })
    return text(`Created analysis "${a.name}" — analysis_id: ${a.id}`)
  }))

  server.registerTool('update_dataset_analysis', {
    description: 'Rename a dataset analysis or change its config (fields merged; null clears one; columns by name or '
      + 'id). For inline code, config.code replaces the code.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; analysis_id: string; name?: string; config?: Record<string, unknown> }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, path: { type: 'string' }, analysis_id: { type: 'string' },
        name: { type: 'string' }, config: { type: 'object' },
      },
      required: ['project_uid', 'path', 'analysis_id'],
    }),
  }, guard(async ({ project_uid, path, analysis_id, name, config }) => {
    const a = (await ds.analyses(project_uid, path)).find((x) => x.id === analysis_id)
    if (!a) return failure(`No analysis ${analysis_id} on ${path} (see list_dataset_analyses).`)
    const changes: Record<string, unknown> = {}
    if (name !== undefined) changes.name = name.trim()
    if (config) {
      const merged = Object.fromEntries(Object.entries({ ...a.config, ...config }).filter(([, v]) => v !== null))
      if (a.type !== 'inline') {
        const plugin = await resolvePlugin(a.type, 'lab', await workspaceOfProject(project_uid))
        if (plugin) {
          const { language, ...rest } = merged
          const resolved = resolveColumns(rest, plugin.manifest, columnsOf(await ds.meta(project_uid, path)))
          if (resolved.errors.length) return failure(`Not updated:\n- ${resolved.errors.join('\n- ')}`)
          changes.config = { ...resolved.config, ...(language ? { language } : {}) }
        } else changes.config = merged
      } else changes.config = merged
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change: give name or config.')
    await api.request('PATCH', `/dataset-files/analyses/${q(analysis_id)}`, changes)
    return text(`Updated analysis ${analysis_id}.`)
  }))

  server.registerTool('delete_dataset_analysis', {
    description: 'Delete an analysis from a dataset. Irreversible: ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ analysis_id: string }>({
      type: 'object', properties: { analysis_id: { type: 'string' } }, required: ['analysis_id'],
    }),
  }, guard(async ({ analysis_id }) => {
    await api.request('DELETE', `/dataset-files/analyses/${q(analysis_id)}`)
    return text(`Deleted analysis ${analysis_id}.`)
  }))

  // ===========================================================================
  // Pipeline — the project's diagram of databases → cohorts → scripts → datasets → dashboards
  // ===========================================================================

  server.registerTool('describe_pipeline', {
    description:
      'A project\'s Pipeline: the diagram on its Pipeline page showing how its data flows — database, cohort, '
      + 'scripts, dataset and dashboard nodes, linked by arrows, optionally inside groups. It documents the flow; '
      + 'it does not run anything.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object', properties: { project_uid: { type: 'string' } }, required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => {
    const p = await projectPipeline(project_uid, false)
    return text(p ? describePipeline(p, loc(p.name)) : 'This project has no pipeline yet (add_pipeline_node creates it).')
  }))

  server.registerTool('add_pipeline_node', {
    description: 'Add a node to the project\'s Pipeline diagram (created on first use), optionally linked to what it '
      + 'stands for, inside a group, and connected from an existing node. Placed right of the others.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<NodeArgs & {
      project_uid: string; type: PipelineNodeType; group_id?: string; from_node_id?: string; position?: { x: number; y: number }
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        type: { type: 'string', enum: PIPELINE_NODE_TYPES },
        ...NODE_FIELD_SCHEMA,
        group_id: { type: 'string', description: 'A group node to place it in.' },
        from_node_id: { type: 'string', description: 'Draw an arrow from this node to the new one.' },
        position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      },
      required: ['project_uid', 'type'],
    }),
  }, guard(async (args) => {
    const fields = nodeFields(args)
    const misplaced = checkNodeFields(args.type, fields)
    if (misplaced) return failure(misplaced)
    const bad = await checkNodeLinks(args.project_uid, fields)
    if (bad) return failure(bad)
    const p = (await projectPipeline(args.project_uid, true))!
    if (args.group_id && !p.nodes.some((n) => n.id === args.group_id && n.data.type === 'group')) {
      return failure(`No group node ${args.group_id} (see describe_pipeline).`)
    }
    const id = randomUUID()
    const position = args.position ?? (args.group_id ? { x: 20, y: 40 } : nextNodePosition(p.nodes))
    const node = newPipelineNode(id, args.type, fields, position, randomUUID, args.group_id)
    const nodes = [...p.nodes, node]
    const edges = [...p.edges]
    if (args.from_node_id) {
      const err = connectError({ nodes, edges }, args.from_node_id, id)
      if (err) return failure(err)
      edges.push({ id: randomUUID(), source: args.from_node_id, target: id })
    }
    await savePipeline(p, nodes, edges)
    return text(`Added ${args.type} node "${node.data.label}" — node_id: ${id}`)
  }))

  server.registerTool('update_pipeline_node', {
    description: 'Change a Pipeline node: its label or what it links to (scripts replaces the node\'s script list).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<NodeArgs & { project_uid: string; node_id: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, node_id: { type: 'string' }, ...NODE_FIELD_SCHEMA },
      required: ['project_uid', 'node_id'],
    }),
  }, guard(async (args) => {
    const p = await projectPipeline(args.project_uid, false)
    const node = p?.nodes.find((n) => n.id === args.node_id)
    if (!p || !node) return failure(`No node ${args.node_id} in this project's pipeline (see describe_pipeline).`)
    const fields = nodeFields(args)
    const misplaced = checkNodeFields(node.data.type, fields)
    if (misplaced) return failure(misplaced)
    const bad = await checkNodeLinks(args.project_uid, fields)
    if (bad) return failure(bad)
    const data = nodeData(fields, randomUUID)
    if (Object.keys(data).length === 0) return failure('Nothing to change.')
    await savePipeline(p, p.nodes.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, ...data } } : n)), p.edges)
    return text(`Updated node ${node.id}.`)
  }))

  server.registerTool('remove_pipeline_node', {
    description: 'Remove a node from the Pipeline diagram, with its arrows (a removed group\'s nodes stay, ungrouped). '
      + 'Only the diagram changes — the database, cohort or dataset it stood for is untouched.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; node_id: string }>({
      type: 'object', properties: { project_uid: { type: 'string' }, node_id: { type: 'string' } }, required: ['project_uid', 'node_id'],
    }),
  }, guard(async ({ project_uid, node_id }) => {
    const p = await projectPipeline(project_uid, false)
    if (!p?.nodes.some((n) => n.id === node_id)) return failure(`No node ${node_id} (see describe_pipeline).`)
    const g = withoutNode(p, node_id)
    await savePipeline(p, g.nodes, g.edges)
    return text(`Removed node ${node_id}.`)
  }))

  server.registerTool('link_pipeline_nodes', {
    description: 'Draw an arrow between two Pipeline nodes (data flows from source to target), or remove it with unlink.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; source_node_id: string; target_node_id: string; unlink?: boolean }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, source_node_id: { type: 'string' }, target_node_id: { type: 'string' },
        unlink: { type: 'boolean', description: 'Remove the arrow instead.' },
      },
      required: ['project_uid', 'source_node_id', 'target_node_id'],
    }),
  }, guard(async ({ project_uid, source_node_id, target_node_id, unlink }) => {
    const p = await projectPipeline(project_uid, false)
    if (!p) return failure('This project has no pipeline yet (add_pipeline_node).')
    if (unlink) {
      const edges = p.edges.filter((e) => !(e.source === source_node_id && e.target === target_node_id))
      if (edges.length === p.edges.length) return failure('No such arrow.')
      await savePipeline(p, p.nodes, edges)
      return text('Arrow removed.')
    }
    const err = connectError(p, source_node_id, target_node_id)
    if (err) return failure(err)
    await savePipeline(p, p.nodes, [...p.edges, { id: randomUUID(), source: source_node_id, target: target_node_id }])
    return text('Arrow added.')
  }))

  // ===========================================================================
  // Patient data boards
  // ===========================================================================

  server.registerTool('list_patient_plugins', {
    description: 'The widget types a Patient data board can hold — one patient\'s record at a time: summary, '
      + 'timeline of measurements, clinical notes, stays overview, plus the workspace\'s own warehouse plugins '
      + '(R/Python code run for the selected patient).',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid?: string }>({
      type: 'object', properties: { project_uid: { type: 'string', description: 'Include its workspace\'s plugins.' } },
    }),
  }, guard(async ({ project_uid }) => {
    const lines = listPatientPlugins().map(pluginSummary)
    const ws = project_uid ? await workspaceOfProject(project_uid) : null
    if (ws) {
      for (const row of await plugins.list(ws)) {
        const m = manifestOf(row)
        if (m && !isBuiltinRow(m) && m.scope === 'warehouse') lines.push(`${pluginSummary(m)} [workspace plugin, ${(m.languages ?? []).join('/')}]`)
      }
    }
    return text(lines.length ? lines.join('\n') : 'No patient widget plugin found.')
  }))

  server.registerTool('describe_patient_plugin', {
    description: 'The config fields of one Patient data widget plugin.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ plugin_id: string; project_uid?: string }>({
      type: 'object',
      properties: { plugin_id: { type: 'string' }, project_uid: { type: 'string', description: 'For a workspace plugin.' } },
      required: ['plugin_id'],
    }),
  }, guard(async ({ plugin_id, project_uid }) => {
    const p = await resolvePlugin(plugin_id, 'warehouse', project_uid ? await workspaceOfProject(project_uid) : null)
    if (!p) return failure(`Unknown patient plugin "${plugin_id}" (see list_patient_plugins).`)
    let doc = pluginDoc(p.manifest)
    if (p.manifest.id === 'linkr-widget-timeline') {
      doc += '\n  datasets: [{datasetFileId: <dataset path>, personColumn, dateColumn, valueColumn?, textValueColumn?, '
        + 'endColumn?, visitColumn?, visitDetailColumn?, seriesName?, color?}] — columns by name or id; one entry per plotted variable.'
    }
    return text(doc)
  }))

  server.registerTool('list_patient_boards', {
    description: 'A project\'s Patient data boards: layouts of widgets (tabs of timelines, notes, summaries…) through '
      + 'which one patient\'s record is reviewed at a time, each reading one of the project\'s databases.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object', properties: { project_uid: { type: 'string' } }, required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => {
    const boards = (await patient.list(project_uid)).filter((b) => !b.ownerCohortId).sort((a, b) => a.displayOrder - b.displayOrder)
    if (boards.length === 0) return text('No patient board in this project.')
    return text(boards.map((b) => `- "${loc(b.name)}" — board_id: ${b.id} · database: ${b.dataSourceId ?? '(first usable)'}`).join('\n'))
  }))

  server.registerTool('describe_patient_board', {
    description: 'A patient board\'s settings, tabs and widgets (ids, plugins, layouts, configs). Read before editing.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ board_id: string }>({
      type: 'object', properties: { board_id: { type: 'string' } }, required: ['board_id'],
    }),
  }, guard(async ({ board_id }) => text(await describePatientBoard(await patient.get(board_id)))))

  server.registerTool('create_patient_board', {
    description: 'Create a Patient data board in a project, with a first empty tab. Returns both ids.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; name: string; description?: string; database_id?: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
        database_id: { type: 'string', description: 'A linked database it reads. Default: the first usable one.' },
      },
      required: ['project_uid', 'name'],
    }),
  }, guard(async ({ project_uid, name, description, database_id }) => {
    const existing = (await patient.list(project_uid)).filter((b) => !b.ownerCohortId)
    if (existing.some((b) => loc(b.name).toLowerCase() === name.trim().toLowerCase())) return failure(`A board "${name}" already exists.`)
    let ref: unknown
    if (database_id) {
      const project = await api.getProject(project_uid)
      if (!(project.linkedDataSourceIds ?? []).includes(database_id)) return failure(`Database ${database_id} is not linked to this project.`)
      ref = buildPointer(await api.listDataSources() as unknown as { id: string; lineageId?: string; entityId?: string; name?: unknown }[], database_id)
    }
    const { authored } = await me()
    const board = await patient.create({
      id: randomUUID(), projectUid: project_uid, name: { en: name.trim() },
      ...(description ? { description: { en: description } } : {}),
      ...(database_id ? { dataSourceId: database_id, dataSourceRef: ref ?? null } : {}),
      displayOrder: existing.length, version: '0.1.0', ...authored,
    })
    const tab = await patient.createTab({ id: randomUUID(), patientDashboardId: board.id, name: bilingual('Tab 1'), displayOrder: 0 })
    return text(`Created patient board "${name}" — board_id: ${board.id}, first tab_id: ${tab.id}`)
  }))

  server.registerTool('update_patient_board', {
    description: 'Change a patient board: name, description, database, display settings (widget titles, spacing, '
      + 'fit to screen height, reload widgets on tab switch, share synced timeline windows across tabs).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      board_id: string; name?: string; description?: string; database_id?: string; show_widget_titles?: boolean
      widget_spacing?: number; fit_to_height?: boolean; reload_widgets_on_tab_switch?: boolean; sync_timelines_across_tabs?: boolean
    }>({
      type: 'object',
      properties: {
        board_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, database_id: { type: 'string' },
        show_widget_titles: { type: 'boolean' }, widget_spacing: { type: 'number', description: 'Pixels between widgets.' },
        fit_to_height: { type: 'boolean' }, reload_widgets_on_tab_switch: { type: 'boolean' }, sync_timelines_across_tabs: { type: 'boolean' },
      },
      required: ['board_id'],
    }),
  }, guard(async (a) => {
    const board = await patient.get(a.board_id)
    const changes: Record<string, unknown> = {}
    if (a.name !== undefined) changes.name = { ...(board.name as LocalizedString), en: a.name.trim() }
    if (a.description !== undefined) changes.description = { ...(board.description ?? {}), en: a.description }
    if (a.database_id !== undefined) {
      const projectUid = await boardProject(board)
      if (!((await api.getProject(projectUid)).linkedDataSourceIds ?? []).includes(a.database_id)) {
        return failure(`Database ${a.database_id} is not linked to this project.`)
      }
      changes.dataSourceId = a.database_id
      changes.dataSourceRef = buildPointer(await api.listDataSources() as unknown as { id: string; lineageId?: string; entityId?: string; name?: unknown }[], a.database_id) ?? null
    }
    const flags = {
      showWidgetTitles: a.show_widget_titles, widgetSpacing: a.widget_spacing, fitToHeight: a.fit_to_height,
      reloadWidgetsOnTabSwitch: a.reload_widgets_on_tab_switch, syncTimelinesAcrossTabs: a.sync_timelines_across_tabs,
    }
    for (const [k, v] of Object.entries(flags)) if (v !== undefined) changes[k] = v
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    await patient.update(a.board_id, changes)
    return text(`Updated patient board ${a.board_id}.`)
  }))

  server.registerTool('duplicate_patient_board', {
    description: 'Copy a patient board with all its tabs and widgets, named "<name> (copy)".',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ board_id: string }>({
      type: 'object', properties: { board_id: { type: 'string' } }, required: ['board_id'],
    }),
  }, guard(async ({ board_id }) => {
    const source = await patient.get(board_id)
    const projectUid = await boardProject(source)
    const siblings = (await patient.list(projectUid)).filter((b) => (b.ownerCohortId ?? null) === (source.ownerCohortId ?? null))
    if (source.ownerCohortId) return failure('A cohort\'s board is unique to its cohort and cannot be duplicated.')
    const { authored } = await me()
    const { id: _id, createdAt: _c, updatedAt: _u, createdById: _a, createdBy: _b, createdByDetails: _d, ...rest } = source
    const clone = await patient.create({
      ...rest, id: randomUUID(), name: copyName(source.name, siblings.map((b) => b.name)), displayOrder: siblings.length,
      origin: 'user', ...authored,
    })
    let widgets = 0
    for (const tab of await patient.tabs(board_id)) {
      const t = await patient.createTab({ ...tab, id: randomUUID(), patientDashboardId: clone.id })
      for (const w of await patient.widgets(tab.id)) {
        await patient.createWidget({ ...w, id: randomUUID(), tabId: t.id })
        widgets++
      }
    }
    return text(`Duplicated as "${loc(clone.name)}" — board_id: ${clone.id} (${widgets} widget(s)).`)
  }))

  server.registerTool('delete_patient_board', {
    description: 'Delete a patient board with its tabs and widgets. Irreversible: ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ board_id: string }>({
      type: 'object', properties: { board_id: { type: 'string' } }, required: ['board_id'],
    }),
  }, guard(async ({ board_id }) => {
    const board = await patient.get(board_id)
    await patient.remove(board_id)
    return text(`Deleted patient board "${loc(board.name)}".`)
  }))

  server.registerTool('add_patient_tab', {
    description: 'Add a tab to a patient board.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ board_id: string; name: string; description?: string }>({
      type: 'object',
      properties: { board_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } },
      required: ['board_id', 'name'],
    }),
  }, guard(async ({ board_id, name, description }) => {
    const tabs = await patient.tabs(board_id)
    const tab = await patient.createTab({
      id: randomUUID(), patientDashboardId: board_id, name: bilingual(name),
      ...(description ? { description: bilingual(description) } : {}),
      displayOrder: tabs.reduce((m, t) => Math.max(m, t.displayOrder + 1), 0),
    })
    return text(`Added tab "${name}" — tab_id: ${tab.id}`)
  }))

  server.registerTool('update_patient_tab', {
    description: 'Rename a patient board tab or change its description (hover tooltip).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ tab_id: string; name?: string; description?: string }>({
      type: 'object',
      properties: { tab_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } },
      required: ['tab_id'],
    }),
  }, guard(async ({ tab_id, name, description }) => {
    const changes: Record<string, unknown> = {}
    if (name !== undefined) changes.name = bilingual(name)
    if (description !== undefined) changes.description = bilingual(description)
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    await patient.updateTab(tab_id, changes)
    return text(`Updated tab ${tab_id}.`)
  }))

  server.registerTool('reorder_patient_tabs', {
    description: 'Reorder a patient board\'s tabs: the tabs named come first, in that order; the others follow.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ board_id: string; tab_ids: string[] }>({
      type: 'object',
      properties: { board_id: { type: 'string' }, tab_ids: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['board_id', 'tab_ids'],
    }),
  }, guard(async ({ board_id, tab_ids }) => {
    const tabs = (await patient.tabs(board_id)).sort((a, b) => a.displayOrder - b.displayOrder)
    const r = reorderIds(tabs.map((t) => t.id), tab_ids)
    if (!r.order) return failure(r.error!)
    for (const [i, id] of r.order.entries()) {
      if (tabs.find((t) => t.id === id)?.displayOrder !== i) await patient.updateTab(id, { displayOrder: i })
    }
    return text(`Tabs reordered: ${r.order.map((id) => loc(tabs.find((t) => t.id === id)!.name)).join(', ')}.`)
  }))

  server.registerTool('remove_patient_tab', {
    description: 'Delete a patient board tab and its widgets (a board keeps at least one tab). Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ tab_id: string }>({
      type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'],
    }),
  }, guard(async ({ tab_id }) => {
    const tab = await patient.tab(tab_id)
    if ((await patient.tabs(tab.patientDashboardId)).length <= 1) return failure('This is the board\'s only tab: a board keeps at least one.')
    await patient.removeTab(tab_id)
    return text(`Deleted tab "${loc(tab.name)}".`)
  }))

  server.registerTool('add_patient_widget', {
    description:
      'Add a widget to a patient board tab (list_patient_plugins / describe_patient_plugin). Timeline: conceptIds '
      + 'lists OMOP concept ids (search_concepts) and datasets plots dataset variables. Config fields are checked '
      + 'against the plugin. Without a layout it goes below the others at the plugin\'s default size.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      tab_id: string; name: string; plugin_id: string; config?: Record<string, unknown>; language?: PluginLanguage
      layout?: Partial<Layout>
    }>({
      type: 'object',
      properties: {
        tab_id: { type: 'string' }, name: { type: 'string', description: 'Widget title.' },
        plugin_id: { type: 'string', description: 'e.g. linkr-widget-timeline (or "timeline").' },
        config: { type: 'object' },
        language: { type: 'string', enum: ['python', 'r'], description: 'Workspace (script) plugins only.' },
        layout: LAYOUT_SCHEMA,
      },
      required: ['tab_id', 'name', 'plugin_id'],
    }),
  }, guard(async ({ tab_id, name, plugin_id, config, language, layout }) => {
    const tab = await patient.tab(tab_id)
    const board = await patient.get(tab.patientDashboardId)
    const projectUid = await boardProject(board)
    const plugin = await resolvePlugin(plugin_id, 'warehouse', await workspaceOfProject(projectUid))
    if (!plugin) return failure(`Unknown patient plugin "${plugin_id}" (see list_patient_plugins).`)
    const lang = scriptLanguage(plugin.manifest, plugin.templates, language)
    if (lang.error) return failure(lang.error)
    const checked = checkPatientConfig(config ?? {}, plugin.manifest)
    checked.errors.push(...await resolveDatasetFields(projectUid, plugin.manifest, checked.config))
    if (checked.errors.length) return failure(`Not added:\n- ${checked.errors.join('\n- ')}`)
    const existing = (await patient.widgets(tab_id)).map((w) => w.layout)
    const size = patientWidgetSize(plugin.manifest.id)
    const widget = await patient.createWidget({
      id: randomUUID(), tabId: tab_id, name: bilingual(name), pluginId: plugin.manifest.id,
      layout: placeWidget(existing, { ...size, ...layout }), config: checked.config,
      ...(lang.language ? { language: lang.language } : {}), pluginVersion: plugin.manifest.version,
    })
    return text(`Added widget "${name}" — widget_id: ${widget.id}`)
  }))

  server.registerTool('update_patient_widget', {
    description:
      'Change a patient widget: title, description, config fields (merged; null clears one), layout, language, '
      + 'custom SQL (replaces the query built from the config; "" returns to the generated one), or move it to '
      + 'another tab of the same board.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      widget_id: string; name?: string; description?: string; config?: Record<string, unknown>; layout?: Partial<Layout>
      language?: PluginLanguage; custom_sql?: string; tab_id?: string
    }>({
      type: 'object',
      properties: {
        widget_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
        config: { type: 'object' }, layout: LAYOUT_SCHEMA,
        language: { type: 'string', enum: ['python', 'r'] }, custom_sql: { type: 'string' },
        tab_id: { type: 'string', description: 'Move to this tab (same board); lands below its widgets.' },
      },
      required: ['widget_id'],
    }),
  }, guard(async ({ widget_id, name, description, config, layout, language, custom_sql, tab_id }) => {
    const w = await patient.widget(widget_id)
    const tab = await patient.tab(w.tabId)
    const board = await patient.get(tab.patientDashboardId)
    const changes: Record<string, unknown> = {}
    if (name !== undefined) changes.name = bilingual(name)
    if (description !== undefined) changes.description = bilingual(description)
    if (custom_sql !== undefined) changes.customSql = custom_sql.trim() === '' ? null : custom_sql
    if (layout) changes.layout = placeWidget([], { ...w.layout, ...layout })
    if (config || language) {
      const projectUid = await boardProject(board)
      const plugin = await resolvePlugin(w.pluginId, 'warehouse', await workspaceOfProject(projectUid))
      if (!plugin) return failure(`The widget's plugin ${w.pluginId} is not available.`)
      if (language) {
        const lang = scriptLanguage(plugin.manifest, plugin.templates, language)
        if (lang.error) return failure(lang.error)
        changes.language = lang.language
      }
      if (config) {
        const merged = Object.fromEntries(Object.entries({ ...w.config, ...config }).filter(([, v]) => v !== null))
        const checked = checkPatientConfig(merged, plugin.manifest)
        checked.errors.push(...await resolveDatasetFields(projectUid, plugin.manifest, checked.config))
        if (checked.errors.length) return failure(`Not updated:\n- ${checked.errors.join('\n- ')}`)
        changes.config = checked.config
        changes.pluginVersion = plugin.manifest.version
      }
    }
    let moved = ''
    if (tab_id && tab_id !== w.tabId) {
      const target = await patient.tab(tab_id)
      if (target.patientDashboardId !== tab.patientDashboardId) return failure('The target tab is on another board.')
      const bottom = (await patient.widgets(tab_id)).reduce((m, x) => Math.max(m, x.layout.y + x.layout.h), 0)
      changes.tabId = tab_id
      changes.layout = { ...((changes.layout as Layout) ?? w.layout), x: 0, y: bottom }
      moved = ` Moved to tab "${loc(target.name)}".`
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    await patient.updateWidget(widget_id, changes)
    return text(`Updated widget ${widget_id}.${moved}`)
  }))

  server.registerTool('duplicate_patient_widget', {
    description: 'Copy a patient widget, "(copy)" appended to its title, below the others of its tab.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ widget_id: string }>({
      type: 'object', properties: { widget_id: { type: 'string' } }, required: ['widget_id'],
    }),
  }, guard(async ({ widget_id }) => {
    const w = await patient.widget(widget_id)
    const bottom = (await patient.widgets(w.tabId)).reduce((m, x) => Math.max(m, x.layout.y + x.layout.h), 0)
    const copy = await patient.createWidget({
      ...w, id: randomUUID(),
      name: Object.fromEntries(Object.entries(w.name).map(([l, v]) => [l, `${v} (copy)`])),
      layout: { ...w.layout, x: 0, y: bottom },
    })
    return text(`Duplicated — widget_id: ${copy.id}`)
  }))

  server.registerTool('remove_patient_widget', {
    description: 'Delete a patient board widget. Irreversible: ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ widget_id: string }>({
      type: 'object', properties: { widget_id: { type: 'string' } }, required: ['widget_id'],
    }),
  }, guard(async ({ widget_id }) => {
    await patient.removeWidget(widget_id)
    return text(`Deleted widget ${widget_id}.`)
  }))

  // ===========================================================================
  // Dashboards — the actions tools-lab.ts does not cover
  // ===========================================================================

  server.registerTool('duplicate_dashboard', {
    description: 'Copy a lab dashboard with all its tabs, sub-tabs, widgets and filters, named "<name> (copy)".',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ dashboard_id: string }>({
      type: 'object', properties: { dashboard_id: { type: 'string' } }, required: ['dashboard_id'],
    }),
  }, guard(async ({ dashboard_id }) => {
    const source = await api.getDashboard(dashboard_id)
    const siblings = await api.listDashboards(source.projectUid)
    const tabs = await api.listTabs(dashboard_id)
    const tabIds = new Map(tabs.map((t) => [t.id, randomUUID()]))
    const { authored } = await me()
    const { id: _id, createdAt: _c, updatedAt: _u, createdById: _a, createdBy: _b, createdByDetails: _d, ...rest } = source
    // Filters scoped to tabs follow them onto the copies, or they would filter nothing there.
    const filterConfig = (source.filterConfig ?? []).map((f) => (
      f.scope?.type === 'tabs' ? { ...f, scope: { type: 'tabs' as const, tabIds: f.scope.tabIds.map((t) => tabIds.get(t) ?? t) } } : f
    ))
    const clone = await api.createDashboard({
      ...rest, id: randomUUID(), name: copyName(source.name, siblings.map((d) => d.name)), filterConfig, origin: 'user', ...authored,
    } as Record<string, unknown>)
    // Parents first: a sub-tab's POST fails if its parent tab does not exist yet.
    const ordered = [...tabs].sort((a, b) => Number(!!a.parentTabId) - Number(!!b.parentTabId))
    let widgets = 0
    for (const tab of ordered) {
      await api.createTab({
        ...tab, id: tabIds.get(tab.id), dashboardId: clone.id,
        parentTabId: tab.parentTabId ? tabIds.get(tab.parentTabId) ?? null : null,
      } as Record<string, unknown>)
    }
    for (const tab of ordered) {
      for (const w of await api.listWidgets(tab.id)) {
        await api.createWidget({ ...w, id: randomUUID(), tabId: tabIds.get(tab.id) } as Record<string, unknown>)
        widgets++
      }
    }
    return text(`Duplicated as "${loc(clone.name)}" — dashboard_id: ${clone.id} (${tabs.length} tab(s), ${widgets} widget(s)).`)
  }))

  server.registerTool('reorder_dashboard_tabs', {
    description: 'Reorder a lab dashboard\'s tabs, or the sub-tabs of one tab (parent_tab_id): the tabs named come '
      + 'first, in that order; their other siblings follow.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ dashboard_id: string; tab_ids: string[]; parent_tab_id?: string }>({
      type: 'object',
      properties: {
        dashboard_id: { type: 'string' }, tab_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        parent_tab_id: { type: 'string', description: 'Reorder this tab\'s sub-tabs. Default: the top-level tabs.' },
      },
      required: ['dashboard_id', 'tab_ids'],
    }),
  }, guard(async ({ dashboard_id, tab_ids, parent_tab_id }) => {
    const siblings = (await api.listTabs(dashboard_id))
      .filter((t) => (t.parentTabId ?? null) === (parent_tab_id ?? null))
      .sort((a, b) => a.displayOrder - b.displayOrder)
    const r = reorderIds(siblings.map((t) => t.id), tab_ids)
    if (!r.order) return failure(r.error!)
    for (const [i, id] of r.order.entries()) {
      if (siblings.find((t) => t.id === id)?.displayOrder !== i) await api.updateTab(id, { displayOrder: i })
    }
    return text(`Tabs reordered: ${r.order.map((id) => loc(siblings.find((t) => t.id === id)!.name)).join(', ')}.`)
  }))

  server.registerTool('move_widget', {
    description: 'Move a lab dashboard widget to another tab of the same dashboard; it lands below that tab\'s widgets.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ widget_id: string; tab_id: string }>({
      type: 'object', properties: { widget_id: { type: 'string' }, tab_id: { type: 'string' } }, required: ['widget_id', 'tab_id'],
    }),
  }, guard(async ({ widget_id, tab_id }) => {
    const w = await api.getWidget(widget_id)
    if (w.tabId === tab_id) return failure('The widget is already on this tab.')
    const to = await widgetTargetTab(w.tabId, tab_id)
    if (typeof to === 'string') return failure(to)
    const bottom = (await api.listWidgets(tab_id)).reduce((m, x) => Math.max(m, x.layout.y + x.layout.h), 0)
    await api.updateWidget(w.id, { tabId: tab_id, layout: { ...w.layout, x: 0, y: bottom } })
    return text(`Moved "${loc(w.name)}" to tab "${loc(to.name)}".`)
  }))

  server.registerTool('duplicate_widget', {
    description: 'Copy a lab dashboard widget, "(copy)" appended to its title, onto its own tab or another tab '
      + 'of the same dashboard.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ widget_id: string; tab_id?: string }>({
      type: 'object', properties: { widget_id: { type: 'string' }, tab_id: { type: 'string', description: 'Default: the same tab.' } },
      required: ['widget_id'],
    }),
  }, guard(async ({ widget_id, tab_id }) => {
    const w: DashboardWidget = await api.getWidget(widget_id)
    const target = tab_id ?? w.tabId
    if (target !== w.tabId) {
      const to = await widgetTargetTab(w.tabId, target)
      if (typeof to === 'string') return failure(to)
    }
    const siblings = await api.listWidgets(target)
    const bottom = siblings.reduce((m, x) => Math.max(m, x.layout.y + x.layout.h), 0)
    const copy = await api.createWidget({
      ...w, id: randomUUID(), tabId: target, name: copyName(w.name, siblings.map((x) => x.name)),
      layout: { ...w.layout, x: 0, y: bottom },
    } as Record<string, unknown>)
    return text(`Duplicated — widget_id: ${copy.id}`)
  }))

  server.registerTool('update_dashboard_display', {
    description: 'A lab dashboard\'s display settings: widget titles shown, spacing between widgets, fit each tab to '
      + 'the screen height, re-run widgets on every tab switch.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      dashboard_id: string; show_widget_titles?: boolean; widget_spacing?: number; fit_to_height?: boolean; reload_widgets_on_tab_switch?: boolean
    }>({
      type: 'object',
      properties: {
        dashboard_id: { type: 'string' }, show_widget_titles: { type: 'boolean' },
        widget_spacing: { type: 'number', description: 'Pixels between widgets (default 12).' },
        fit_to_height: { type: 'boolean' }, reload_widgets_on_tab_switch: { type: 'boolean' },
      },
      required: ['dashboard_id'],
    }),
  }, guard(async (a) => {
    const changes = Object.fromEntries(Object.entries({
      showWidgetTitles: a.show_widget_titles, widgetSpacing: a.widget_spacing, fitToHeight: a.fit_to_height,
      reloadWidgetsOnTabSwitch: a.reload_widgets_on_tab_switch,
    }).filter(([, v]) => v !== undefined))
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    await api.updateDashboard(a.dashboard_id, changes)
    return text(`Updated the display of dashboard ${a.dashboard_id}.`)
  }))

  server.registerTool('set_dashboard_description', {
    description: 'Set the description of a lab dashboard tab (hover tooltip) or widget (info bubble). "" clears it.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ tab_id?: string; widget_id?: string; description: string }>({
      type: 'object',
      properties: { tab_id: { type: 'string' }, widget_id: { type: 'string' }, description: { type: 'string' } },
      required: ['description'],
    }),
  }, guard(async ({ tab_id, widget_id, description }) => {
    if (!!tab_id === !!widget_id) return failure('Give exactly one of tab_id or widget_id.')
    const value = description.trim() ? bilingual(description) : null
    if (tab_id) await api.updateTab(tab_id, { description: value })
    else await api.updateWidget(widget_id!, { description: value })
    return text(`Description ${value ? 'set' : 'cleared'}.`)
  }))

  // ===========================================================================
  // Workspace plugins — user-authored widget code
  // ===========================================================================

  server.registerTool('list_user_plugins', {
    description:
      'The plugins of a workspace (Plugins page): widget types written as R/Python code templates. Scope "lab" '
      + 'plugins run on a dataset (dashboards, dataset analyses); scope "warehouse" plugins run for one patient '
      + '(Patient data boards). Built-in plugins listed there are read-only.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ workspace_id?: string; project_uid?: string }>({
      type: 'object',
      properties: { workspace_id: { type: 'string' }, project_uid: { type: 'string', description: 'Its workspace.' } },
    }),
  }, guard(async ({ workspace_id, project_uid }) => {
    const ws = workspace_id ?? (project_uid ? await workspaceOfProject(project_uid) : null)
    if (!ws) return failure('Give workspace_id or project_uid.')
    const rows = await plugins.list(ws)
    const lines = rows.map((r) => {
      const m = manifestOf(r)
      if (!m) return `- plugin_id: ${r.id} — (unreadable plugin.json)`
      return `- "${loc(m.name)}" — plugin_id: ${r.id} · manifest ${m.id} · ${m.scope ?? 'lab'} · ${(m.languages ?? []).join('/') || 'component'}`
        + ` · v${m.version}${isBuiltinRow(m) ? ' · built-in (read-only)' : ''}`
    })
    return text(lines.length ? lines.join('\n') : 'No plugin in this workspace.')
  }))

  server.registerTool('get_user_plugin', {
    description: 'A workspace plugin\'s files: plugin.json (manifest: id, scope, languages, configSchema…) and its '
      + 'code templates, where {{field}} is replaced by the config value of that configSchema field.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ plugin_id: string; file?: string }>({
      type: 'object',
      properties: { plugin_id: { type: 'string' }, file: { type: 'string', description: 'Only this file.' } },
      required: ['plugin_id'],
    }),
  }, guard(async ({ plugin_id, file }) => {
    const row = await plugins.get(plugin_id)
    const names = file ? [file] : Object.keys(row.files).sort((a, b) => Number(a !== 'plugin.json') - Number(b !== 'plugin.json'))
    const out: string[] = []
    for (const f of names) {
      const content = row.files[f]
      if (content === undefined) return failure(`No file ${f} (files: ${Object.keys(row.files).join(', ')}).`)
      out.push(`=== ${f}\n${content.length > 20000 ? `${content.slice(0, 20000)}\n… (truncated)` : content}`)
    }
    return text(out.join('\n\n'))
  }))

  server.registerTool('create_user_plugin', {
    description:
      'Create a workspace plugin: a widget type whose code is an R and/or Python template. Lab scope: the dataset '
      + 'is injected as `dataset` (pandas DataFrame / data.frame). Warehouse scope: person_id, visit_occurrence_id, '
      + 'visit_detail_id are injected and sql_query("…") queries the database. {{field}} in a template is replaced by '
      + 'the config value of that configSchema field (column-select → column name). Without a template, the app\'s '
      + 'starter code is used.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      workspace_id?: string; project_uid?: string; name: string; description?: string; scope: PluginScope
      languages?: PluginLanguage[]; config_schema?: Record<string, unknown>; python_template?: string; r_template?: string
      python_dependencies?: string[]; r_dependencies?: string[]; icon?: string
    }>({
      type: 'object',
      properties: {
        workspace_id: { type: 'string' }, project_uid: { type: 'string', description: 'Its workspace.' },
        name: { type: 'string' }, description: { type: 'string' },
        scope: { type: 'string', enum: ['lab', 'warehouse'] },
        languages: { type: 'array', items: { type: 'string', enum: ['python', 'r'] }, description: 'Default ["python"].' },
        config_schema: {
          type: 'object',
          description: 'Settings form fields, keyed by name: {type: column-select|number|select|boolean|string|…, '
            + 'label: {en, fr}, multi?, filter?: numeric|categorical, options?: [{value, label: {en, fr}}], default?}.',
        },
        python_template: { type: 'string' }, r_template: { type: 'string' },
        python_dependencies: { type: 'array', items: { type: 'string' } }, r_dependencies: { type: 'array', items: { type: 'string' } },
        icon: { type: 'string', description: 'A lucide icon name. Default Puzzle.' },
      },
      required: ['name', 'scope'],
    }),
  }, guard(async (a) => {
    const ws = a.workspace_id ?? (a.project_uid ? await workspaceOfProject(a.project_uid) : null)
    if (!ws) return failure('Give workspace_id or project_uid.')
    const languages = a.languages?.length ? [...new Set(a.languages)] : (['python'] as PluginLanguage[])
    const id = `user-plugin-${Date.now()}`
    const manifest = scaffoldManifest({
      id, name: a.name.trim(), description: a.description ?? '', scope: a.scope, languages, icon: a.icon,
      configSchema: a.config_schema, dependencies: { python: a.python_dependencies, r: a.r_dependencies },
    })
    const files: Record<string, string> = {}
    for (const l of languages) {
      files[templateFile(l)] = (l === 'python' ? a.python_template : a.r_template) ?? scaffoldTemplate(a.scope, l)
    }
    files['plugin.json'] = JSON.stringify(manifest, null, 2)
    const checked = checkPluginFiles(files)
    if (checked.errors.length) return failure(`Not created:\n- ${checked.errors.join('\n- ')}`)
    files['plugin.json'] = JSON.stringify({ ...manifest, contentHash: await computePluginContentHash(files) }, null, 2)
    const { authored } = await me()
    await plugins.create({ id, workspaceId: ws, files, lineageId: randomUUID(), ...authored })
    return text(`Created plugin "${a.name}" — plugin_id: ${id}${checked.warnings.length ? `\nWarnings:\n- ${checked.warnings.join('\n- ')}` : ''}`)
  }))

  server.registerTool('update_user_plugin', {
    description:
      'Edit a workspace plugin\'s files (get_user_plugin first): each entry of `files` replaces or adds that file '
      + '(plugin.json included — keep its id), null deletes it. Checked like the app reads it before saving; '
      + 'built-in plugins cannot be edited. Widgets using it pick the change up on their next run.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ plugin_id: string; files: Record<string, string | null>; version?: string }>({
      type: 'object',
      properties: {
        plugin_id: { type: 'string' },
        files: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'file name → content (null deletes).' },
        version: { type: 'string', description: 'Also set the manifest version (semver).' },
      },
      required: ['plugin_id', 'files'],
    }),
  }, guard(async ({ plugin_id, files: changes, version }) => {
    const row = await plugins.get(plugin_id)
    const before = manifestOf(row)
    if (isBuiltinRow(before)) return failure('A built-in plugin is read-only; duplicate it in Linkr to change it.')
    if (changes['plugin.json'] === null) return failure('plugin.json cannot be deleted.')
    const files: Record<string, string> = { ...row.files }
    for (const [f, content] of Object.entries(changes)) {
      if (content === null) delete files[f]
      else files[f] = content
    }
    const checked = checkPluginFiles(files)
    if (checked.errors.length) return failure(`Not saved:\n- ${checked.errors.join('\n- ')}`)
    const manifest = checked.manifest!
    if (before?.id && manifest.id !== before.id) return failure(`The manifest id must stay ${before.id}: widgets reference it.`)
    if (version) manifest.version = version
    files['plugin.json'] = JSON.stringify({ ...manifest, contentHash: await computePluginContentHash(files) }, null, 2)
    await plugins.update(plugin_id, { files, ...(version ? { version } : {}) })
    return text(`Saved plugin ${plugin_id}.${checked.warnings.length ? `\nWarnings:\n- ${checked.warnings.join('\n- ')}` : ''}`)
  }))

  server.registerTool('delete_user_plugin', {
    description: 'Delete a workspace plugin. Widgets that use it stop rendering. Irreversible: ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ plugin_id: string }>({
      type: 'object', properties: { plugin_id: { type: 'string' } }, required: ['plugin_id'],
    }),
  }, guard(async ({ plugin_id }) => {
    const row = await plugins.get(plugin_id)
    const m = manifestOf(row)
    await plugins.remove(plugin_id)
    return text(`Deleted plugin "${m ? loc(m.name) : plugin_id}".`)
  }))
}

