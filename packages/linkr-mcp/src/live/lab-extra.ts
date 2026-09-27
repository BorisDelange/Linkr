/**
 * Pure helpers for the lab extras: dataset edits (the op log), the project
 * pipeline diagram, patient boards and workspace plugins. Everything here builds
 * or checks a payload; the tools send it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROW_ORD, type DatasetCellValue, type DatasetOp, type DatasetOpColumnType } from '@linkr/format'
import { fitsColumnType } from '@/lib/dataset-utils'
import type { PipelineEdge, PipelineNode, PipelineNodeType } from '@/types'
import type { PluginConfigField, PluginManifest } from '@/types/plugin'
import type { DatasetColumn } from './lab.js'
import { findColumn } from './lab.js'

// --- Dataset edits ------------------------------------------------------------

export const COLUMN_TYPES: DatasetOpColumnType[] = ['string', 'number', 'boolean', 'date']

/** The fields every op carries. `by` is the user id as a string, like the app
 *  stamps it, so the history dialog can name who made the edit. */
export function opBase(group: string, by: string | undefined, id: string, at = Date.now()) {
  return { id, at, group, ...(by ? { by } : {}) }
}

/** A value as the model gives it, read into the column's type the way the
 *  table's cell editor does, or an error when it does not fit. */
export function cellValue(
  value: unknown, type: string | undefined,
): { value: DatasetCellValue } | { error: string } {
  if (value === null || value === undefined) return { value: null }
  if (typeof value === 'object') return { error: 'a cell holds a single value, not an object or list' }
  const s = String(value).trim()
  if (s === '') return { value: null }
  const t = (type ?? 'string') as DatasetColumn['type'] & string
  if (t === 'number') {
    const n = Number(s)
    return Number.isFinite(n) ? { value: n } : { error: `"${s}" is not a number` }
  }
  if (t === 'boolean') {
    const l = s.toLowerCase()
    if (['true', '1', 'yes', 'y'].includes(l)) return { value: true }
    if (['false', '0', 'no', 'n'].includes(l)) return { value: false }
    return { error: `"${s}" is not a boolean (true/false)` }
  }
  if (t === 'date' && !fitsColumnType(s, 'date')) return { error: `"${s}" is not a date (YYYY-MM-DD, optionally with a time)` }
  return { value: s }
}

/** The ordinal a new row takes: added rows count down from -1, a space that can
 *  never collide with the raw file's own positions. */
export function nextAddedRow(ops: readonly DatasetOp[]): number {
  return Math.min(0, ...ops.filter((o) => o.type === 'addRow').map((o) => (o as { row: number }).row)) - 1
}

/** Column order with `columnId` moved after `after` (a column id), or first when
 *  `after` is null. */
export function columnOrderWith(columnIds: string[], columnId: string, after: string | null): string[] {
  const rest = columnIds.filter((id) => id !== columnId)
  const at = after === null ? 0 : rest.indexOf(after) + 1
  rest.splice(at, 0, columnId)
  return rest
}

/** Where the last `steps` actions start in the log: one action is one group, as
 *  the app's undo counts them. */
export function undoStart(ops: readonly DatasetOp[], steps: number): number {
  let end = ops.length
  for (let i = 0; i < steps && end > 0; i++) {
    const group = ops[end - 1].group
    end = group ? ops.findIndex((op) => op.group === group) : end - 1
  }
  return end
}

function describeOp(op: DatasetOp): string {
  switch (op.type) {
    case 'setCell': return `set row ${op.row} ${op.column} = ${JSON.stringify(op.value)}`
    case 'addRow': return `add row ${op.row}${op.values ? ` ${JSON.stringify(op.values)}` : ''}`
    case 'removeRow': return `remove row ${op.row}`
    case 'reorderRows': return `reorder ${op.order.length} rows`
    case 'addColumn': return `add column ${op.name} (${op.colType})`
    case 'removeColumn': return `remove column ${op.column}`
    case 'reorderColumns': return `reorder columns → ${op.order.join(', ')}`
    case 'renameColumn': return `rename ${op.column} → ${op.toName}`
  }
}

