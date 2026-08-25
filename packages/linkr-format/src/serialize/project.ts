/**
 * Turn a project spec into the files of an export tree.
 *
 * Layout knowledge lives here and nowhere else — which file holds what, how
 * `_tree.json` is keyed, how ids are derived. The *sink* (disk, ZIP, store) is
 * the caller's business: this returns `{ path, content }` pairs and performs no
 * I/O, so the MCP server writing to disk and a future in-app export writing to
 * JSZip share one definition of the layout rather than drifting apart the way
 * `build_zip.py` and `entity-io.ts` did.
 */
import { buildColumnIds, slugify } from '../ids.js'

export interface WriteFile {
  path: string
  content: string
}

export interface LocalizedInput {
  en?: string
  fr?: string
  [lang: string]: string | undefined
}

export interface DatasetSpec {
  /** Dataset name; the file it produces is `datasets/<name>/<name>.csv`. */
  name: string
  /** Raw CSV text, header included. Columns are derived from that header. */
  csv: string
  /** Optional per-column type hints, keyed by column name. */
  types?: Record<string, ColumnType>
}

export type ColumnType = 'string' | 'number' | 'date' | 'boolean'

export interface WidgetSpec {
  name: LocalizedInput
  /** Tab this widget belongs to, by tab name. */
  tab: string
  /** Dataset name, as given in `datasets`. */
  dataset?: string
  /** Plugin id. Omit only for an `inline` widget, which carries `code` instead. */
  pluginId?: string
  /** Plugin config. Column values may be given as NAMES; they are resolved to ids. */
  config?: Record<string, unknown>
  /** Inline code widget: the source runs in the dashboard instead of a plugin. */
  code?: string
  language?: 'python' | 'r'
  /**
   * Grid placement. Omit to let widgets flow left-to-right and wrap, which is
   * what a spec author usually wants: hand-placing every widget on a 48-column
   * grid is tedious and easy to get wrong (overlaps render as stacked cards).
   */
  layout?: { x: number; y: number; w: number; h: number }
  /** Width/height when the layout is auto-flowed. */
  w?: number
  h?: number
}

export type FilterInputType = 'multi-select' | 'select' | 'range'

export interface FilterSpec {
  /** Dataset name, as given in `datasets`. */
  dataset: string
  /** Column NAME; resolved to its id. */
  column: string
  label?: string
  /** Derived from the column type when omitted. */
  inputType?: FilterInputType
}

export interface TabSpec {
  name: LocalizedInput
  /** Parent tab name, for one level of nesting. */
  parent?: string
}

export interface DashboardSpec {
  name: LocalizedInput
  tabs: TabSpec[]
  widgets?: WidgetSpec[]
  /** Dashboard-level filters, shown in the sidebar. */
  filters?: FilterSpec[]
  showWidgetTitles?: boolean
  /** 48-column grid (`gridV: 2`) unless explicitly set to 1. */
  gridV?: 1 | 2
}

export interface ScriptSpec {
  /** Path under `scripts/`, e.g. `01_extract.sql`. */
  path: string
  content: string
}

export interface ProjectSpec {
  projectId: string
  name: LocalizedInput
  description?: LocalizedInput
  appVersion: string
  datasets?: DatasetSpec[]
  dashboards?: DashboardSpec[]
  scripts?: ScriptSpec[]
  readme?: LocalizedInput
  license?: { id: string; name?: string }
  createdBy?: string
  createdAt?: string
}

/** Language a script file is written in, from its extension. */
const SCRIPT_LANGUAGES: Record<string, string> = {
  py: 'python',
  r: 'r',
  sql: 'sql',
  md: 'markdown',
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Header fields of a CSV, honouring quotes. */
function csvHeader(csv: string): string[] {
  const line = csv.split('\n', 1)[0]?.replace(/\r$/, '') ?? ''
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(field)
      field = ''
    } else field += ch
  }
  out.push(field)
  return out.map((f) => f.trim())
}

/** Rows of a CSV, for inferring column types. */
function csvRowCount(csv: string): number {
  return csv.split('\n').filter((l) => l.trim().length > 0).length - 1
}

/**
 * Infer a column type from its values.
 *
 * Only used when the spec gives no hint. Deliberately conservative: a column
 * that is not unambiguously numeric, boolean or a date stays a string, because
 * a wrong type silently changes how a widget aggregates it.
 */
function inferType(csv: string, index: number): ColumnType {
  const lines = csv.split('\n').slice(1).filter((l) => l.trim().length > 0).slice(0, 50)
  const values = lines
    .map((line) => line.split(',')[index]?.trim())
    .filter((v): v is string => v != null && v !== '')
  if (values.length === 0) return 'string'

  if (values.every((v) => v === '0' || v === '1' || /^(true|false)$/i.test(v))) return 'boolean'
  if (values.every((v) => Number.isFinite(Number(v)))) return 'number'
  if (values.every((v) => /^\d{4}-\d{2}-\d{2}([ T]|$)/.test(v))) return 'date'
  return 'string'
}

