/** Lab dashboard actions beyond create and edit: copies, tab order, moving and copying widgets, display. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { copyName } from '@/lib/copy-name'
import type { DashboardWidget } from '@/types'
import { bilingual, frenchParam } from './lab.js'
import { reorderIds } from './lab-extra.js'
import { WRITE, api, failure, guard, loc, text, type Server } from './shared.js'
import { me } from './lab-rest.js'

/** The tab a widget may move or be copied to: on the widget's own dashboard (its
 *  dataset and filters are that project's), and a leaf — a tab with sub-tabs shows
 *  none of its own widgets. A readable refusal otherwise. */
async function widgetTargetTab(fromTabId: string, toTabId: string) {
  const [from, to] = await Promise.all([api.getTab(fromTabId), api.getTab(toTabId)])
  if (from.dashboardId !== to.dashboardId) return 'The target tab is on another dashboard.'
  if ((await api.listTabs(to.dashboardId)).some((t) => t.parentTabId === toTabId)) {
    return 'This tab holds sub-tabs: widgets go on one of its sub-tabs.'
  }
  return to
}

export function registerDashboardExtraTools(server: Server): void {
  server.registerTool('duplicate_dashboard', {
    description: 'Copy a lab dashboard with all its tabs, sub-tabs, widgets and filters, named "<name> (copy)".',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ dashboard_id: string }>({
      type: 'object', properties: { dashboard_id: { type: 'string' } }, required: ['dashboard_id'],
    }),
  }, guard(async ({ dashboard_id }) => {
    const source = await api.getDashboard(dashboard_id)
    const siblings = await api.listDashboards(source.projectUid)
    const tabs = await api.listTabs(dashboard_id)
    const tabIds = new Map(tabs.map((t) => [t.id, randomUUID()]))
    const { authored } = await me()
    const { id: _id, createdAt: _c, updatedAt: _u, createdById: _a, createdBy: _b, createdByDetails: _d, ...rest } = source
    // Filters scoped to tabs follow them onto the copies, or they would filter nothing there.
    const filterConfig = (source.filterConfig ?? []).map((f) => (
      f.scope?.type === 'tabs' ? { ...f, scope: { type: 'tabs' as const, tabIds: f.scope.tabIds.map((t) => tabIds.get(t) ?? t) } } : f
    ))
    const clone = await api.createDashboard({
      ...rest, id: randomUUID(), name: copyName(source.name, siblings.map((d) => d.name)), filterConfig, origin: 'user', ...authored,
    } as Record<string, unknown>)
    // Parents first: a sub-tab's POST fails if its parent tab does not exist yet.
    const ordered = [...tabs].sort((a, b) => Number(!!a.parentTabId) - Number(!!b.parentTabId))
    let widgets = 0
    for (const tab of ordered) {
      await api.createTab({
        ...tab, id: tabIds.get(tab.id), dashboardId: clone.id,
        parentTabId: tab.parentTabId ? tabIds.get(tab.parentTabId) ?? null : null,
      } as Record<string, unknown>)
    }
    for (const tab of ordered) {
      for (const w of await api.listWidgets(tab.id)) {
        await api.createWidget({ ...w, id: randomUUID(), tabId: tabIds.get(tab.id) } as Record<string, unknown>)
        widgets++
      }
    }
    return text(`Duplicated as "${loc(clone.name)}" — dashboard_id: ${clone.id} (${tabs.length} tab(s), ${widgets} widget(s)).`)
  }))

  server.registerTool('reorder_dashboard_tabs', {
    description: 'Reorder a lab dashboard\'s tabs, or the sub-tabs of one tab (parent_tab_id): the tabs named come '
      + 'first, in that order; their other siblings follow.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ dashboard_id: string; tab_ids: string[]; parent_tab_id?: string }>({
      type: 'object',
      properties: {
        dashboard_id: { type: 'string' }, tab_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        parent_tab_id: { type: 'string', description: 'Reorder this tab\'s sub-tabs. Default: the top-level tabs.' },
      },
      required: ['dashboard_id', 'tab_ids'],
    }),
  }, guard(async ({ dashboard_id, tab_ids, parent_tab_id }) => {
    const siblings = (await api.listTabs(dashboard_id))
      .filter((t) => (t.parentTabId ?? null) === (parent_tab_id ?? null))
      .sort((a, b) => a.displayOrder - b.displayOrder)
    const r = reorderIds(siblings.map((t) => t.id), tab_ids)
    if (!r.order) return failure(r.error!)
    for (const [i, id] of r.order.entries()) {
      if (siblings.find((t) => t.id === id)?.displayOrder !== i) await api.updateTab(id, { displayOrder: i })
    }
    return text(`Tabs reordered: ${r.order.map((id) => loc(siblings.find((t) => t.id === id)!.name)).join(', ')}.`)
  }))

  server.registerTool('move_widget', {
    description: 'Move a lab dashboard widget to another tab of the same dashboard; it lands below that tab\'s widgets.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ widget_id: string; tab_id: string }>({
      type: 'object', properties: { widget_id: { type: 'string' }, tab_id: { type: 'string' } }, required: ['widget_id', 'tab_id'],
    }),
  }, guard(async ({ widget_id, tab_id }) => {
    const w = await api.getWidget(widget_id)
    if (w.tabId === tab_id) return failure('The widget is already on this tab.')
    const to = await widgetTargetTab(w.tabId, tab_id)
    if (typeof to === 'string') return failure(to)
    const bottom = (await api.listWidgets(tab_id)).reduce((m, x) => Math.max(m, x.layout.y + x.layout.h), 0)
    await api.updateWidget(w.id, { tabId: tab_id, layout: { ...w.layout, x: 0, y: bottom } })
    return text(`Moved "${loc(w.name)}" to tab "${loc(to.name)}".`)
  }))

  server.registerTool('duplicate_widget', {
    description: 'Copy a lab dashboard widget, "(copy)" appended to its title, onto its own tab or another tab '
      + 'of the same dashboard.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ widget_id: string; tab_id?: string }>({
      type: 'object', properties: { widget_id: { type: 'string' }, tab_id: { type: 'string', description: 'Default: the same tab.' } },
      required: ['widget_id'],
    }),
  }, guard(async ({ widget_id, tab_id }) => {
    const w: DashboardWidget = await api.getWidget(widget_id)
    const target = tab_id ?? w.tabId
    if (target !== w.tabId) {
      const to = await widgetTargetTab(w.tabId, target)
      if (typeof to === 'string') return failure(to)
    }
    const siblings = await api.listWidgets(target)
    const bottom = siblings.reduce((m, x) => Math.max(m, x.layout.y + x.layout.h), 0)
    const copy = await api.createWidget({
      ...w, id: randomUUID(), tabId: target, name: copyName(w.name, siblings.map((x) => x.name)),
      layout: { ...w.layout, x: 0, y: bottom },
    } as Record<string, unknown>)
    return text(`Duplicated — widget_id: ${copy.id}`)
  }))

  server.registerTool('update_dashboard_display', {
    description: 'A lab dashboard\'s display settings: widget titles shown, spacing between widgets, fit each tab to '
      + 'the screen height, re-run widgets on every tab switch.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      dashboard_id: string; show_widget_titles?: boolean; widget_spacing?: number; fit_to_height?: boolean; reload_widgets_on_tab_switch?: boolean
    }>({
      type: 'object',
      properties: {
        dashboard_id: { type: 'string' }, show_widget_titles: { type: 'boolean' },
        widget_spacing: { type: 'number', description: 'Pixels between widgets (default 12).' },
        fit_to_height: { type: 'boolean' }, reload_widgets_on_tab_switch: { type: 'boolean' },
      },
      required: ['dashboard_id'],
    }),
  }, guard(async (a) => {
    const changes = Object.fromEntries(Object.entries({
      showWidgetTitles: a.show_widget_titles, widgetSpacing: a.widget_spacing, fitToHeight: a.fit_to_height,
      reloadWidgetsOnTabSwitch: a.reload_widgets_on_tab_switch,
    }).filter(([, v]) => v !== undefined))
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    await api.updateDashboard(a.dashboard_id, changes)
    return text(`Updated the display of dashboard ${a.dashboard_id}.`)
  }))

  server.registerTool('set_dashboard_description', {
    description: 'Set the description of a lab dashboard tab (hover tooltip) or widget (info bubble). "" clears it.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ tab_id?: string; widget_id?: string; description: string; description_fr?: string }>({
      type: 'object',
      properties: {
        tab_id: { type: 'string' }, widget_id: { type: 'string' }, description: { type: 'string' },
        description_fr: frenchParam('description'),
      },
      required: ['description'],
    }),
  }, guard(async ({ tab_id, widget_id, description, description_fr }) => {
    if (!!tab_id === !!widget_id) return failure('Give exactly one of tab_id or widget_id.')
    const value = description.trim() ? bilingual(description, description_fr) : null
    if (tab_id) await api.updateTab(tab_id, { description: value })
    else await api.updateWidget(widget_id!, { description: value })
    return text(`Description ${value ? 'set' : 'cleared'}.`)
  }))
}
