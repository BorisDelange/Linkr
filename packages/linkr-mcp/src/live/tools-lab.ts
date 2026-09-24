/** Datasets (the lab's wide tables) and dashboards built on them. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import type { DashboardWidget } from '@/types'
import { formatRows } from './cohorts.js'
import { bilingual, buildFilter, placeWidget, resolveColumns, type DatasetColumn, type Layout } from './lab.js'
import { findPlugin, listPlugins, pluginDoc, pluginSummary } from './plugins.js'
import {
  DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, text, type Server,
} from './shared.js'

const LAYOUT_SCHEMA = {
  type: 'object',
  description: 'Position on the 48-column grid: x 0–47, w in columns (24 = half width, 48 = full), y and h in 20px rows (h 12 ≈ 240px).',
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
} as const

async function datasetColumns(projectUid: string, path: string): Promise<DatasetColumn[]> {
  const meta = await api.getDatasetMeta(projectUid, path)
  return (meta.columns ?? []).map((c) => ({ id: c.id, name: c.name, type: c.type }))
}

/** The dashboard a tab belongs to, and that dashboard's project. */
async function tabContext(tabId: string) {
  const tab = await api.getTab(tabId)
  const dashboard = await api.getDashboard(tab.dashboardId)
  return { tab, dashboard }
}

function describeWidget(w: DashboardWidget): string {
  const source = w.source.type === 'plugin'
    ? `plugin ${w.source.pluginId}, config ${JSON.stringify(w.source.config)}`
    : `inline ${w.source.language}`
  const l = w.layout
  return `    widget "${loc(w.name)}" — widget_id: ${w.id} · dataset: ${w.datasetFileId ?? '(none)'} · `
    + `layout x${l.x} y${l.y} w${l.w} h${l.h} · ${source}`
}