/** The log as actions (groups), newest first, capped. */
export function summarizeOps(ops: readonly DatasetOp[], limit = 30): string {
  const actions: DatasetOp[][] = []
  for (const op of ops) {
    const last = actions[actions.length - 1]
    if (last && op.group && last[0].group === op.group) last.push(op)
    else actions.push([op])
  }
  if (actions.length === 0) return 'No edit: the dataset is its raw file as imported.'
  const lines = actions.slice(-limit).reverse().map((group, i) => {
    const when = new Date(group[0].at).toISOString().slice(0, 16).replace('T', ' ')
    const who = group[0].by ? ` by user ${group[0].by}` : ''
    const shown = group.slice(0, 3).map(describeOp).join('; ')
    const more = group.length > 3 ? ` (+${group.length - 3} ops)` : ''
    return `${i + 1}. ${when}${who}: ${shown}${more}`
  })
  const head = `${actions.length} action(s), ${ops.length} op(s), newest first`
    + (actions.length > limit ? ` — the latest ${limit} shown` : '')
  return [head, ...lines].join('\n')
}

/** A row page as text, with each row's ordinal — the handle the edit tools take. */
export function formatRowPage(
  rows: Record<string, unknown>[], columns: DatasetColumn[], offset: number, ordinalsKnown: boolean,
): string {
  if (rows.length === 0) return '(no row)'
  const cols = columns.map((c) => c.id)
  const header = ['row', ...columns.map((c) => c.name)].join(' | ')
  const lines = rows.map((r, i) => {
    const ord = r[ROW_ORD] ?? (ordinalsKnown ? offset + i : '?')
    return [String(ord), ...cols.map((id) => cellText(r[id]))].join(' | ')
  })
  return [header, ...lines].join('\n')
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}

export interface RowFilterInput {
  column: string
  equals?: string | number | boolean
  contains?: string
  one_of?: (string | number)[]
  min?: number
  max?: number
  from?: string
  to?: string
  missing?: boolean
}

/** The model's filters as the rows endpoint reads them, columns resolved. */
export function buildRowFilters(
  filters: RowFilterInput[], columns: DatasetColumn[],
): { filters: Record<string, unknown>[]; na: Record<string, unknown>[]; errors: string[] } {
  const out: Record<string, unknown>[] = []
  const na: Record<string, unknown>[] = []
  const errors: string[] = []
  for (const f of filters) {
    const col = findColumn(columns, f.column)
    if (!col) { errors.push(`No column "${f.column}".`); continue }
    if (f.missing !== undefined) na.push({ colId: col.id, mode: f.missing ? 'only' : 'exclude' })
    const values = f.one_of ?? (f.equals !== undefined && col.type !== 'boolean' ? [f.equals] : undefined)
    if (values) { out.push({ colId: col.id, values: values.map(String) }); continue }
    if (col.type === 'boolean' && f.equals !== undefined) { out.push({ colId: col.id, value: String(f.equals) }); continue }
    if (f.min !== undefined || f.max !== undefined) {
      if (col.type !== 'number') { errors.push(`${col.name}: min/max need a number column (it is ${col.type}).`); continue }
      out.push({ colId: col.id, min: f.min ?? null, max: f.max ?? null })
      continue
    }
    if (f.from !== undefined || f.to !== undefined) {
      if (col.type !== 'date') { errors.push(`${col.name}: from/to need a date column (it is ${col.type}).`); continue }
      out.push({ colId: col.id, from: f.from ?? null, to: f.to ?? null })
      continue
    }
    if (f.contains !== undefined) {
      if (col.type === 'number' || col.type === 'date' || col.type === 'boolean') {
        errors.push(`${col.name}: "contains" is for text columns; use one_of, min/max or from/to.`)
        continue
      }
      out.push({ colId: col.id, value: f.contains })
      continue
    }
    if (f.missing === undefined) errors.push(`${col.name}: give equals, one_of, contains, min/max, from/to or missing.`)
  }
  return { filters: out, na, errors }
}

