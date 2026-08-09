/**
 * Runs the copilot's test battery against a model, using the app's real tools
 * and system prompt so a pass reflects shipped behaviour.
 *
 * The dashboard is simulated in memory: the tools need a ToolContext, not React,
 * so a plain object stands in for the store and the checks inspect it afterwards.
 * Nothing here touches the user's real dashboard.
 */
import type { PluginManifest } from '@/types/plugin'
import { DASHBOARD_TOOLS, runDashboardTool, type ToolContext } from '../dashboard-tools'
import { buildSystemPrompt, DEFAULT_CONTEXT_OPTIONS } from '../system-prompt'
import { datasetContext } from '../dataset-context'
import { pluginDoc, pluginSummary } from '../plugin-context'
import { selectToolNames } from '../tool-selection'
import {
  assistantToolMessage,
  requestStep,
  toolResultMessage,
  type ChatMessage,
  type LlmEndpoint,
} from '../agent-loop'
import {
  benchFixture,
  selectCases,
  type BenchCase,
  type BenchLang,
  type BenchState,
  type BenchSurface,
} from './cases'

export interface CaseResult {
  id: string
  /** Localized name for display; the id stays the stable key. */
  label: string
  lang: BenchLang
  ok: boolean
  /** Why it failed, or null. */
  detail: string | null
  ms: number
  promptTokens: number
  completionTokens: number
  /** Tool names in the order the model called them, for diagnosing a failure. */
  calls: string[]
}

export interface BenchReport {
  model: string
  startedAt: number
  mode: 'quick' | 'full'
  surfaces: BenchSurface[]
  lang: BenchLang
  passed: number
  total: number
  /** Milliseconds spent waiting on the model. */
  totalMs: number
  promptTokens: number
  completionTokens: number
  /** Generation throughput, the figure that varies between machines. */
  tokensPerSecond: number
  cases: CaseResult[]
}

let seq = 0
const nextId = (kind: string) => `${kind}_bench_${++seq}`

/** ToolContext backed by a plain object rather than the dashboard store. */
function benchToolContext(state: BenchState): ToolContext {
  const dataset = (id: string) => state.datasets.find((d) => d.id === id)
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
      if (tab && changes.name) {
        tab.name = changes.name.en ?? Object.values(changes.name)[0] ?? ''
      }
    },
    addWidget: (tabId, source, name, datasetFileId) => {
      state.widgets.push({
        id: nextId('wid'),
        tabId,
        name: name.en ?? Object.values(name)[0] ?? '',
        datasetFileId,
        config: (source.type === 'plugin' ? source.config : {}) as Record<string, unknown>,
        layout: { x: 0, y: 0, w: 12, h: 8 },
      })
    },
    updateWidgetSource: (widgetId, source) => {
      const widget = state.widgets.find((w) => w.id === widgetId)
      if (widget && source.type === 'plugin') {
        widget.config = { ...widget.config, ...source.config }
      }
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
      state.widgets.find((w) => w.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null,
    describeDataset: (id) => {
      const file = dataset(id)
      return file ? datasetContext(file) : null
    },
    columnIdsByName: (id) => {
      const map = new Map<string, string>()
      for (const col of dataset(id)?.columns ?? []) map.set(col.name, col.id)
      return map
    },
    widgetDatasetId: (widgetId) =>
      state.widgets.find((w) => w.id === widgetId)?.datasetFileId ?? null,
    locale: 'fr',
  }
}