export function registerLabTools(server: Server): void {
  // --- Datasets --------------------------------------------------------------

  server.registerTool('list_datasets', {
    description:
      'List a project\'s datasets: wide tables (one row per patient, stay…) in the project\'s lab, which '
      + 'dashboards and analyses read. A dataset is addressed by its path (e.g. "cohort/adults.parquet").',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object', properties: { project_uid: { type: 'string' } }, required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => {
    const nodes = (await api.listDatasets(project_uid)).filter((n) => n.type === 'file')
    if (nodes.length === 0) return text('No dataset in this project.')
    return text(nodes.map((n) => `- ${n.path}`).join('\n'))
  }))

  server.registerTool('describe_dataset', {
    description:
      'A dataset\'s columns (id, name, type) and row count. Widget configs reference columns by id '
      + '(col_…). With `stats`, adds per-column summaries (min/max/mean or top categories) — aggregates only.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; stats?: boolean }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        path: { type: 'string' },
        stats: { type: 'boolean', description: 'Include per-column summaries (slower on wide tables).' },
      },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path, stats }) => {
    const meta = await api.getDatasetMeta(project_uid, path)
    const out = [`${meta.path} — ${meta.rowCount ?? '?'} rows`]
    for (const c of meta.columns ?? []) {
      let line = `  ${c.id} · "${c.name}" · ${c.type}${c.label ? ` · ${c.label}` : ''}`
      if (stats) {
        const s = await api.getColumnStats(project_uid, path, c.id).catch(() => null)
        if (s) line += ` · ${JSON.stringify(s).slice(0, 300)}`
      }
      out.push(line)
    }
    return text(out.join('\n'))
  }))

  server.registerTool('preview_dataset', {
    description:
      'The first rows of a dataset. These are row-level (often patient-level) data: prefer describe_dataset '
      + 'with stats, and only preview when the values themselves are needed.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; rows?: number }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        path: { type: 'string' },
        rows: { type: 'number', description: 'Default 10, max 100.' },
      },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path, rows }) => {
    const n = Math.min(rows ?? 10, 100)
    const page = await api.queryDatasetRows(project_uid, path, n)
    return text(`${page.total} rows in total.\n${formatRows(page.rows, n)}`)
  }))

  server.registerTool('create_dataset_from_query', {
    description:
      'Build a dataset from a SQL query on one of the project\'s databases (DuckDB dialect): the full result '
      + 'is written server-side as a Parquet dataset, with no row cap, and never passes through this '
      + 'conversation. The usual way to turn a cohort into a table for dashboards: select one row per '
      + 'patient/stay with the columns needed (see preview_cohort_sql for the cohort\'s own SQL).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      project_uid: string; database_id: string; path: string; sql: string; replace?: boolean
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        database_id: { type: 'string' },
        path: { type: 'string', description: 'Dataset path, e.g. "mortality/adults" (.parquet is added).' },
        sql: { type: 'string', description: 'A read-only SELECT.' },
        replace: { type: 'boolean', description: 'Overwrite an existing dataset at this path. Default false.' },
      },
      required: ['project_uid', 'database_id', 'path', 'sql'],
    }),
  }, guard(async ({ project_uid, database_id, path, sql, replace }) => {
    const node = await api.datasetFromQuery({
      projectUid: project_uid, path, dataSourceId: database_id, sql, replace: replace ?? false,
    })
    const cols = (node.columns ?? []).map((c) => `${c.id} (${c.type})`).join(', ')
    return text(`Dataset ${node.path}: ${node.rowCount ?? '?'} rows.\nColumns: ${cols}`)
  }))

  // --- Plugins ---------------------------------------------------------------

  server.registerTool('list_plugins', {
    description:
      'The widget types a dashboard can hold (charts, tables, statistics…), one line each. Then '
      + 'describe_plugin for the config fields of the one you pick.',
    annotations: READ,
    inputSchema: fromJsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
  }, guard(async () => text(listPlugins().map(pluginSummary).join('\n'))))

  server.registerTool('describe_plugin', {
    description: 'The config fields of one widget plugin: types, allowed values, which column kind each expects.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ plugin_id: string }>({
      type: 'object', properties: { plugin_id: { type: 'string' } }, required: ['plugin_id'],
    }),
  }, guard(async ({ plugin_id }) => {
    const manifest = findPlugin(plugin_id)
    if (!manifest) return failure(`Unknown plugin "${plugin_id}". See list_plugins.`)
    return text(pluginDoc(manifest))
  }))

  // --- Dashboards ------------------------------------------------------------

  server.registerTool('list_dashboards', {
    description: 'A project\'s dashboards. A dashboard has tabs; a tab holds widgets laid out on a grid.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object', properties: { project_uid: { type: 'string' } }, required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => {
    const dashboards = await api.listDashboards(project_uid)
    if (dashboards.length === 0) return text('No dashboard in this project.')
    return text(dashboards.map((d) => `- "${loc(d.name)}" — dashboard_id: ${d.id}`).join('\n'))
  }))

  server.registerTool('describe_dashboard', {
    description: 'A dashboard\'s tabs and widgets with their ids, datasets, layouts and configs. Read before editing.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ dashboard_id: string }>({
      type: 'object', properties: { dashboard_id: { type: 'string' } }, required: ['dashboard_id'],
    }),
  }, guard(async ({ dashboard_id }) => {
    const dashboard = await api.getDashboard(dashboard_id)
    const tabs = (await api.listTabs(dashboard_id)).sort((a, b) => a.displayOrder - b.displayOrder)
    const out = [`Dashboard "${loc(dashboard.name)}" (dashboard_id ${dashboard.id}, project ${dashboard.projectUid})`]
    if (dashboard.defaultDatasetFileId) out.push(`Default dataset: ${dashboard.defaultDatasetFileId}`)
    for (const tab of tabs) {
      out.push(`  tab "${loc(tab.name)}" — tab_id: ${tab.id}${tab.parentTabId ? ` (sub-tab of ${tab.parentTabId})` : ''}`)
      for (const w of await api.listWidgets(tab.id)) out.push(describeWidget(w))
    }
    if (tabs.length === 0) out.push('  (no tab)')
    for (const f of dashboard.filterConfig ?? []) {
      const scope = f.scope?.type === 'tabs' ? ` on tabs ${f.scope.tabIds.join(', ')}` : ''
      out.push(`  filter ${f.columnName} (${f.type}, ${f.inputType}) on ${f.datasetFileId}${scope} — filter_id: ${f.id}`)
    }
    return text(out.join('\n'))
  }))

  server.registerTool('create_dashboard', {
    description: 'Create a dashboard in a project, with a first tab. Returns both ids.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; name: string; dataset_path?: string; first_tab?: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        name: { type: 'string' },
        dataset_path: { type: 'string', description: 'Default dataset for its widgets.' },
        first_tab: { type: 'string', description: 'Name of the first tab. Default "Overview".' },
      },
      required: ['project_uid', 'name'],
    }),
  }, guard(async ({ project_uid, name, dataset_path, first_tab }) => {
    const dashboard = await api.createDashboard({
      id: randomUUID(), projectUid: project_uid, name: bilingual(name), gridV: 2,
      ...(dataset_path ? { defaultDatasetFileId: dataset_path } : {}),
    })
    const tab = await api.createTab({
      id: randomUUID(), dashboardId: dashboard.id, name: bilingual(first_tab ?? 'Overview'), displayOrder: 0,
    })
    return text(`Created dashboard "${name}" — dashboard_id: ${dashboard.id}, first tab_id: ${tab.id}`)
  }))

  server.registerTool('add_tab', {
    description: 'Add a tab to a dashboard (or a sub-tab under another tab).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ dashboard_id: string; name: string; parent_tab_id?: string }>({
      type: 'object',
      properties: { dashboard_id: { type: 'string' }, name: { type: 'string' }, parent_tab_id: { type: 'string' } },
      required: ['dashboard_id', 'name'],
    }),
  }, guard(async ({ dashboard_id, name, parent_tab_id }) => {
    const tabs = await api.listTabs(dashboard_id)
    const tab = await api.createTab({
      id: randomUUID(), dashboardId: dashboard_id, name: bilingual(name),
      displayOrder: tabs.reduce((m, t) => Math.max(m, t.displayOrder + 1), 0),
      ...(parent_tab_id ? { parentTabId: parent_tab_id } : {}),
    })
    return text(`Added tab "${name}" — tab_id: ${tab.id}`)
  }))

  server.registerTool('rename_tab', {
    description: 'Rename a dashboard tab.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ tab_id: string; name: string }>({
      type: 'object', properties: { tab_id: { type: 'string' }, name: { type: 'string' } }, required: ['tab_id', 'name'],
    }),
  }, guard(async ({ tab_id, name }) => {
    await api.updateTab(tab_id, { name: bilingual(name) })
    return text(`Renamed tab ${tab_id} to "${name}".`)
  }))

  server.registerTool('add_widget', {
    description:
      'Add a widget to a dashboard tab: a plugin (list_plugins / describe_plugin) reading a dataset '
      + '(list_datasets / describe_dataset). Columns in the config may be given by name or id; unknown '
      + 'columns or fields are refused. Without a layout the widget goes below the others, half width.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      tab_id: string; name: string; plugin_id: string; dataset_path?: string; config: Record<string, unknown>
      layout?: Partial<Layout>
    }>({
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        name: { type: 'string', description: 'Widget title.' },
        plugin_id: { type: 'string', description: 'e.g. linkr-analysis-plot-builder (or "plot-builder").' },
        dataset_path: { type: 'string', description: 'Default: the dashboard\'s default dataset.' },
        config: { type: 'object', description: 'Plugin config, e.g. {"plotType": "histogram", "xColumn": "age"}.' },
        layout: LAYOUT_SCHEMA,
      },
      required: ['tab_id', 'name', 'plugin_id', 'config'],
    }),
  }, guard(async ({ tab_id, name, plugin_id, dataset_path, config, layout }) => {
    const manifest = findPlugin(plugin_id)
    if (!manifest) return failure(`Unknown plugin "${plugin_id}". See list_plugins.`)
    const { dashboard } = await tabContext(tab_id)
    const dataset = dataset_path ?? dashboard.defaultDatasetFileId
    if (!dataset) return failure('No dataset: give dataset_path (the dashboard has no default dataset).')
    const resolved = resolveColumns(config, manifest, await datasetColumns(dashboard.projectUid, dataset))
    if (resolved.errors.length) return failure(`Not added:\n- ${resolved.errors.join('\n- ')}`)
    const existing = (await api.listWidgets(tab_id)).map((w) => w.layout)
    const widget = await api.createWidget({
      id: randomUUID(), tabId: tab_id, name: bilingual(name), datasetFileId: dataset,
      layout: placeWidget(existing, layout),
      source: { type: 'plugin', pluginId: manifest.id, config: resolved.config, pluginVersion: manifest.version },
    })
    return text(`Added widget "${name}" — widget_id: ${widget.id}\n${describeWidget(widget)}`)
  }))

  server.registerTool('update_widget', {
    description:
      'Change a widget: its title, dataset, layout, or config fields (merged into the current config; set a '
      + 'field to null to clear it). Columns may be given by name or id.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      widget_id: string; name?: string; dataset_path?: string; config?: Record<string, unknown>; layout?: Partial<Layout>
    }>({
      type: 'object',
      properties: {
        widget_id: { type: 'string' },
        name: { type: 'string' },
        dataset_path: { type: 'string' },
        config: { type: 'object', description: 'Fields to set.' },
        layout: LAYOUT_SCHEMA,
      },
      required: ['widget_id'],
    }),
  }, guard(async ({ widget_id, name, dataset_path, config, layout }) => {
    const widget = await api.getWidget(widget_id)
    const changes: Record<string, unknown> = {}
    if (name !== undefined) changes.name = bilingual(name)
    if (dataset_path !== undefined) changes.datasetFileId = dataset_path
    if (layout) changes.layout = placeWidget([], { ...widget.layout, ...layout })
    if (config) {
      if (widget.source.type !== 'plugin') return failure('This widget is not a plugin widget; its config cannot be edited here.')
      const manifest = findPlugin(widget.source.pluginId)
      if (!manifest) return failure(`The widget's plugin ${widget.source.pluginId} is not a known plugin.`)
      const { dashboard } = await tabContext(widget.tabId)
      const dataset = dataset_path ?? widget.datasetFileId
      const merged = Object.fromEntries(
        Object.entries({ ...widget.source.config, ...config }).filter(([, v]) => v !== null),
      )
      const columns = dataset ? await datasetColumns(dashboard.projectUid, dataset) : []
      const resolved = resolveColumns(merged, manifest, columns)
      if (resolved.errors.length) return failure(`Not updated:\n- ${resolved.errors.join('\n- ')}`)
      changes.source = { ...widget.source, config: resolved.config, pluginVersion: manifest.version }
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    const updated = await api.updateWidget(widget_id, changes)
    return text(`Updated.\n${describeWidget(updated)}`)
  }))

  server.registerTool('remove_widget', {
    description: 'Delete a widget. The user can undo it from Linkr\'s notifications.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ widget_id: string }>({
      type: 'object', properties: { widget_id: { type: 'string' } }, required: ['widget_id'],
    }),
  }, guard(async ({ widget_id }) => {
    await api.deleteWidget(widget_id)
    return text(`Deleted widget ${widget_id}.`)
  }))

  server.registerTool('remove_tab', {
    description: 'Delete a dashboard tab and all its widgets. The user can undo it from Linkr\'s notifications.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ tab_id: string }>({
      type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'],
    }),
  }, guard(async ({ tab_id }) => {
    await api.deleteTab(tab_id)
    return text(`Deleted tab ${tab_id}.`)
  }))

  server.registerTool('update_dashboard', {
    description: 'Rename a dashboard, change its description or its default dataset.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ dashboard_id: string; name?: string; description?: string; dataset_path?: string }>({
      type: 'object',
      properties: {
        dashboard_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        dataset_path: { type: 'string', description: 'New default dataset for widgets that do not name one.' },
      },
      required: ['dashboard_id'],
    }),
  }, guard(async ({ dashboard_id, name, description, dataset_path }) => {
    const changes: Record<string, unknown> = {}
    if (name !== undefined) changes.name = bilingual(name)
    if (description !== undefined) changes.description = bilingual(description)
    if (dataset_path !== undefined) changes.defaultDatasetFileId = dataset_path
    if (Object.keys(changes).length === 0) return failure('Nothing to change: give name, description or dataset_path.')
    const dashboard = await api.updateDashboard(dashboard_id, changes)
    return text(`Updated dashboard "${loc(dashboard.name)}".`)
  }))

  server.registerTool('delete_dashboard', {
    description: 'Delete a dashboard with all its tabs and widgets. Ask the user first; they can undo it from '
      + 'Linkr\'s notifications.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ dashboard_id: string }>({
      type: 'object', properties: { dashboard_id: { type: 'string' } }, required: ['dashboard_id'],
    }),
  }, guard(async ({ dashboard_id }) => {
    const dashboard = await api.getDashboard(dashboard_id)
    await api.deleteDashboard(dashboard_id)
    return text(`Deleted dashboard "${loc(dashboard.name)}".`)
  }))

  server.registerTool('add_dashboard_filter', {
    description: 'Add a filter to a dashboard\'s filter sidebar: one column of a dataset, which then filters every '
      + 'widget reading that dataset (and, by column name, the other datasets). Numbers and dates default to a '
      + 'range, other columns to a multi-select.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      dashboard_id: string; column: string; dataset_path?: string; input_type?: string; label?: string; tab_ids?: string[]
    }>({
      type: 'object',
      properties: {
        dashboard_id: { type: 'string' },
        column: { type: 'string', description: 'Column name or id.' },
        dataset_path: { type: 'string', description: 'Default: the dashboard\'s default dataset.' },
        input_type: {
          type: 'string',
          enum: ['multi-select', 'checkbox', 'single-select', 'range', 'double-range', 'slider'],
          description: 'range / double-range for numbers, range / slider for dates.',
        },
        label: { type: 'string', description: 'Shown instead of the column name.' },
        tab_ids: { type: 'array', items: { type: 'string' }, description: 'Limit the filter to these tabs. Default: all.' },
      },
      required: ['dashboard_id', 'column'],
    }),
  }, guard(async ({ dashboard_id, column, dataset_path, input_type, label, tab_ids }) => {
    const dashboard = await api.getDashboard(dashboard_id)
    const dataset = dataset_path ?? dashboard.defaultDatasetFileId
    if (!dataset) return failure('This dashboard has no default dataset: give dataset_path.')
    const built = buildFilter({
      id: randomUUID(), datasetPath: dataset, column,
      columns: await datasetColumns(dashboard.projectUid, dataset), inputType: input_type, label, tabIds: tab_ids,
    })
    if (!built.filter) return failure(built.error!)
    await api.updateDashboard(dashboard_id, { filterConfig: [...(dashboard.filterConfig ?? []), built.filter] })
    return text(`Added filter on ${built.filter.columnName} (${built.filter.inputType}) — filter_id: ${built.filter.id}`)
  }))

  server.registerTool('remove_dashboard_filter', {
    description: 'Remove one filter from a dashboard (filter ids: describe_dashboard).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ dashboard_id: string; filter_id: string }>({
      type: 'object',
      properties: { dashboard_id: { type: 'string' }, filter_id: { type: 'string' } },
      required: ['dashboard_id', 'filter_id'],
    }),
  }, guard(async ({ dashboard_id, filter_id }) => {
    const dashboard = await api.getDashboard(dashboard_id)
    const filters = dashboard.filterConfig ?? []
    if (!filters.some((f) => f.id === filter_id)) {
      return failure(`No filter ${filter_id} on this dashboard (filters: ${filters.map((f) => `${f.id} ${f.columnName}`).join(', ') || 'none'}).`)
    }
    await api.updateDashboard(dashboard_id, { filterConfig: filters.filter((f) => f.id !== filter_id) })
    return text(`Removed filter ${filter_id}.`)
  }))
}