// --- Pipeline -----------------------------------------------------------------

export const PIPELINE_NODE_TYPES: PipelineNodeType[] = ['database', 'cohort', 'scripts', 'dataset', 'dashboard', 'group']

const DEFAULT_LABELS: Record<PipelineNodeType, string> = {
  database: 'Database', cohort: 'Cohort', scripts: 'Scripts', dataset: 'Dataset', dashboard: 'Dashboard', group: 'Group',
}

export interface PipelineGraph {
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}

/** Right of the rightmost top-level node, so a new node never lands on another. */
export function nextNodePosition(nodes: PipelineNode[]): { x: number; y: number } {
  const top = nodes.filter((n) => !n.parentId)
  if (top.length === 0) return { x: 0, y: 0 }
  const right = top.reduce((m, n) => Math.max(m, n.position.x + (n.width ?? 200)), 0)
  return { x: right + 80, y: top[0].position.y }
}

export interface NodeFields {
  label?: string
  dataSourceId?: string
  cohortId?: string
  dashboardId?: string
  datasetName?: string
  scripts?: string[]
}

/** A node as the canvas creates it: idle, labelled by its type unless named. */
export function newPipelineNode(
  id: string, type: PipelineNodeType, fields: NodeFields, position: { x: number; y: number }, scriptIds: () => string,
  parentId?: string,
): PipelineNode {
  const node: PipelineNode = {
    id, type, position,
    data: { label: fields.label ?? DEFAULT_LABELS[type], type, status: 'idle' },
  }
  Object.assign(node.data, nodeData(fields, scriptIds))
  if (type === 'group') { node.width = 300; node.height = 200 }
  if (parentId) node.parentId = parentId
  return node
}

/** The data fields a change sets; scripts become the ordered list the node holds. */
export function nodeData(fields: NodeFields, scriptIds: () => string): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (fields.label !== undefined) data.label = fields.label
  if (fields.dataSourceId !== undefined) data.dataSourceId = fields.dataSourceId
  if (fields.cohortId !== undefined) data.cohortId = fields.cohortId
  if (fields.dashboardId !== undefined) data.dashboardId = fields.dashboardId
  if (fields.datasetName !== undefined) data.datasetName = fields.datasetName
  if (fields.scripts !== undefined) {
    data.scripts = fields.scripts.map((filePath, displayOrder) => ({ id: scriptIds(), filePath, displayOrder }))
  }
  return data
}

/** Which link fields make sense on which node type, so a cohort id is never
 *  stored on a database node where the panel would not show it. */
export function checkNodeFields(type: PipelineNodeType, fields: NodeFields): string | null {
  const allowed: Record<PipelineNodeType, (keyof NodeFields)[]> = {
    database: ['dataSourceId'], cohort: ['cohortId'], scripts: ['scripts'], dataset: ['datasetName'],
    dashboard: ['dashboardId'], group: [],
  }
  const misplaced = (['dataSourceId', 'cohortId', 'dashboardId', 'datasetName', 'scripts'] as const)
    .filter((k) => fields[k] !== undefined && !allowed[type].includes(k))
  return misplaced.length ? `A ${type} node has no ${misplaced.join(', ')}.` : null
}

/** The graph without a node: its edges go, and a removed group's children stay,
 *  detached — as the canvas does. */
export function withoutNode(graph: PipelineGraph, nodeId: string): PipelineGraph {
  return {
    nodes: graph.nodes.filter((n) => n.id !== nodeId).map((n) => {
      if (n.parentId !== nodeId) return n
      const { parentId: _p, ...rest } = n
      return rest
    }),
    edges: graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
  }
}

export function connectError(graph: PipelineGraph, source: string, target: string): string | null {
  const ids = new Set(graph.nodes.map((n) => n.id))
  const missing = [source, target].filter((id) => !ids.has(id))
  if (missing.length) return `No node ${missing.join(', ')} in this pipeline (see describe_pipeline).`
  if (source === target) return 'A node cannot be linked to itself.'
  if (graph.edges.some((e) => e.source === source && e.target === target)) return 'These nodes are already linked.'
  return null
}

