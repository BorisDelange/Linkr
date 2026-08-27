/**
 * Rename or move a record whose identity is derived from what you are changing.
 *
 * A tab's key is `<parent>/<slug(name)>`; a widget's is `<tabKey>/<slug(name)>@<y>,<x>`.
 * So **renaming a tab or moving a widget changes its key**, and the key is what
 * every other record references:
 *
 *   tab key    ← widgets (`tabKey`), sub-tabs (`parentKey`), filters (`scope.tabKeys`)
 *   widget key ← filters (`scope.widgetKeys`)
 *
 * Rewriting the record alone leaves those pointing at a key that no longer exists.
 * Nothing errors: the widgets simply detach from their tab, and a scoped filter
 * silently widens to the whole dashboard. That is the same shape as the
 * `sql-collection-id-churn` bug this project has already paid for once, which is
 * why the cascade lives here — in the package that owns key derivation — rather
 * than in whichever caller happens to need it.
 *
 * Every function returns a **new** document plus the key changes it made, so a
 * caller can report them. None of them touch the filesystem.
 */
import { buildColumnIds, slugify } from './ids.js'
import { readLocalized } from './check.js'

/** What the cascade rewrote, for a caller that wants to report it. */
export interface Rekeyed<T> {
  doc: T
  /** Old key → new key, for every record whose identity moved. */
  changes: Map<string, string>
}

interface TabRecord {
  name?: unknown
  key?: string
  parentKey?: string | null
  displayOrder?: number
  [field: string]: unknown
}

interface WidgetRecord {
  name?: unknown
  key?: string
  tabKey?: string
  layout?: { x: number; y: number; w: number; h: number }
  [field: string]: unknown
}

interface FilterRecord {
  scope?: { type?: string; tabKeys?: string[]; widgetKeys?: string[] } | null
  [field: string]: unknown
}

export interface DashboardDocument {
  dashboard?: { filterConfig?: FilterRecord[]; [field: string]: unknown }
  tabs?: TabRecord[]
  widgets?: WidgetRecord[]
}

/** The English label a key is built from. */
function labelOf(name: unknown): string {
  return readLocalized(name as never, 'en') || ''
}

/** A widget's key from its parts, before collision handling. */
function widgetKeyOf(tabKey: string, name: unknown, layout: { x: number; y: number }): string {
  return `${tabKey}/${slugify(labelOf(name))}@${layout.y},${layout.x}`
}

/**
 * Sort widgets the way every writer does, so a mutation does not reorder the file.
 *
 * Array order is byte-visible. Leaving a moved widget where it sat would show up
 * as a diff on lines nobody edited, on top of the diff that was actually wanted.
 */
function sortWidgets(widgets: WidgetRecord[]): WidgetRecord[] {
  return [...widgets].sort((a, b) =>
    (a.tabKey ?? '') < (b.tabKey ?? '') ? -1
      : (a.tabKey ?? '') > (b.tabKey ?? '') ? 1
        : (a.key ?? '') < (b.key ?? '') ? -1 : 1)
}

function sortTabs(tabs: TabRecord[]): TabRecord[] {
  return [...tabs].sort((a, b) => ((a.key ?? '') < (b.key ?? '') ? -1 : (a.key ?? '') > (b.key ?? '') ? 1 : 0))
}

/** Apply a key remap to every filter scope that names one of the changed keys. */
function remapScopes(
  filters: FilterRecord[] | undefined,
  changes: Map<string, string>,
  field: 'tabKeys' | 'widgetKeys',
): FilterRecord[] | undefined {
  if (!filters || !changes.size) return filters
  return filters.map((filter) => {
    const keys = filter.scope?.[field]
    if (!keys) return filter
    return {
      ...filter,
      scope: { ...filter.scope, [field]: keys.map((k) => changes.get(k) ?? k) },
    }
  })
}

/**
 * Rename a tab, cascading into its widgets, its sub-tabs and any filter scoped to it.
 *
 * A sub-tab's key contains its parent's, so renaming a parent re-keys the whole
 * subtree — and each of those sub-tabs owns widgets whose keys must move too.
 */
