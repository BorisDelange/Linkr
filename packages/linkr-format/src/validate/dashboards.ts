/**
 * `dashboards/<slug>.json` — one file holding `{ dashboard, tabs, widgets }`.
 *
 * Two link styles are in the wild and BOTH are valid to the app, so both are
 * accepted here:
 *
 *   - **content keys** (current, git-friendly): tabs carry `key`/`parentKey`,
 *     widgets carry `key`/`tabKey`. Ids are re-derived on import, so a
 *     delete+reimport is byte-stable.
 *   - **uuids** (legacy): tabs carry `id`/`parentTabId`, widgets `id`/`tabId`.
 *
 * Mixing the two inside one file is what actually breaks, because the import
 * resolves links per record: a widget keyed by `tabKey` cannot find a tab that
 * only declares `id`, and it lands in no tab at all. So the style is detected
 * per file and a mixed file is reported.
 */
import { checkArray, checkLocalized, checkNumber, checkString, isObject, readLocalized } from '../check.js'
import type { IssueBag } from '../issue.js'
import { listHint } from '../issue.js'
import { filesIn, readJson, type EntityTree } from '../tree.js'
import type { DatasetIndex } from './datasets.js'

/** Column count of the dashboard grid. `gridV: 2` boards are 48 columns wide. */
const GRID_COLUMNS_V2 = 48
const GRID_COLUMNS_V1 = 12

export function validateDashboards(tree: EntityTree, bag: IssueBag, datasets: DatasetIndex): void {
  for (const path of filesIn(tree, 'dashboards', '.json')) {
    validateDashboardFile(tree, bag, datasets, path)
  }
}

function validateDashboardFile(
  tree: EntityTree,
  bag: IssueBag,
  datasets: DatasetIndex,
  path: string,
): void {
  const parsed = readJson(tree, path)
  if (!parsed.ok) {
    bag.error(path, '', 'invalid-json', `Cannot parse JSON: ${parsed.error}`)
    return
  }
  const doc = parsed.value
  if (!isObject(doc)) {
    bag.error(path, '', 'wrong-type', 'A dashboard file must be an object.')
    return
  }

  const dashboard = doc.dashboard
  if (!isObject(dashboard)) {
    bag.error(path, '/dashboard', 'missing-field', 'The `dashboard` object is required.')
    return
  }
  checkLocalized(bag, path, '/dashboard/name', dashboard.name, { required: true })

  const gridColumns = dashboard.gridV === 2 ? GRID_COLUMNS_V2 : GRID_COLUMNS_V1

  if (!checkArray(bag, path, '/tabs', doc.tabs, { required: true, label: '`tabs`' })) return
  if (!checkArray(bag, path, '/widgets', doc.widgets, { required: true, label: '`widgets`' })) return

  const tabs = validateTabs(bag, path, doc.tabs)
  validateWidgets(bag, path, doc.widgets, tabs, datasets, gridColumns)
  validateFilters(bag, path, dashboard.filterConfig, tabs, datasets)

  if (dashboard.defaultDatasetFileId != null) {
    checkDatasetRef(bag, path, '/dashboard/defaultDatasetFileId', dashboard.defaultDatasetFileId, datasets)
  }
}

interface TabIndex {
  /** Every tab's identity, whichever style the file uses. */
  refs: Set<string>
  names: Map<string, string>
  style: 'key' | 'id' | 'mixed' | 'none'
}

function validateTabs(bag: IssueBag, path: string, raw: unknown[]): TabIndex {
  const refs = new Set<string>()
  const names = new Map<string, string>()
  let keyed = 0
  let idd = 0

  raw.forEach((tab, i) => {
    const pointer = `/tabs/${i}`
    if (!isObject(tab)) {
      bag.error(path, pointer, 'wrong-type', 'Each tab must be an object.')
      return
    }
    checkLocalized(bag, path, `${pointer}/name`, tab.name, { required: true })

    const ref = typeof tab.key === 'string' ? tab.key : typeof tab.id === 'string' ? tab.id : null
    if (ref == null) {
      bag.error(path, pointer, 'missing-field', 'A tab needs a `key` (or a legacy `id`).')
      return
    }
    if (typeof tab.key === 'string') keyed++
    else idd++

    if (refs.has(ref)) {
      bag.error(path, `${pointer}/${typeof tab.key === 'string' ? 'key' : 'id'}`, 'duplicate-key',
        `Duplicate tab identifier "${ref}".`)
      return
    }
    refs.add(ref)
    names.set(ref, readLocalized(tab.name) || ref)
  })

  const style: TabIndex['style'] =
    keyed > 0 && idd > 0 ? 'mixed' : keyed > 0 ? 'key' : idd > 0 ? 'id' : 'none'

  if (style === 'mixed') {
    bag.error(path, '/tabs', 'legacy-format',
      'Tabs mix content keys and legacy ids in one file.',
      'use `key`/`parentKey` throughout, or `id`/`parentTabId` throughout')
  }

  // Parent links, once every tab is known.
  raw.forEach((tab, i) => {
    if (!isObject(tab)) return
    const parent = tab.parentKey ?? tab.parentTabId
    if (parent == null) return
    if (typeof parent !== 'string') {
      bag.error(path, `/tabs/${i}/parentKey`, 'wrong-type', 'A parent reference must be a string.')
      return
    }
    if (!refs.has(parent)) {
      bag.error(path, `/tabs/${i}/parentKey`, 'unknown-reference',
        `Parent tab "${parent}" does not exist in this dashboard.`,
        listHint('known tabs', [...refs]))
    }
  })

  return { refs, names, style }
}