export function describePipeline(graph: PipelineGraph, name: string): string {
  if (graph.nodes.length === 0) return `Pipeline "${name}": empty.`
  const label = new Map(graph.nodes.map((n) => [n.id, n.data.label]))
  const lines = [`Pipeline "${name}": ${graph.nodes.length} node(s), ${graph.edges.length} link(s)`]
  for (const n of graph.nodes) {
    const d = n.data
    const links = [
      d.dataSourceId && `database ${d.dataSourceId}`, d.cohortId && `cohort ${d.cohortId}`,
      d.dashboardId && `dashboard ${d.dashboardId}`, d.datasetName && `dataset "${d.datasetName}"`,
      d.scripts?.length && `scripts ${[...d.scripts].sort((a, b) => a.displayOrder - b.displayOrder).map((s) => s.filePath).join(' → ')}`,
      n.parentId && `in group ${n.parentId}`,
    ].filter(Boolean)
    lines.push(`  ${d.type} "${d.label}" — node_id: ${n.id}${links.length ? ` · ${links.join(' · ')}` : ''}`)
  }
  for (const e of graph.edges) {
    lines.push(`  link "${label.get(e.source) ?? e.source}" → "${label.get(e.target) ?? e.target}" (${e.source} → ${e.target})`)
  }
  return lines.join('\n')
}

// --- Ordering -----------------------------------------------------------------

/** The full new order of a set of siblings: the ones named, in that order, then
 *  the others in their current order — or an error naming unknown ids. */
export function reorderIds(current: string[], requested: string[]): { order?: string[]; error?: string } {
  const known = new Set(current)
  const unknown = requested.filter((id) => !known.has(id))
  if (unknown.length) return { error: `Unknown id(s): ${unknown.join(', ')} (known: ${current.join(', ')}).` }
  const named = [...new Set(requested)]
  return { order: [...named, ...current.filter((id) => !named.includes(id))] }
}

// --- Patient boards -----------------------------------------------------------

const PATIENT_PLUGINS_DIR = fileURLToPath(new URL('../../../default-plugins/patient-data/', import.meta.url))

let patientCache: PluginManifest[] | null = null