export function renameTab(
  doc: DashboardDocument,
  key: string,
  name: unknown,
): Rekeyed<DashboardDocument> {
  const tabs = doc.tabs ?? []
  const target = tabs.find((t) => t.key === key)
  if (!target) {
    throw new Error(`Unknown tab "${key}". Known: ${tabs.map((t) => t.key).join(', ') || 'none'}.`)
  }
  const label = labelOf(name)
  if (!label) throw new Error('The tab needs a name.')

  const parentKey = target.parentKey ?? key.slice(0, key.lastIndexOf('/'))
  const newKey = `${parentKey}/${slugify(label)}`
  if (newKey !== key && tabs.some((t) => t.key === newKey)) {
    throw new Error(`A tab with key "${newKey}" already exists — pick another name.`)
  }

  // Parent first, then every descendant whose key is prefixed by it.
  const tabChanges = new Map<string, string>()
  if (newKey !== key) {
    tabChanges.set(key, newKey)
    for (const tab of tabs) {
      if (tab.key && tab.key.startsWith(`${key}/`)) {
        tabChanges.set(tab.key, `${newKey}${tab.key.slice(key.length)}`)
      }
    }
  }

  const nextTabs = tabs.map((tab) => {
    const moved = tab.key ? tabChanges.get(tab.key) : undefined
    const movedParent = tab.parentKey ? tabChanges.get(tab.parentKey) : undefined
    if (tab.key === key) return { ...tab, name, key: moved ?? tab.key }
    if (!moved && !movedParent) return tab
    return {
      ...tab,
      ...(moved ? { key: moved } : {}),
      ...(movedParent ? { parentKey: movedParent } : {}),
    }
  })

  // A widget's key embeds its tab's, so every widget under a moved tab moves too.
  const widgetChanges = new Map<string, string>()
  const nextWidgets = (doc.widgets ?? []).map((widget) => {
    const movedTab = widget.tabKey ? tabChanges.get(widget.tabKey) : undefined
    if (!movedTab || !widget.layout) return widget
    const nextKey = widgetKeyOf(movedTab, widget.name, widget.layout)
    if (widget.key) widgetChanges.set(widget.key, nextKey)
    return { ...widget, tabKey: movedTab, key: nextKey }
  })

  return {
    doc: {
      ...doc,
      dashboard: {
        ...doc.dashboard,
        filterConfig: remapScopes(
          remapScopes(doc.dashboard?.filterConfig, tabChanges, 'tabKeys'),
          widgetChanges,
          'widgetKeys',
        ),
      },
      tabs: sortTabs(nextTabs),
      widgets: sortWidgets(nextWidgets),
    },
    changes: new Map([...tabChanges, ...widgetChanges]),
  }
}

/**
 * Move a widget on the grid, and/or to another tab, re-keying it.
 *
 * `layout` may carry only `x`/`y`: `w`/`h` are kept unless given, since a move is
 * usually not a resize.
 */
export function moveWidget(
  doc: DashboardDocument,
  key: string,
  to: { tabKey?: string; x?: number; y?: number; w?: number; h?: number },
): Rekeyed<DashboardDocument> {
  const widgets = doc.widgets ?? []
  const target = widgets.find((w) => w.key === key)
  if (!target) {
    throw new Error(
      `Unknown widget "${key}". Known: ${widgets.map((w) => w.key).join(', ') || 'none'}.`,
    )
  }
  const tabKey = to.tabKey ?? target.tabKey ?? ''
  if (to.tabKey && !(doc.tabs ?? []).some((t) => t.key === to.tabKey)) {
    throw new Error(
      `Unknown tab "${to.tabKey}". Known: ${(doc.tabs ?? []).map((t) => t.key).join(', ') || 'none'}.`,
    )
  }

  const layout = {
    x: to.x ?? target.layout?.x ?? 0,
    y: to.y ?? target.layout?.y ?? 0,
    w: to.w ?? target.layout?.w ?? 12,
    h: to.h ?? target.layout?.h ?? 8,
  }
  const newKey = widgetKeyOf(tabKey, target.name, layout)
  if (newKey !== key && widgets.some((w) => w.key === newKey)) {
    throw new Error(
      `A widget with key "${newKey}" already exists — that name is already at that position.`,
    )
  }

  const changes = newKey === key ? new Map<string, string>() : new Map([[key, newKey]])
  const nextWidgets = widgets.map((w) =>
    w.key === key ? { ...w, tabKey, layout, key: newKey } : w)

  return {
    doc: {
      ...doc,
      dashboard: {
        ...doc.dashboard,
        filterConfig: remapScopes(doc.dashboard?.filterConfig, changes, 'widgetKeys'),
      },
      widgets: sortWidgets(nextWidgets),
    },
    changes,
  }
}

/**
 * Rename a widget, re-keying it and any filter scoped to it.
 *
 * Same cascade as a move — the key embeds the name as well as the position.
 */
