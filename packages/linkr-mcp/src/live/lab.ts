/**
 * Pure helpers for dashboard widgets: the checks that turn a model's config into
 * one the widget renders, instead of a blank chart with an empty column picker.
 */
import type { DashboardFilter } from '@/types'
import type { PluginManifest } from '@/types/plugin'

/** Dashboards use a 48-column grid (gridV 2); a new widget is half width. */
export const GRID_COLUMNS = 48
export const DEFAULT_LAYOUT = { w: 24, h: 12 }

export interface DatasetColumn {
  id: string
  name: string
  type?: string
}

export interface Layout {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Resolve the column fields of a config to column ids, and report what cannot be
 * resolved.
 *
 * The config keys columns by id (`col_age`). A model reaches for the name the
 * user said (`age`), and the widget then rendered blank with no error — so a name
 * is mapped to its id, case-insensitively, and anything else is reported rather
 * than stored.
 */
export function resolveColumns(
  config: Record<string, unknown>,
  manifest: PluginManifest,
  columns: DatasetColumn[],
): { config: Record<string, unknown>; errors: string[] } {
  const ids = new Set(columns.map((c) => c.id))
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c.id]))
  const errors: string[] = []
  const resolve = (key: string, value: unknown): unknown => {
    if (typeof value !== 'string' || value === '' || ids.has(value)) return value
    const id = byName.get(value.toLowerCase()) ?? (ids.has(`col_${value}`) ? `col_${value}` : undefined)
    if (id) return id
    errors.push(`${key}: no column "${value}" (columns: ${columns.map((c) => c.name).join(', ')}).`)
    return value
  }
  const out: Record<string, unknown> = { ...config }
  for (const [key, field] of Object.entries(manifest.configSchema ?? {})) {
    if (field.type !== 'column-select' || !(key in out)) continue
    const value = out[key]
    out[key] = Array.isArray(value) ? value.map((v) => resolve(key, v)) : resolve(key, value)
  }
  const unknown = Object.keys(config).filter((k) => !(k in (manifest.configSchema ?? {})))
  if (unknown.length) {
    errors.push(`Unknown config field(s) for ${manifest.id}: ${unknown.join(', ')} — see describe_plugin.`)
  }
  return { config: out, errors }
}

/** Where a new widget goes: the requested layout clamped to the grid, else just
 *  below the lowest widget of its tab. */
export function placeWidget(existing: Layout[], requested?: Partial<Layout>): Layout {
  const bottom = existing.reduce((max, l) => Math.max(max, l.y + l.h), 0)
  const w = Math.min(Math.max(Math.round(requested?.w ?? DEFAULT_LAYOUT.w), 1), GRID_COLUMNS)
  return {
    x: Math.min(Math.max(Math.round(requested?.x ?? 0), 0), GRID_COLUMNS - w),
    y: Math.max(Math.round(requested?.y ?? bottom), 0),
    w,
    h: Math.max(Math.round(requested?.h ?? DEFAULT_LAYOUT.h), 1),
  }
}

/** Localized text from what a model writes: the same string in both languages,
 *  so the label is never blank in the other one. */
export function bilingual(value: string): Record<string, string> {
  return { en: value, fr: value }
}

const INPUT_TYPES: Record<DashboardFilter['type'], DashboardFilter['inputType'][]> = {
  categorical: ['multi-select', 'checkbox', 'single-select'],
  numeric: ['range', 'double-range', 'multi-select', 'checkbox', 'single-select'],
  date: ['range', 'slider', 'multi-select', 'checkbox', 'single-select'],
}

/**
 * A dashboard filter on one dataset column, with the defaults the app's filter
 * dialog picks (numbers and dates as a range, the rest as a multi-select), or an
 * error naming what is allowed.
 */
export function buildFilter(args: {
  id: string
  datasetPath: string
  column: string
  columns: DatasetColumn[]
  inputType?: string
  label?: string
  tabIds?: string[]
}): { filter?: DashboardFilter; error?: string } {
  const col = args.columns.find((c) => c.id === args.column)
    ?? args.columns.find((c) => c.name.toLowerCase() === args.column.toLowerCase())
  if (!col) return { error: `No column "${args.column}" (columns: ${args.columns.map((c) => c.name).join(', ')}).` }
  const type: DashboardFilter['type'] = col.type === 'number' ? 'numeric' : col.type === 'date' ? 'date' : 'categorical'
  const allowed = INPUT_TYPES[type]
  const inputType = (args.inputType ?? allowed[0]) as DashboardFilter['inputType']
  if (!allowed.includes(inputType)) {
    return { error: `input_type "${args.inputType}" does not fit a ${type} column (allowed: ${allowed.join(', ')}).` }
  }
  return {
    filter: {
      id: args.id,
      datasetFileId: args.datasetPath,
      columnId: col.id,
      columnName: col.name,
      type,
      inputType,
      ...(args.label ? { label: bilingual(args.label) } : {}),
      scope: args.tabIds?.length ? { type: 'tabs', tabIds: args.tabIds } : { type: 'all' },
    },
  }
}

/** The editorial fields a column's sidecar metadata holds; the endpoint takes the
 *  whole set for every column, so the others must be sent back unchanged. */
const COLUMN_META_FIELDS = ['label', 'description', 'valueLabels', 'withTime', 'required', 'min', 'max', 'allowedValues']

export interface ColumnMetaChange {
  label?: string
  description?: string
  valueLabels?: Record<string, string>
}

/**
 * The full column-metadata map with one column changed: every other column keeps
 * what it had, and an empty string clears a field.
 */
export function columnMetaMap(
  columns: (DatasetColumn & Record<string, unknown>)[],
  columnId: string,
  change: ColumnMetaChange,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const col of columns) {
    const entry: Record<string, unknown> = {}
    for (const f of COLUMN_META_FIELDS) if (col[f] !== undefined && col[f] !== null) entry[f] = col[f]
    if (col.id === columnId) {
      for (const [k, v] of Object.entries(change)) {
        if (v === undefined) continue
        if (v === '') delete entry[k]
        else entry[k] = v
      }
    }
    if (Object.keys(entry).length) out[col.id] = entry
  }
  return out
}

/** A column by id or name (case-insensitive). */
export function findColumn<T extends DatasetColumn>(columns: T[], ref: string): T | undefined {
  return columns.find((c) => c.id === ref) ?? columns.find((c) => c.name.toLowerCase() === ref.toLowerCase())
}