function localized(value: LocalizedInput): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => typeof v === 'string' && v.length > 0),
  ) as Record<string, string>
}

/**
 * Serialize a whole project spec.
 *
 * Deterministic: the same spec produces byte-identical files, so re-running it
 * over a git-tracked tree shows a diff only where the content actually changed.
 */
export function serializeProject(spec: ProjectSpec): WriteFile[] {
  const files: WriteFile[] = []

  files.push({
    path: 'project.json',
    content: json({
      projectId: spec.projectId,
      name: localized(spec.name),
      ...(spec.description ? { description: localized(spec.description) } : {}),
      config: {},
      status: 'active',
      ...(spec.createdBy ? { createdBy: spec.createdBy } : {}),
      ...(spec.createdAt ? { createdAt: spec.createdAt } : {}),
      ...(spec.license ? { license: spec.license } : {}),
      appVersion: spec.appVersion,
    }),
  })

  if (spec.readme) {
    for (const [lang, text] of Object.entries(localized(spec.readme))) {
      // README.md holds the primary language; others carry a suffix.
      files.push({ path: lang === 'en' ? 'README.md' : `README.${lang}.md`, content: text })
    }
  }

  const columnsByDataset = new Map<string, DatasetColumns>()
  if (spec.datasets?.length) {
    files.push(...serializeDatasets(spec.datasets, columnsByDataset))
  }
  if (spec.dashboards?.length) {
    files.push(...serializeDashboards(spec.dashboards, columnsByDataset))
  }
  if (spec.scripts?.length) {
    files.push(...serializeScripts(spec.scripts))
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Column ids and types of one dataset, keyed by column name. */
interface DatasetColumns {
  idByName: Map<string, string>
  typeById: Map<string, ColumnType>
}

function serializeDatasets(
  datasets: DatasetSpec[],
  columnsByDataset: Map<string, DatasetColumns>,
): WriteFile[] {
  const files: WriteFile[] = []
  const entries = datasets.map((dataset) => {
    const header = csvHeader(dataset.csv)
    const ids = buildColumnIds(header)
    const idByName = new Map<string, string>()
    const typeById = new Map<string, ColumnType>()
    const columns = header.map((name, i) => {
      const type = dataset.types?.[name] ?? inferType(dataset.csv, i)
      idByName.set(name, ids[i])
      typeById.set(ids[i], type)
      return { id: ids[i], name, type, order: i }
    })
    // Widgets address a dataset by its file id, which is `<name>.csv`.
    const id = `${dataset.name}.csv`
    const resolved: DatasetColumns = { idByName, typeById }
    columnsByDataset.set(dataset.name, resolved)
    columnsByDataset.set(id, resolved)

    files.push({ path: `datasets/${dataset.name}/${id}`, content: dataset.csv })

    return {
      id,
      name: id,
      type: 'file' as const,
      parentId: null,
      path: `${dataset.name}/${id}`,
      columns,
      rowCount: csvRowCount(dataset.csv),
    }
  })

  files.push({ path: 'datasets/_tree.json', content: json(entries) })
  return files
}

const GRID_COLUMNS = 48
const DEFAULT_WIDGET = { w: 24, h: 16 }

/**
 * Left-to-right cursor that wraps at the grid edge, one per tab.
 *
 * Hand-placing every widget on a 48-column grid is tedious and easy to get
 * wrong — overlapping widgets render as stacked cards with no error — so a
 * layout is optional in the spec and flows by default.
 */
function createFlow() {
  let x = 0
  let y = 0
  let rowHeight = 0
  return (w: number, h: number) => {
    const width = Math.min(Math.max(w, 1), GRID_COLUMNS)
    if (x + width > GRID_COLUMNS) {
      x = 0
      y += rowHeight
      rowHeight = 0
    }
    const layout = { x, y, w: width, h: Math.max(h, 1) }
    x += width
    rowHeight = Math.max(rowHeight, layout.h)
    return layout
  }
}

function serializeDashboards(
  dashboards: DashboardSpec[],
  columnsByDataset: Map<string, DatasetColumns>,
): WriteFile[] {
  return dashboards.map((dashboard) => {
    const dashKey = slugify(dashboard.name.en || Object.values(dashboard.name)[0] || 'dashboard')

    // Content keys, not uuids: ids are re-derived on import, so a delete+reimport
    // is byte-stable and the git diff stays clean. Parents before children, so a
    // sub-tab's parent key is already known.
    const tabKeys = new Map<string, string>()
    const ordered = [...dashboard.tabs].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0))
    for (const tab of ordered) {
      const label = tab.name.en || Object.values(tab.name)[0] || ''
      const parentKey = tab.parent ? tabKeys.get(tab.parent) : null
      tabKeys.set(label, `${parentKey ?? dashKey}/${slugify(label)}`)
    }

    const tabs = dashboard.tabs.map((tab, i) => {
      const label = tab.name.en || Object.values(tab.name)[0] || ''
      return {
        name: localized(tab.name),
        description: null,
        displayOrder: i,
        key: tabKeys.get(label)!,
        parentKey: tab.parent ? tabKeys.get(tab.parent) ?? null : null,
      }
    })

    // One cursor per tab: widgets flow within their own tab, not across tabs.
    const flows = new Map<string, ReturnType<typeof createFlow>>()
    const widgets = (dashboard.widgets ?? []).map((widget) => {
      const label = widget.name.en || Object.values(widget.name)[0] || ''
      const tabKey = tabKeys.get(widget.tab) ?? ''
      const columns = widget.dataset ? columnsByDataset.get(widget.dataset) : undefined

      if (!flows.has(tabKey)) flows.set(tabKey, createFlow())
      const layout = widget.layout
        ?? flows.get(tabKey)!(widget.w ?? DEFAULT_WIDGET.w, widget.h ?? DEFAULT_WIDGET.h)

      const source = widget.code != null
        ? {
          type: 'inline',
          language: widget.language ?? 'python',
          code: widget.code,
          config: resolveColumns(widget.config ?? {}, columns),
        }
        : {
          type: 'plugin',
          pluginId: widget.pluginId,
          config: resolveColumns(widget.config ?? {}, columns),
        }

      return {
        name: localized(widget.name),
        description: null,
        ...(widget.dataset ? { datasetFileId: `${widget.dataset}.csv` } : {}),
        layout,
        source,
        key: `${tabKey}/${slugify(label)}@${layout.y},${layout.x}`,
        tabKey,
      }
    })

    return {
      path: `dashboards/${dashKey}.json`,
      content: json({
        dashboard: {
          name: localized(dashboard.name),
          description: null,
          filterConfig: serializeFilters(dashboard.filters ?? [], columnsByDataset),
          ...(dashboard.showWidgetTitles != null
            ? { showWidgetTitles: dashboard.showWidgetTitles }
            : {}),
          gridV: dashboard.gridV ?? 2,
        },
        tabs: tabs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
        widgets: widgets.sort((a, b) =>
          a.tabKey < b.tabKey ? -1 : a.tabKey > b.tabKey ? 1 : a.key < b.key ? -1 : 1),
      }),
    }
  })
}