export function renameWidget(
  doc: DashboardDocument,
  key: string,
  name: unknown,
): Rekeyed<DashboardDocument> {
  const widgets = doc.widgets ?? []
  const target = widgets.find((w) => w.key === key)
  if (!target) {
    throw new Error(
      `Unknown widget "${key}". Known: ${widgets.map((w) => w.key).join(', ') || 'none'}.`,
    )
  }
  if (!labelOf(name)) throw new Error('The widget needs a name.')

  const layout = target.layout ?? { x: 0, y: 0, w: 12, h: 8 }
  const newKey = widgetKeyOf(target.tabKey ?? '', name, layout)
  if (newKey !== key && widgets.some((w) => w.key === newKey)) {
    throw new Error(`A widget with key "${newKey}" already exists — pick another name.`)
  }

  const changes = newKey === key ? new Map<string, string>() : new Map([[key, newKey]])
  const nextWidgets = widgets.map((w) => (w.key === key ? { ...w, name, key: newKey } : w))

  return {
    doc: {
      ...doc,
      dashboard: {
        ...doc.dashboard,
        filterConfig: remapScopes(doc.dashboard?.filterConfig, changes, 'widgetKeys'),
      },
      widgets: sortWidgets(nextWidgets),
    },
    changes,
  }
}

/** What removing a record would take with it, so a caller can say so first. */
export interface Collateral {
  /** Records that disappear with the target. */
  removes: string[]
  /** Filter scopes that lose a reference. */
  scopes: string[]
}

/**
 * What `removeTab` would destroy beyond the tab itself.
 *
 * Reported *before* the removal, per the plan's D2: a tab looks like one record
 * but owns its widgets and its whole sub-tree, and a caller that deletes three
 * widgets by accident has no undo.
 */
export function tabCollateral(doc: DashboardDocument, key: string): Collateral {
  const tabs = doc.tabs ?? []
  const doomedTabs = tabs
    .filter((t) => t.key === key || (t.key?.startsWith(`${key}/`) ?? false))
    .map((t) => t.key!)
  const doomedWidgets = (doc.widgets ?? [])
    .filter((w) => w.tabKey && doomedTabs.includes(w.tabKey))
    .map((w) => w.key!)
  const gone = new Set([...doomedTabs, ...doomedWidgets])

  const scopes: string[] = []
  for (const filter of doc.dashboard?.filterConfig ?? []) {
    const referenced = [...(filter.scope?.tabKeys ?? []), ...(filter.scope?.widgetKeys ?? [])]
    if (referenced.some((k) => gone.has(k))) scopes.push(String(filter.columnId ?? '(filter)'))
  }
  return { removes: [...doomedTabs, ...doomedWidgets], scopes }
}

/** Remove a tab, its sub-tabs, their widgets, and every scope entry naming them. */
export function removeTab(doc: DashboardDocument, key: string): Rekeyed<DashboardDocument> {
  const tabs = doc.tabs ?? []
  if (!tabs.some((t) => t.key === key)) {
    throw new Error(`Unknown tab "${key}". Known: ${tabs.map((t) => t.key).join(', ') || 'none'}.`)
  }
  const { removes } = tabCollateral(doc, key)
  const gone = new Set(removes)

  return {
    doc: {
      ...doc,
      dashboard: {
        ...doc.dashboard,
        filterConfig: dropFromScopes(doc.dashboard?.filterConfig, gone),
      },
      tabs: tabs.filter((t) => !gone.has(t.key ?? '')),
      widgets: (doc.widgets ?? []).filter((w) => !gone.has(w.key ?? '')),
    },
    changes: new Map(),
  }
}

/** Remove one widget, and every scope entry naming it. */
export function removeWidget(doc: DashboardDocument, key: string): Rekeyed<DashboardDocument> {
  const widgets = doc.widgets ?? []
  if (!widgets.some((w) => w.key === key)) {
    throw new Error(
      `Unknown widget "${key}". Known: ${widgets.map((w) => w.key).join(', ') || 'none'}.`,
    )
  }
  return {
    doc: {
      ...doc,
      dashboard: {
        ...doc.dashboard,
        filterConfig: dropFromScopes(doc.dashboard?.filterConfig, new Set([key])),
      },
      widgets: widgets.filter((w) => w.key !== key),
    },
    changes: new Map(),
  }
}

/**
 * Drop removed keys from every filter scope.
 *
 * A scope emptied by this is left as an empty list rather than deleted: the
 * filter still says "only these widgets", and there are now none — which is what
 * the user asked for. Deleting the scope would silently widen the filter to the
 * whole dashboard, the opposite of their intent.
 */