/** The built-in Patient data widgets, read from their manifests on disk. */
export function listPatientPlugins(): PluginManifest[] {
  if (patientCache) return patientCache
  if (!existsSync(PATIENT_PLUGINS_DIR)) return (patientCache = [])
  patientCache = readdirSync(PATIENT_PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${PATIENT_PLUGINS_DIR}${d.name}/plugin.json`))
    .map((d) => JSON.parse(readFileSync(`${PATIENT_PLUGINS_DIR}${d.name}/plugin.json`, 'utf8')) as PluginManifest)
  return patientCache
}

/** Default footprint per widget, as the board's store places them. */
export function patientWidgetSize(pluginId: string): { w: number; h: number } {
  const sizes: Record<string, { w: number; h: number }> = {
    'linkr-widget-patient-summary': { w: 48, h: 24 },
    'linkr-widget-timeline': { w: 48, h: 14 },
    'linkr-widget-notes': { w: 48, h: 20 },
  }
  return sizes[pluginId] ?? { w: 24, h: 14 }
}

/** Config keys a built-in widget keeps outside its schema (set from inside the
 *  widget rather than its settings form), so they are not refused as typos. */
const EXTRA_CONFIG_KEYS: Record<string, string[]> = {
  'linkr-widget-timeline': ['conceptColors'],
  'linkr-widget-notes': ['wordSets', 'appliedWordSetIds', 'filterToWordSets'],
}

/**
 * A patient widget's config checked against its manifest: unknown keys refused,
 * concept ids as integers, select values among the options (numbers accepted for
 * a string option, as the form stores them), booleans and numbers typed.
 * `dataset-select` values are checked by the caller, which knows the datasets.
 */
export function checkPatientConfig(
  config: Record<string, unknown>, manifest: PluginManifest,
): { config: Record<string, unknown>; errors: string[] } {
  const schema: Record<string, PluginConfigField> = manifest.configSchema ?? {}
  const extras = new Set(EXTRA_CONFIG_KEYS[manifest.id] ?? [])
  const errors: string[] = []
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    const field = schema[key]
    if (!field) {
      if (extras.has(key)) out[key] = value
      else errors.push(`Unknown config field "${key}" for ${manifest.id} — see describe_patient_plugin.`)
      continue
    }
    if (value === null) continue
    switch (field.type) {
      case 'concept-select': {
        const ids = (Array.isArray(value) ? value : [value]).map(Number)
        if (ids.some((n) => !Number.isInteger(n))) errors.push(`${key}: a list of integer OMOP concept ids.`)
        else out[key] = ids
        break
      }
      case 'select': {
        const allowed = (field.options ?? []).map((o) => o.value)
        const vals = field.multi ? (Array.isArray(value) ? value : [value]) : [value]
        const bad = vals.filter((v) => !allowed.includes(String(v)))
        if (bad.length) errors.push(`${key}: ${bad.map((b) => JSON.stringify(b)).join(', ')} not one of ${allowed.join('|')}.`)
        else out[key] = field.multi ? vals.map(String) : String(value)
        break
      }
      case 'boolean':
        if (typeof value !== 'boolean') errors.push(`${key}: true or false.`)
        else out[key] = value
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${key}: a number.`)
        else out[key] = value
        break
      case 'dataset-select':
        if (!Array.isArray(value)) errors.push(`${key}: a list of dataset mappings.`)
        else out[key] = value
        break
      default:
        out[key] = value
    }
  }
  return { config: out, errors }
}

const MAPPING_COLUMNS = [
  'personColumn', 'visitColumn', 'visitDetailColumn', 'dateColumn', 'endColumn', 'valueColumn', 'textValueColumn',
] as const

/**
 * One Timeline dataset mapping (a variable read from a dataset), with its column
 * fields resolved from names to ids. A person and a date column are required —
 * the widget skips a mapping without them.
 */
export function resolveTimelineMapping(
  mapping: Record<string, unknown>, columns: DatasetColumn[],
): { mapping: Record<string, unknown>; errors: string[] } {
  const errors: string[] = []
  const out: Record<string, unknown> = { ...mapping }
  for (const key of MAPPING_COLUMNS) {
    const ref = mapping[key]
    if (ref === undefined || ref === null || ref === '') { delete out[key]; continue }
    const col = findColumn(columns, String(ref))
    if (!col) errors.push(`${key}: no column "${ref}" in ${mapping.datasetFileId}.`)
    else out[key] = col.id
  }
  for (const key of ['personColumn', 'dateColumn'] as const) {
    if (!mapping[key]) errors.push(`${key} is required.`)
  }
  const known = new Set<string>(['datasetFileId', 'seriesName', 'color', ...MAPPING_COLUMNS])
  const unknown = Object.keys(mapping).filter((k) => !known.has(k))
  if (unknown.length) errors.push(`Unknown mapping field(s): ${unknown.join(', ')}.`)
  return { mapping: out, errors }
}

// --- Workspace plugins --------------------------------------------------------

export type PluginScope = 'lab' | 'warehouse'
export type PluginLanguage = 'python' | 'r'

const TEMPLATE_EXT: Record<PluginLanguage, string> = { python: '.py.template', r: '.R.template' }

export function templateFile(language: PluginLanguage): string {
  return `analysis${TEMPLATE_EXT[language]}`
}

