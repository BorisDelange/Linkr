/**
 * Runs one bench case against a model, using the app's REAL tool definitions,
 * system prompt and dispatcher (loaded from the TypeScript sources through
 * vite-node), so a pass here reflects the shipped behaviour rather than a
 * parallel implementation that could drift.
 *
 * The dashboard is simulated in memory: the tools need a ToolContext, not React,
 * so the store is replaced by a plain object the checks can inspect afterwards.
 */
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(HERE, '../..')

let modules = null

/** Load the app's agent modules once, compiled on the fly by vite. */
async function loadAppModules() {
  if (modules) return modules
  const server = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    logLevel: 'error',
  })
  const [tools, prompt, plugin, dataset, selection] = await Promise.all([
    server.ssrLoadModule('/src/lib/agent/dashboard-tools.ts'),
    server.ssrLoadModule('/src/lib/agent/system-prompt.ts'),
    server.ssrLoadModule('/src/lib/agent/plugin-context.ts'),
    server.ssrLoadModule('/src/lib/agent/dataset-context.ts'),
    server.ssrLoadModule('/src/lib/agent/tool-selection.ts'),
  ])
  const manifest = JSON.parse(
    await import('node:fs').then((fs) =>
      fs.readFileSync(
        resolve(WEB_ROOT, '../../packages/default-plugins/analyses/plot-builder/plugin.json'),
        'utf8'
      )
    )
  )
  await server.close()
  modules = { tools, prompt, plugin, dataset, selection, manifest }
  return modules
}

let seq = 0
const nextId = (kind) => `${kind}_${++seq}`

/** A mutable stand-in for the dashboard store, shaped for the bench's checks. */
export function buildState(fixture) {
  return {
    dashboardName: fixture.dashboardName,
    tabs: fixture.tabs.map((tab) => ({ ...tab })),
    widgets: fixture.widgets.map((widget) => ({ ...widget })),
    activeTabId: fixture.activeTabId,
    datasets: fixture.datasets,
    pending: null,
    replyText: '',
  }
}

function toolContext(state, mods) {
  const dataset = (id) => state.datasets.find((d) => d.id === id)
  return {
    dashboardId: 'dash_bench',
    activeTabId: state.activeTabId,
    addTab: () => {
      const id = nextId('tab')
      state.tabs.push({ id, name: '' })
      state.activeTabId = id
    },
    updateTab: (tabId, changes) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      if (tab && changes.name) tab.name = changes.name.en ?? Object.values(changes.name)[0]
    },
    addWidget: (tabId, source, name, datasetFileId) => {
      state.widgets.push({
        id: nextId('wid'),
        tabId,
        name: name.en ?? Object.values(name)[0],
        datasetFileId,
        config: source.config ?? {},
        layout: { x: 0, y: 0, w: 12, h: 8 },
      })
    },
    updateWidgetSource: (widgetId, source) => {
      const widget = state.widgets.find((w) => w.id === widgetId)
      if (widget) widget.config = { ...widget.config, ...(source.config ?? {}) }
    },
    updateWidgetLayout: (widgetId, layout) => {
      const widget = state.widgets.find((w) => w.id === widgetId)
      if (widget) widget.layout = layout
    },
    tabIds: () => state.tabs.map((t) => t.id),
    widgetIds: () => state.widgets.map((w) => w.id),
    datasetIds: () => state.datasets.map((d) => d.id),
    lastWidgetIdInTab: (tabId) => {
      const inTab = state.widgets.filter((w) => w.tabId === tabId)
      return inTab.length ? inTab[inTab.length - 1].id : null
    },
    lastTabId: () => (state.tabs.length ? state.tabs[state.tabs.length - 1].id : null),
    removeTab: (tabId) => {
      state.tabs = state.tabs.filter((t) => t.id !== tabId)
      state.widgets = state.widgets.filter((w) => w.tabId !== tabId)
    },
    removeWidget: (widgetId) => {
      state.widgets = state.widgets.filter((w) => w.id !== widgetId)
    },
    tabName: (tabId) => state.tabs.find((t) => t.id === tabId)?.name ?? null,
    widgetName: (widgetId) => state.widgets.find((w) => w.id === widgetId)?.name ?? null,
    findTabByName: (name) =>
      state.tabs.find((t) => t.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null,
    findWidgetByName: (name) =>
      state.widgets.find((w) => w.name.toLowerCase() === name.trim().toLowerCase())?.id ??
      null,
    describeDataset: (id) => {
      const file = dataset(id)
      return file ? mods.dataset.datasetContext(file) : null
    },
    columnIdsByName: (id) => {
      const map = new Map()
      for (const column of dataset(id)?.columns ?? []) map.set(column.name, column.id)
      return map
    },
    widgetDatasetId: (widgetId) =>
      state.widgets.find((w) => w.id === widgetId)?.datasetFileId ?? null,
    locale: 'fr',
  }
}

/** Drive one request to completion, mutating `state` exactly as the app would. */
export async function runCase({ model, baseUrl, prompt, state }) {
  const mods = await loadAppModules()
  const started = Date.now()

  const systemPrompt = mods.prompt.buildSystemPrompt({
    dashboard: {
      dashboardName: state.dashboardName,
      activeTabId: state.activeTabId,
      tabs: state.tabs.map((t) => ({ id: t.id, name: t.name })),
      widgets: state.widgets.map((w) => ({ id: w.id, tabId: w.tabId, name: w.name })),
    },
    datasets: state.datasets,
    pluginSummaries: [mods.plugin.pluginSummary(mods.manifest)],
    options: mods.prompt.DEFAULT_CONTEXT_OPTIONS,
  })

  const allowed = new Set(mods.selection.selectToolNames(prompt, false))
  const tools = mods.tools.DASHBOARD_TOOLS.filter((tool) => allowed.has(tool.function.name))

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]
  const calls = []
  let promptTokens = 0

  for (let turn = 0; turn < 6; turn++) {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, temperature: 0, stream: false }),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`)
    }
    const payload = await response.json()
    promptTokens = payload.usage?.prompt_tokens ?? promptTokens
    const message = payload.choices?.[0]?.message ?? {}
    const text = (message.content ?? '').trim()

    let parsed = (message.tool_calls ?? []).map((call, index) => {
      let args = {}
      try {
        args =
          typeof call.function.arguments === 'string'
            ? JSON.parse(call.function.arguments)
            : call.function.arguments ?? {}
      } catch {
        args = {}
      }
      return { id: call.id ?? `call_${index}`, name: call.function.name, args }
    })

    // Same salvage the app applies: some models print the call as prose.
    if (!parsed.length && text.includes('"name"')) {
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start !== -1 && end > start) {
        try {
          const obj = JSON.parse(text.slice(start, end + 1))
          if (obj.name) {
            parsed = [
              { id: 'salvaged', name: obj.name, args: obj.parameters ?? obj.arguments ?? {} },
            ]
          }
        } catch {
          // not a tool call after all
        }
      }
    }

    if (!parsed.length) {
      state.replyText = text
      break
    }

    messages.push({
      role: 'assistant',
      content: text,
      tool_calls: parsed.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    })

    let held = false
    for (const call of parsed) {
      calls.push(call.name)
      const result = mods.tools.runDashboardTool(
        call.name,
        call.args,
        toolContext(state, mods),
        () => mods.plugin.pluginDoc(mods.manifest)
      )
      if (result.needsConfirmation) {
        // The bench stops at the confirmation, exactly as the UI does.
        state.pending = result.needsConfirmation
        held = true
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.message })
    }
    if (held) break
  }

  return { calls, ms: Date.now() - started, promptTokens }
}