function dropFromScopes(
  filters: FilterRecord[] | undefined,
  gone: Set<string>,
): FilterRecord[] | undefined {
  if (!filters) return filters
  return filters.map((filter) => {
    const { tabKeys, widgetKeys } = filter.scope ?? {}
    if (!tabKeys && !widgetKeys) return filter
    return {
      ...filter,
      scope: {
        ...filter.scope,
        ...(tabKeys ? { tabKeys: tabKeys.filter((k) => !gone.has(k)) } : {}),
        ...(widgetKeys ? { widgetKeys: widgetKeys.filter((k) => !gone.has(k)) } : {}),
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Column ids
// ---------------------------------------------------------------------------

/** A dataset entry as `datasets/_tree.json` stores it. */
export interface DatasetRecord {
  id?: string
  name?: string
  columns?: { id: string; name: string; type?: string; order?: number }[]
  [field: string]: unknown
}

/**
 * Rewrite one column id everywhere a dashboard can reference it.
 *
 * Two places, and they are found differently:
 *   - a filter's `columnId` — a known field;
 *   - a widget's `source.config` — arbitrary keys chosen by each plugin.
 *
 * The config is therefore matched **by value, never by key name**. A real config
 * mixes column references with unrelated lists (`subtitleStats: ["median","min"]`),
 * so anything that guessed from the key would rewrite the wrong thing. Strings and
 * string arrays are both handled, exactly as the serializer's own resolver does.
 */
function rewriteColumnRefs(
  doc: DashboardDocument,
  datasetFileId: string,
  changes: Map<string, string>,
): DashboardDocument {
  if (!changes.size) return doc

  const remap = (value: unknown): unknown => {
    if (typeof value === 'string') return changes.get(value) ?? value
    if (Array.isArray(value)) return value.map(remap)
    return value
  }

  const widgets = (doc.widgets ?? []).map((widget) => {
    // Only widgets bound to this dataset: two datasets can both have a `col_age`,
    // and rewriting the other one's widgets would corrupt them.
    if (widget.datasetFileId !== datasetFileId) return widget
    const source = widget.source as { config?: Record<string, unknown> } | undefined
    if (!source?.config) return widget
    const config: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source.config)) config[key] = remap(value)
    return { ...widget, source: { ...source, config } }
  })

  const filterConfig = (doc.dashboard?.filterConfig ?? []).map((filter) => {
    const f = filter as FilterRecord & { datasetFileId?: string; columnId?: string; columnName?: string }
    if (f.datasetFileId !== datasetFileId) return filter
    const next = changes.get(String(f.columnId))
    return next ? { ...filter, columnId: next } : filter
  })

  return {
    ...doc,
    dashboard: { ...doc.dashboard, filterConfig },
    widgets,
  }
}

export interface ColumnRename {
  /** Column id as it stands today, from `datasets/_tree.json`. */
  from: string
  /** New display name; the new id is derived from it. */
  to: string
}

export interface DatasetRekey {
  dataset: DatasetRecord
  dashboards: Map<string, DashboardDocument>
  changes: Map<string, string>
}

/**
 * Rename dataset columns, re-deriving their ids and repointing every reference.
 *
 * A column id is `col_<slug(name)>`, so renaming a column **changes its id** — and
 * the id is what every widget config and filter holds. Rename without the cascade
 * and the widget keeps pointing at an id nothing answers to: it renders blank,
 * with an empty column picker and no error. Same silent shape as an orphaned
 * widget key, on the data side.
 *
 * Ids are rebuilt over the **whole ordered column list**, not one at a time,
 * because collision suffixes (`_2`, `_3`) are handed out in header order: two
 * names that normalise to one slug are only correct in one arrangement.
 *
 * The CSV header is *not* rewritten here — the caller owns the file, and a header
 * rewrite is a data edit rather than a metadata one. `columns[].name` is what the
 * app displays.
 */
export function renameDatasetColumns(
  dataset: DatasetRecord,
  dashboards: Map<string, DashboardDocument>,
  renames: ColumnRename[],
): DatasetRekey {
  const columns = dataset.columns ?? []
  if (!columns.length) throw new Error(`Dataset "${dataset.id ?? '?'}" declares no columns.`)

  const byId = new Map(columns.map((c) => [c.id, c]))
  for (const { from } of renames) {
    if (!byId.has(from)) {
      throw new Error(
        `Unknown column "${from}". Known: ${columns.map((c) => c.id).join(', ')}.`,
      )
    }
  }
  const newNameById = new Map(renames.map((r) => [r.from, r.to]))
  for (const { to } of renames) {
    if (!to.trim()) throw new Error('A column needs a name.')
  }

  const names = columns.map((c) => newNameById.get(c.id) ?? c.name)
  const ids = buildColumnIds(names)

  const changes = new Map<string, string>()
  const nextColumns = columns.map((column, i) => {
    if (column.id !== ids[i]) changes.set(column.id, ids[i])
    return { ...column, id: ids[i], name: names[i] }
  })

  const fileId = String(dataset.id ?? dataset.name ?? '')
  const nextDashboards = new Map<string, DashboardDocument>()
  for (const [path, doc] of dashboards) {
    nextDashboards.set(path, rewriteColumnRefs(doc, fileId, changes))
  }

  return {
    dataset: { ...dataset, columns: nextColumns },
    dashboards: nextDashboards,
    changes,
  }
}