/** Run one case to completion, mutating `state` exactly as the app would. */
async function runCase(
  benchCase: BenchCase,
  endpoint: LlmEndpoint,
  manifest: PluginManifest,
  lang: BenchLang,
  signal: AbortSignal
): Promise<CaseResult> {
  const state = benchFixture()
  benchCase.seed?.(state)
  const startedAt = Date.now()
  const calls: string[] = []
  let promptTokens = 0
  let completionTokens = 0

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        dashboard: {
          dashboardName: state.dashboardName,
          activeTabId: state.activeTabId,
          tabs: state.tabs.map((t) => ({ id: t.id, name: t.name })),
          widgets: state.widgets.map((w) => ({ id: w.id, tabId: w.tabId, name: w.name })),
        },
        datasets: state.datasets,
        pluginSummaries: [pluginSummary(manifest)],
        options: DEFAULT_CONTEXT_OPTIONS,
      }),
    },
    { role: 'user', content: benchCase.prompt[lang] },
  ]

  const allowed = new Set(selectToolNames(benchCase.prompt[lang], false))
  const tools = DASHBOARD_TOOLS.filter((tool) => allowed.has(tool.function.name))

  // Go through the shared request path (requestStep) so the bench uses the exact
  // proxy routing the app does: in server mode the key stays server-side and is
  // never present in the browser. A hand-rolled fetch here would post
  // unauthenticated and defeat that guarantee.
  for (let turn = 0; turn < 6; turn++) {
    const step = await requestStep(endpoint, messages, tools, signal)
    promptTokens += step.usage?.promptTokens ?? 0
    completionTokens += step.usage?.completionTokens ?? 0

    if (!step.calls.length) {
      state.replyText = step.text
      break
    }

    messages.push(assistantToolMessage(step))

    let held = false
    for (const call of step.calls) {
      calls.push(call.name)
      const result = runDashboardTool(call.name, call.args, benchToolContext(state), () =>
        pluginDoc(manifest)
      )
      if (result.needsConfirmation) {
        state.pending = { tool: result.needsConfirmation.tool }
        held = true
      }
      messages.push(toolResultMessage(call, result.message))
    }
    if (held) break
  }

  const detail = benchCase.check(state, lang)
  return {
    id: benchCase.id,
    label: benchCase.label[lang] ?? benchCase.label.en ?? benchCase.id,
    lang,
    ok: detail === null,
    detail,
    ms: Date.now() - startedAt,
    promptTokens,
    completionTokens,
    calls,
  }
}

export interface RunBenchOptions {
  endpoint: LlmEndpoint
  manifest: PluginManifest
  mode: 'quick' | 'full'
  /** Assistant surfaces to exercise; only 'dashboard' exists today. */
  surfaces?: BenchSurface[]
  /** Prompt language — normally the app's, since that is what users type in. */
  lang?: BenchLang
  signal: AbortSignal
  /** Called after each case so the UI can show progress as it goes. */
  onProgress?: (result: CaseResult, index: number, total: number) => void
}

export async function runBench({
  endpoint,
  manifest,
  mode,
  surfaces = ['dashboard'],
  lang = 'en',
  signal,
  onProgress,
}: RunBenchOptions): Promise<BenchReport> {
  const cases = selectCases(surfaces, mode)
  const startedAt = Date.now()
  const results: CaseResult[] = []

  for (const [index, benchCase] of cases.entries()) {
    let result: CaseResult
    try {
      result = await runCase(benchCase, endpoint, manifest, lang, signal)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      result = {
        id: benchCase.id,
        label: benchCase.label[lang] ?? benchCase.label.en ?? benchCase.id,
        lang,
        ok: false,
        detail: (error as Error).message,
        ms: 0,
        promptTokens: 0,
        completionTokens: 0,
        calls: [],
      }
    }
    results.push(result)
    onProgress?.(result, index, cases.length)
  }

  const totalMs = results.reduce((sum, r) => sum + r.ms, 0)
  const completionTokens = results.reduce((sum, r) => sum + r.completionTokens, 0)
  return {
    model: endpoint.model,
    startedAt,
    mode,
    surfaces,
    lang,
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    totalMs,
    promptTokens: results.reduce((sum, r) => sum + r.promptTokens, 0),
    completionTokens,
    tokensPerSecond: totalMs > 0 ? (completionTokens / totalMs) * 1000 : 0,
    cases: results,
  }
}
