/**
 * Renaming a dataset column in the live app.
 *
 * A column id is DERIVED from its name (`col_<slug>`), so a rename is a rekey: the
 * physical row key changes and every stored reference to the old id — dashboard
 * filters, plugin widget configs — is orphaned unless repaired in the same change.
 *
 * `rekey.ts` already solves this for export trees (the MCP authoring path). This is
 * its live-state counterpart: same collision rule, same value-matching discipline,
 * applied to the store's own records rather than to `_tree.json` documents.
 */
import { buildColumnIds } from '@/lib/column-id'
import type { DashboardFilter, DashboardWidget, DatasetColumn } from '@/types'

export interface ColumnRenamePlan {
  columns: DatasetColumn[]
  /** Old column id → new column id, for the ids that actually moved. */
  changes: Map<string, string>
  /** New column id → new display name (a filter stores the name beside the id). */
  namesById: Map<string, string>
}

/**
 * Work out the new column ids for a rename, or explain why it cannot be done.
 *
 * Throws when a rename would slug onto an *untouched* column's id: `buildColumnIds`
 * dedupes positionally and would silently push that bystander down a `_2` suffix,
 * repointing every widget and filter that named it. Refusing is the only safe
 * answer — the same guard `rekey.ts` applies.
 */
export function planColumnRename(
  columns: DatasetColumn[],
  columnId: string,
  newName: string,
): ColumnRenamePlan {
  const trimmed = newName.trim()
  if (!trimmed) throw new Error('empty-name')
  if (!columns.some((c) => c.id === columnId)) throw new Error('unknown-column')

  const names = columns.map((c) => (c.id === columnId ? trimmed : c.name))
  const ids = buildColumnIds(names)

  columns.forEach((column, i) => {
    if (column.id === columnId || ids[i] === column.id) return
    throw new Error('collision')
  })

  const changes = new Map<string, string>()
  const nextColumns = columns.map((column, i) => {
    if (column.id !== ids[i]) changes.set(column.id, ids[i])
    return { ...column, id: ids[i], name: names[i] }
  })

  return {
    columns: nextColumns,
    changes,
    namesById: new Map(nextColumns.map((c) => [c.id, c.name])),
  }
}

/**
 * Rewrite a widget's config so its column references follow the rename.
 *
 * Matched **by value, never by key name**: a real config mixes column references
 * with unrelated lists (`subtitleStats: ['median', 'min']`), so anything keyed off
 * the field name would rewrite the wrong thing. Strings and string arrays both,
 * exactly as the export-side resolver does.
 */
export function rekeyWidgetConfig(
  widget: DashboardWidget,
  datasetFileId: string,
  changes: Map<string, string>,
): DashboardWidget {
  if (!changes.size || widget.datasetFileId !== datasetFileId) return widget
  const config = (widget.source as { config?: Record<string, unknown> })?.config
  if (!config) return widget

  const remap = (value: unknown): unknown => {
    if (typeof value === 'string') return changes.get(value) ?? value
    if (Array.isArray(value)) return value.map(remap)
    return value
  }

  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) next[key] = remap(value)
  return { ...widget, source: { ...widget.source, config: next } }
}

/**
 * Rewrite a filter to follow the rename.
 *
 * `columnName` is updated alongside `columnId` and is NOT redundant: the sidebar
 * resolves the live column by NAME first and only falls back to the id, so leaving
 * the name stale means the rewritten id is never the branch taken.
 */
export function rekeyFilter(
  filter: DashboardFilter,
  datasetFileId: string,
  changes: Map<string, string>,
  namesById: Map<string, string>,
): DashboardFilter {
  if (!changes.size || filter.datasetFileId !== datasetFileId) return filter
  const next = changes.get(filter.columnId)
  if (!next) return filter
  const name = namesById.get(next)
  return { ...filter, columnId: next, ...(name ? { columnName: name } : {}) }
}
