import type { Dashboard, DashboardWidget, FilterValue } from '@/types'
import { localized } from '@/lib/localized'
import { FILTER_NONE } from './DashboardDataProvider'

/** Resolve which filters apply to a given widget, keyed by column ID. `widgetParentTabId` is the
 *  parent of the widget's tab (when it's a sub-tab), so a tab-scoped filter targeting a container
 *  tab also reaches the widgets living in its sub-tabs. */
export function resolveWidgetFilters(
  widget: DashboardWidget,
  dashboard: Dashboard,
  activeFilters: Record<string, FilterValue>,
  columnNameToId: Map<string, string>,
  widgetParentTabId: string | null | undefined,
): Record<string, FilterValue> | undefined {
  const result: Record<string, FilterValue> = {}
  let hasAny = false

  for (const filter of dashboard.filterConfig) {
    const filterValue = activeFilters[filter.id]
    if (!filterValue) continue

    // Check scope: skip if filter is scoped and widget is not in scope. A container tab in scope
    // covers the widgets of its sub-tabs, so match on the parent tab too.
    const scope = filter.scope ?? { type: 'all' }
    if (scope.type === 'tabs'
      && !scope.tabIds.includes(widget.tabId)
      && !(widgetParentTabId != null && scope.tabIds.includes(widgetParentTabId))) continue
    if (scope.type === 'widgets' && !scope.widgetIds.includes(widget.id)) continue

    if (filter.datasetFileId === widget.datasetFileId) {
      // Direct match: filter targets this widget's dataset
      result[filter.columnId] = filterValue
      hasAny = true
    } else {
      // Different dataset: match by column name (scope already decided this widget is in range).
      const targetColumnId = columnNameToId.get(filter.columnName)
      if (targetColumnId) {
        result[targetColumnId] = filterValue
        hasAny = true
      }
    }
  }

  return hasAny ? result : undefined
}

function formatRange(min: number | null, max: number | null): string {
  return `${min ?? '−∞'} – ${max ?? '+∞'}`
}

/** Structured summary of the filters that apply to a widget — one entry per active filter,
 *  with the display name and its restricting value(s) — for the widget's filter tooltip. */
export interface FilterChip { column: string; values: string[] }

/** Map a resolved column ID to a filter's custom label, when one is set. Built from the dashboard's
 *  filterConfig: a filter's `label` keys both its own column and the column its name resolves to in
 *  another dataset (cross-dataset matching), so the label follows the filter everywhere it lands. */
export function buildFilterLabelMap(
  dashboard: Dashboard,
  columnNameToId: Map<string, string>,
  language: string,
): Map<string, string> {
  const m = new Map<string, string>()
  for (const filter of dashboard.filterConfig) {
    const label = localized(filter.label, language)
    if (!label) continue
    m.set(filter.columnId, label)
    const targetId = columnNameToId.get(filter.columnName)
    if (targetId) m.set(targetId, label)
  }
  return m
}

export function buildFilterChips(
  filters: Record<string, FilterValue>,
  columns: { id: string; name: string }[],
  labelByColumnId?: Map<string, string>,
): FilterChip[] {
  const nameOf = (id: string) => labelByColumnId?.get(id) ?? columns.find((c) => c.id === id)?.name ?? id
  const chips: FilterChip[] = []
  for (const [colId, v] of Object.entries(filters)) {
    const column = nameOf(colId)
    switch (v.type) {
      case 'categorical':
        if (v.selected.length === 1 && v.selected[0] === FILTER_NONE) { chips.push({ column, values: ['∅'] }); break }
        if (v.selected.length === 0) break
        chips.push({ column, values: v.selected })
        break
      case 'numeric':
        if (v.min == null && v.max == null) break
        chips.push({ column, values: [formatRange(v.min, v.max)] })
        break
      case 'numeric-double': {
        const parts: string[] = []
        if (v.min1 != null || v.max1 != null) parts.push(formatRange(v.min1, v.max1))
        if (v.min2 != null || v.max2 != null) parts.push(formatRange(v.min2, v.max2))
        if (parts.length === 0) break
        chips.push({ column, values: parts })
        break
      }
      case 'date':
        if (!v.from && !v.to) break
        chips.push({ column, values: [`${v.from ?? '…'} – ${v.to ?? '…'}`] })
        break
      case 'date-relative':
        chips.push({ column, values: [`${v.count} ${v.unit}`] })
        break
    }
  }
  return chips
}

/** Filter chips that apply to a whole tab: the union of the chips of every widget on that tab,
 *  deduplicated by column name. Used for the tab's filter indicator. The widget's dataset columns
 *  resolve column IDs back to names, so a chip is only emitted when a filter genuinely reaches one
 *  of the tab's widgets (not merely because the dashboard defines it). */
export function buildTabFilterChips(
  tabId: string,
  dashboard: Dashboard,
  widgets: DashboardWidget[],
  activeFilters: Record<string, FilterValue>,
  files: { id: string; columns?: { id: string; name: string }[] }[],
  language: string,
): FilterChip[] {
  const byColumn = new Map<string, FilterChip>()
  for (const widget of widgets) {
    if (widget.tabId !== tabId) continue
    const datasetFile = files.find((f) => f.id === widget.datasetFileId)
    const columns = datasetFile?.columns ?? []
    const columnNameToId = new Map(columns.map((c) => [c.name, c.id]))
    const filters = resolveWidgetFilters(widget, dashboard, activeFilters, columnNameToId, null)
    if (!filters) continue
    const labelMap = buildFilterLabelMap(dashboard, columnNameToId, language)
    for (const chip of buildFilterChips(filters, columns, labelMap)) {
      if (!byColumn.has(chip.column)) byColumn.set(chip.column, chip)
    }
  }
  return Array.from(byColumn.values())
}