function validateWidgets(
  bag: IssueBag,
  path: string,
  raw: unknown[],
  tabs: TabIndex,
  datasets: DatasetIndex,
  gridColumns: number,
): void {
  const seen = new Set<string>()

  raw.forEach((widget, i) => {
    const pointer = `/widgets/${i}`
    if (!isObject(widget)) {
      bag.error(path, pointer, 'wrong-type', 'Each widget must be an object.')
      return
    }
    checkLocalized(bag, path, `${pointer}/name`, widget.name, { required: true })

    const ref = typeof widget.key === 'string' ? widget.key : typeof widget.id === 'string' ? widget.id : null
    if (ref == null) {
      bag.error(path, pointer, 'missing-field', 'A widget needs a `key` (or a legacy `id`).')
    } else if (seen.has(ref)) {
      bag.error(path, pointer, 'duplicate-key', `Duplicate widget identifier "${ref}".`)
    } else {
      seen.add(ref)
    }

    // A widget with no reachable tab is invisible in the app — it imports and
    // then simply never renders, which is painful to diagnose from the UI.
    const tabRef = typeof widget.tabKey === 'string'
      ? widget.tabKey
      : typeof widget.tabId === 'string'
        ? widget.tabId
        : null
    if (tabRef == null) {
      bag.error(path, `${pointer}/tabKey`, 'missing-field', 'A widget must name its tab.')
    } else if (!tabs.refs.has(tabRef)) {
      bag.error(path, `${pointer}/tabKey`, 'orphan-record',
        `Widget is attached to unknown tab "${tabRef}"; it would not be visible.`,
        listHint('known tabs', [...tabs.refs]))
    }

    validateLayout(bag, path, `${pointer}/layout`, widget.layout, gridColumns)

    const datasetId = widget.datasetFileId
    let columns: Set<string> | null = null
    if (datasetId != null) {
      const info = checkDatasetRef(bag, path, `${pointer}/datasetFileId`, datasetId, datasets)
      columns = info ? info.columnIds : null
    }

    validateSource(bag, path, `${pointer}/source`, widget.source, columns, datasets)
  })
}

function validateLayout(
  bag: IssueBag,
  path: string,
  pointer: string,
  raw: unknown,
  gridColumns: number,
): void {
  if (raw == null) {
    bag.error(path, pointer, 'missing-field', 'A widget needs a layout.')
    return
  }
  if (!isObject(raw)) {
    bag.error(path, pointer, 'wrong-type', 'layout must be an object.')
    return
  }
  const x = checkNumber(bag, path, `${pointer}/x`, raw.x, { required: true, label: 'x', integer: true })
  checkNumber(bag, path, `${pointer}/y`, raw.y, { required: true, label: 'y', integer: true })
  const w = checkNumber(bag, path, `${pointer}/w`, raw.w, { required: true, label: 'w', integer: true })
  checkNumber(bag, path, `${pointer}/h`, raw.h, { required: true, label: 'h', integer: true })

  if (!x || !w) return
  const left = raw.x as number
  const width = raw.w as number
  if (width < 1) {
    bag.error(path, `${pointer}/w`, 'layout-out-of-grid', 'Width must be at least 1.')
  }
  if (left < 0) {
    bag.error(path, `${pointer}/x`, 'layout-out-of-grid', 'x cannot be negative.')
  }
  if (left + width > gridColumns) {
    bag.error(path, pointer, 'layout-out-of-grid',
      `Widget spans past the grid: x=${left} + w=${width} > ${gridColumns}.`,
      `the grid is ${gridColumns} columns wide`)
  }
}

/**
 * A widget's plugin config.
 *
 * Config **fields** are not checked against the plugin manifest here — that
 * derivation is currently validated against a single manifest (see
 * ai-agents-plan.md §8) and would produce false positives on the others. What is
 * checked is the part that silently breaks a dashboard: a config value naming a
 * column that does not exist in the widget's dataset renders a blank widget with
 * an empty column picker and no error anywhere.
 */
