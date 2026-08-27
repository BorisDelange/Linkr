/**
 * Read a dashboard file back into the spec that would re-write it.
 *
 * This is the missing half of read-modify-write. Without it an agent asked to
 * change one widget has to open the JSON itself, and from there it edits derived
 * ids by hand — the failure `linkr-authoring` forbids and that
 * `sql-collection-id-churn` already cost once.
 *
 * The contract is **lossless**: everything the spec cannot express is carried in
 * `extra` (see `Passthrough`), so `serializeProject(readDashboard(file))` returns
 * the original bytes. A reader that silently dropped `widgetSpacing` or a filter's
 * `scope` would be worse than no reader at all — the absence of a tool blocks,
 * but a lossy round trip deletes a user's configuration without telling anyone.
 *
 * It reads what the app writes, so it works on trees this package never produced:
 * a project pulled from a portal or a content repo.
 */
import {
  KEY_ORDER,
  type DashboardSpec, type FilterScope, type FilterSpec, type LocalizedInput,
  type Passthrough, type TabSpec, type WidgetSpec,
} from '../serialize/project.js'

/** Keys the serializer computes for each record; everything else rides in `extra`. */
const DASHBOARD_KEYS = ['name', 'description', 'filterConfig', 'showWidgetTitles', 'gridV']
const TAB_KEYS = ['name', 'description', 'displayOrder', 'key', 'parentKey']
const WIDGET_KEYS = ['name', 'description', 'datasetFileId', 'layout', 'source', 'key', 'tabKey']
const FILTER_KEYS = ['datasetFileId', 'columnId', 'columnName', 'type', 'inputType', 'label', 'scope']

/**
 * The record's own keys, minus the ones the serializer recomputes.
 *
 * The **order is kept**: `withExtra` walks it to rebuild the original key order,
 * so dropping it here would move fields and produce a diff on an untouched tree.
 * Returns undefined when nothing is left over, so a spec read from a minimal file
 * stays as clean as a hand-written one.
 */
function extraOf(record: Record<string, unknown>, known: string[]): Passthrough | undefined {
  const out: Passthrough = {}
  let any = false
  for (const [key, value] of Object.entries(record)) {
    if (known.includes(key)) continue
    out[key] = value
    any = true
  }
  // The full order, computed keys included: `out` holds only the leftovers, so on
  // its own it cannot say that `defaultDatasetFileId` came before `gridV`.
  // Recorded under a symbol so it never serializes as a field.
  if (any) out[KEY_ORDER] = Object.keys(record)
  return any ? out : undefined
}

/** A localized value in whatever form the file holds it. */
function nameOf(value: unknown): LocalizedInput {
  if (typeof value === 'string') return { en: value }
  if (value && typeof value === 'object') return value as LocalizedInput
  return { en: '' }
}

/** `stays.csv` → `stays`, the name a spec addresses a dataset by. */
function datasetOf(fileId: unknown): string | undefined {
  return typeof fileId === 'string' ? fileId.replace(/\.csv$/, '') : undefined
}

export interface DashboardFile {
  dashboard?: Record<string, unknown>
  tabs?: Record<string, unknown>[]
  widgets?: Record<string, unknown>[]
}

/**
 * One `dashboards/<slug>.json` → the spec that reproduces it.
 *
 * Tabs and widgets are addressed by NAME in a spec but by key in the file, so the
 * key map is rebuilt here to resolve a widget's tab and a sub-tab's parent.
 */
export function readDashboard(file: DashboardFile): DashboardSpec {
  const dashboard = file.dashboard ?? {}
  const tabsIn = file.tabs ?? []
  const widgetsIn = file.widgets ?? []

  // key → English name, so a widget's `tabKey` and a tab's `parentKey` resolve to
  // the names a spec uses. Two tabs may share a name; the key is what disambiguates
  // them in the file, and a spec cannot express that — recorded as a caveat below.
  const nameByKey = new Map<string, string>()
  for (const tab of tabsIn) {
    const label = nameOf(tab.name).en ?? ''
    if (typeof tab.key === 'string') nameByKey.set(tab.key, label)
  }

  const tabs: TabSpec[] = tabsIn.map((tab) => {
    const parentKey = typeof tab.parentKey === 'string' ? tab.parentKey : null
    return {
      name: nameOf(tab.name),
      ...descriptionOf(tab.description),
      ...(parentKey ? { parent: nameByKey.get(parentKey) ?? parentKey } : {}),
      ...withExtraKey(extraOf(tab, TAB_KEYS)),
    }
  })

  const widgets: WidgetSpec[] = widgetsIn.map((widget) => {
    const source = (widget.source ?? {}) as Record<string, unknown>
    const config = (source.config ?? {}) as Record<string, unknown>
    const tabKey = typeof widget.tabKey === 'string' ? widget.tabKey : ''
    const dataset = datasetOf(widget.datasetFileId)
    const layout = widget.layout as WidgetSpec['layout']

    return {
      name: nameOf(widget.name),
      ...descriptionOf(widget.description),
      tab: nameByKey.get(tabKey) ?? tabKey,
      ...(dataset ? { dataset } : {}),
      // Carried whole rather than split into pluginId/code: the block may use a
      // legacy spelling, and re-deriving it would rewrite a widget nobody edited.
      // `config` is still surfaced so an agent can edit it by column name.
      source,
      ...(Object.keys(config).length ? { config } : {}),
      ...(layout ? { layout } : {}),
      ...withExtraKey(extraOf(widget, WIDGET_KEYS)),
    }
  })

  const filters: FilterSpec[] = ((dashboard.filterConfig ?? []) as Record<string, unknown>[])
    .map((filter) => ({
      dataset: datasetOf(filter.datasetFileId) ?? '',
      // The file stores both; `columnName` is what a spec addresses, and it is
      // what lets a re-serialize resolve the id again rather than trusting a
      // stale one.
      column: typeof filter.columnName === 'string'
        ? filter.columnName
        : String(filter.columnId ?? ''),
      ...(typeof filter.label === 'string' ? { label: filter.label } : {}),
      ...(filter.inputType ? { inputType: filter.inputType as FilterSpec['inputType'] } : {}),
      ...(filter.scope ? { scope: filter.scope as FilterScope } : {}),
      ...withExtraKey(extraOf(filter, FILTER_KEYS)),
    }))

  return {
    name: nameOf(dashboard.name),
    ...descriptionOf(dashboard.description),
    tabs,
    ...(widgets.length ? { widgets } : {}),
    ...(filters.length ? { filters } : {}),
    ...(typeof dashboard.showWidgetTitles === 'boolean'
      ? { showWidgetTitles: dashboard.showWidgetTitles }
      : {}),
    ...(dashboard.gridV != null ? { gridV: dashboard.gridV as 1 | 2 } : {}),
    ...withExtraKey(extraOf(dashboard, DASHBOARD_KEYS)),
  }
}

/**
 * `description` only when the record has one.
 *
 * The serializer writes `description: null` for "none", so carrying that null
 * into every spec would make each one noisier than the hand-written examples the
 * skill's references show.
 */
function descriptionOf(value: unknown): { description?: LocalizedInput } {
  if (value == null) return {}
  return { description: nameOf(value) }
}

/** Spread `extra` only when there is one, so specs stay free of empty objects. */
function withExtraKey(extra: Passthrough | undefined): { extra?: Passthrough } {
  return extra ? { extra } : {}
}