/**
 * Rewrite config values that name a column into column ids.
 *
 * The config layer keys columns by id (`col_age`); a spec author writes the name
 * (`age`), because that is what they see in the data. Left unresolved, the
 * widget renders blank with an empty column picker and no error — the same
 * failure the in-app copilot hits, fixed the same way.
 */
function resolveColumns(
  config: Record<string, unknown>,
  columns: DatasetColumns | undefined,
): Record<string, unknown> {
  const byName = columns?.idByName
  if (!byName?.size) return config
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && byName.has(value)) out[key] = byName.get(value)
    else if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === 'string' && byName.has(v) ? byName.get(v) : v))
    } else out[key] = value
  }
  return out
}

/**
 * Filter type from the column type, unless the spec says otherwise.
 *
 * A numeric or date column gets a range; anything else a multi-select. Getting
 * this wrong is not cosmetic — a range control over a categorical column offers
 * no usable values.
 */
function filterTypeOf(type: ColumnType | undefined): {
  type: string
  inputType: FilterInputType
} {
  if (type === 'number') return { type: 'numeric', inputType: 'range' }
  if (type === 'date') return { type: 'date', inputType: 'range' }
  return { type: 'categorical', inputType: 'multi-select' }
}

function serializeFilters(
  filters: FilterSpec[],
  columnsByDataset: Map<string, DatasetColumns>,
): Record<string, unknown>[] {
  return filters.map((filter) => {
    const columns = columnsByDataset.get(filter.dataset)
    const columnId = columns?.idByName.get(filter.column) ?? filter.column
    const derived = filterTypeOf(columns?.typeById.get(columnId))
    return {
      datasetFileId: `${filter.dataset}.csv`,
      columnId,
      columnName: filter.column,
      type: derived.type,
      inputType: filter.inputType ?? derived.inputType,
      ...(filter.label ? { label: filter.label } : {}),
    }
  })
}

function serializeScripts(scripts: ScriptSpec[]): WriteFile[] {
  const files: WriteFile[] = scripts.map((s) => ({
    path: `scripts/${s.path}`,
    content: s.content,
  }))
  files.push({
    path: 'scripts/_tree.json',
    content: json(
      scripts
        .map((s) => ({
          path: s.path,
          type: 'file',
          language: SCRIPT_LANGUAGES[s.path.split('.').pop()?.toLowerCase() ?? ''] ?? 'text',
          createdAt: '',
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
  })
  return files
}