function validateSource(
  bag: IssueBag,
  path: string,
  pointer: string,
  raw: unknown,
  columns: Set<string> | null,
  datasets: DatasetIndex,
): void {
  if (raw == null) {
    bag.error(path, pointer, 'missing-field', 'A widget needs a source.')
    return
  }
  if (!isObject(raw)) {
    bag.error(path, pointer, 'wrong-type', 'source must be an object.')
    return
  }
  // `type` is the field DashboardWidgetSource declares and every real export
  // writes; `kind` appears in older hand-written trees. Read both, flag the
  // latter — the app keys off `type`, so a `kind`-only widget renders nothing.
  const type = raw.type ?? raw.kind
  if (raw.type == null && raw.kind != null) {
    bag.warn(path, `${pointer}/kind`, 'legacy-format',
      'The widget source uses `kind`; the field is `type`.',
      'rename `kind` to `type`')
  }

  if (type === 'plugin') {
    checkString(bag, path, `${pointer}/pluginId`, raw.pluginId, {
      required: true,
      label: 'pluginId',
    })
  } else if (type !== 'inline') {
    bag.error(path, `${pointer}/type`, 'wrong-type', `Unknown widget source type "${String(type)}".`,
      'allowed: plugin, inline')
    return
  }

  const config = raw.config
  if (config != null && !isObject(config)) {
    bag.error(path, `${pointer}/config`, 'wrong-type', 'config must be an object.')
    return
  }
  if (!isObject(config) || columns == null) return

  for (const [field, value] of Object.entries(config)) {
    for (const [candidate, valuePointer] of columnCandidates(field, value)) {
      if (columns.has(candidate)) continue
      // Only flag values that *look* like a column id: a config holds plenty of
      // free strings (titles, labels, icons) that must not be second-guessed.
      if (!/^col[_-]/.test(candidate)) continue
      const known = datasets.allColumnIds.has(candidate)
      bag.error(path, `${pointer}/config${valuePointer}`, 'unknown-column',
        known
          ? `Column "${candidate}" belongs to another dataset.`
          : `Column "${candidate}" does not exist.`,
        listHint('columns in this dataset', [...columns]))
    }
  }
}

/** Config entries that name a column, as `[value, pointerSuffix]` pairs. */
function columnCandidates(field: string, value: unknown): [string, string][] {
  if (typeof value === 'string') return [[value, `/${field}`]]
  if (Array.isArray(value)) {
    return value
      .map((v, i): [string, string] | null => (typeof v === 'string' ? [v, `/${field}/${i}`] : null))
      .filter((v): v is [string, string] => v != null)
  }
  return []
}

function validateFilters(
  bag: IssueBag,
  path: string,
  raw: unknown,
  tabs: TabIndex,
  datasets: DatasetIndex,
): void {
  if (raw == null) return
  if (!checkArray(bag, path, '/dashboard/filterConfig', raw, { label: 'filterConfig' })) return

  raw.forEach((filter, i) => {
    const pointer = `/dashboard/filterConfig/${i}`
    if (!isObject(filter)) {
      bag.error(path, pointer, 'wrong-type', 'Each filter must be an object.')
      return
    }
    const info = checkDatasetRef(bag, path, `${pointer}/datasetFileId`, filter.datasetFileId, datasets)

    // A filter pointing at a missing column silently controls nothing.
    if (info && typeof filter.columnId === 'string' && !info.columnIds.has(filter.columnId)) {
      bag.error(path, `${pointer}/columnId`, 'unknown-column',
        `Filter column "${filter.columnId}" does not exist in dataset "${info.name}".`,
        listHint('columns', [...info.columnIds]))
    }

    const scope = filter.scope
    if (!isObject(scope)) return
    const refs = scope.tabKeys ?? scope.widgetKeys ?? scope.tabIds ?? scope.widgetIds
    if (!Array.isArray(refs)) return
    if (scope.type !== 'tabs') return
    refs.forEach((ref, j) => {
      if (typeof ref === 'string' && !tabs.refs.has(ref)) {
        bag.error(path, `${pointer}/scope/tabKeys/${j}`, 'unknown-reference',
          `Filter is scoped to unknown tab "${ref}".`,
          listHint('known tabs', [...tabs.refs]))
      }
    })
  })
}

function checkDatasetRef(
  bag: IssueBag,
  path: string,
  pointer: string,
  value: unknown,
  datasets: DatasetIndex,
) {
  if (typeof value !== 'string') {
    if (value != null) bag.error(path, pointer, 'wrong-type', 'A dataset reference must be a string.')
    return null
  }
  const info = datasets.datasets.get(value)
  if (!info) {
    bag.error(path, pointer, 'unknown-reference', `Dataset "${value}" does not exist.`,
      listHint('known datasets', [...datasets.datasets.keys()]))
    return null
  }
  return info
}
