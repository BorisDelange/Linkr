/** Patient data boards: their tabs and widgets, checked against the widget manifests. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { copyName } from '@/lib/copy-name'
import { buildPointer } from '@/lib/import-identity'
import type { LocalizedString, PatientDashboard, PatientDashboardTab, PatientDashboardWidget } from '@/types'
import type { PluginManifest } from '@/types/plugin'
import { bilingual, layoutSchema, placeWidget, type Layout } from './lab.js'
import {
  checkPatientConfig, listPatientPlugins, patientWidgetSize, reorderIds, resolveTimelineMapping, type PluginLanguage,
} from './lab-extra.js'
import { pluginDoc, pluginSummary } from './plugins.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, text, type Server } from './shared.js'
import {
  columnsOf, ds, isBuiltinRow, manifestOf, me, plugins, q, resolvePlugin, scriptLanguage, workspaceOfProject,
} from './lab-rest.js'

const LAYOUT_SCHEMA = layoutSchema('rows')

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

async function boardProject(board: PatientDashboard): Promise<string> {
  if (!board.projectUid) throw new Error('This board belongs to a database cohort, not a project; it is edited from that cohort in Linkr.')
  return board.projectUid
}

export function registerPatientBoardTools(server: Server): void {
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
}