/** The starter code the app's editor gives a new plugin. */
export function scaffoldTemplate(scope: PluginScope, language: PluginLanguage): string {
  if (language === 'r') {
    return scope === 'warehouse'
      ? '# Variables available: person_id, visit_occurrence_id, visit_detail_id\n# Use sql_query() to query the database\n\ndf <- sql_query(paste0("SELECT * FROM person WHERE person_id = ", person_id))\nprint(df)\n'
      : '# \'dataset\' is a data.frame injected automatically.\n\nsummary(dataset)\n'
  }
  return scope === 'warehouse'
    ? 'import pandas as pd\n\n# Variables available: person_id, visit_occurrence_id, visit_detail_id\n# Use sql_query() to query the DuckDB database\n\ndf = await sql_query(f"SELECT * FROM person WHERE person_id = {person_id}")\nprint(df)\n'
    : 'import pandas as pd\n\n# \'dataset\' is a pandas DataFrame injected automatically.\n\n# Your analysis code here\nprint(dataset.describe())\n'
}

/** The manifest the app's create dialog writes for a new plugin. */
export function scaffoldManifest(args: {
  id: string; name: string; description: string; scope: PluginScope; languages: PluginLanguage[]
  icon?: string; configSchema?: Record<string, unknown>; dependencies?: { python?: string[]; r?: string[] }
}): Record<string, unknown> {
  return {
    id: args.id,
    name: { en: args.name, fr: args.name },
    description: { en: args.description, fr: args.description },
    version: '1.0.0',
    scope: args.scope,
    category: args.scope === 'warehouse' ? 'patient-data' : 'analysis',
    tags: [],
    runtime: ['script'],
    languages: args.languages,
    icon: args.icon ?? 'Puzzle',
    configSchema: args.configSchema ?? {},
    dependencies: { python: args.dependencies?.python ?? [], r: args.dependencies?.r ?? [] },
    templates: Object.fromEntries(args.languages.map((l) => [l, templateFile(l)])),
  }
}

const FIELD_TYPES = new Set([
  'column-select', 'column-value-select', 'number', 'select', 'boolean', 'string', 'icon-select', 'color-select',
  'palette-editor', 'concept-select', 'dataset-select', 'choice-order',
])

/**
 * A plugin's files checked as the app will read them: plugin.json parses, its
 * scope, languages and config fields are ones the app knows, each language has
 * a template file, and every `{{placeholder}}` names a config field. Errors
 * block the save; warnings are reported.
 */
export function checkPluginFiles(files: Record<string, string>): { manifest?: Record<string, unknown>; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(files['plugin.json'] ?? '')
  } catch {
    return { errors: ['plugin.json is missing or not valid JSON.'], warnings }
  }
  if (!manifest.id || typeof manifest.id !== 'string') errors.push('plugin.json needs a string "id".')
  const scope = manifest.scope ?? 'lab'
  if (scope !== 'lab' && scope !== 'warehouse') errors.push('scope must be "lab" (datasets, dashboards) or "warehouse" (Patient data).')
  const languages = (manifest.languages ?? []) as string[]
  if (!Array.isArray(languages) || languages.some((l) => l !== 'python' && l !== 'r')) errors.push('languages: a list of "python" and/or "r".')
  const templates = Object.keys(files).filter((f) => f.endsWith('.template'))
  for (const lang of Array.isArray(languages) ? languages : []) {
    const ext = TEMPLATE_EXT[lang as PluginLanguage]
    if (ext && !templates.some((f) => f.endsWith(ext))) errors.push(`languages lists ${lang} but no *${ext} file exists.`)
  }
  const schema = (manifest.configSchema ?? {}) as Record<string, { type?: string; options?: unknown[] }>
  for (const [key, field] of Object.entries(schema)) {
    if (!field || !FIELD_TYPES.has(field.type ?? '')) errors.push(`configSchema.${key}: unknown type "${field?.type}" (one of ${[...FIELD_TYPES].join(', ')}).`)
    else if (field.type === 'select' && !Array.isArray(field.options)) errors.push(`configSchema.${key}: a select needs "options" [{value, label}].`)
  }
  for (const f of templates) {
    for (const [, key] of files[f].matchAll(/\{\{(\w+)\}\}/g)) {
      if (!(key in schema)) warnings.push(`${f}: {{${key}}} is not a configSchema field — it will be filled with null.`)
    }
  }
  return { manifest, errors, warnings }
}
