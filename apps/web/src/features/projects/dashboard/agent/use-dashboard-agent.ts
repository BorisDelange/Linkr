/**
 * Drives the dashboard copilot: builds the context, runs the agent loop, executes
 * tool calls against the store, and keeps a per-turn snapshot for undo.
 *
 * Undo is per TURN, not per action: one request can produce several mutations
 * ("add a tab with a histogram, half width" is three), and the user thinks of
 * that as one thing they asked for. A general undo/redo stack would be a much
 * larger change to the store for no extra benefit here.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DashboardTab, DashboardWidget } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { getPlugin, getLabPlugins } from '@/lib/plugins/registry'
import { localized } from '@/lib/localized'
import {
  AgentError,
  MAX_TURNS,
  assistantToolMessage,
  requestStep,
  toolResultMessage,
  type ChatMessage,
  type LlmEndpoint,
} from '@/lib/agent/agent-loop'
import {
  DASHBOARD_TOOLS,
  PLOT_BUILDER_ID,
  runDashboardTool,
  type ToolContext,
} from '@/lib/agent/dashboard-tools'
import { pluginDoc, pluginSummary } from '@/lib/agent/plugin-context'
import {
  DEFAULT_CONTEXT_OPTIONS,
  buildSystemPrompt,
  estimateTokens,
  type ContextOptions,
} from '@/lib/agent/system-prompt'

/** One line in the transcript the sidebar renders. */
export interface TranscriptEntry {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  /** Tool entries collapse to one line; this is the detail behind it. */
  detail?: string
  ok?: boolean
}

interface Snapshot {
  tabs: DashboardTab[]
  widgets: DashboardWidget[]
  activeTabId: Record<string, string>
}

export interface DashboardAgentOptions {
  dashboardId: string
  projectUid: string
  endpoint: LlmEndpoint | null
}

let entrySeq = 0
const nextId = () => `e${++entrySeq}`

export function useDashboardAgent({ dashboardId, endpoint }: DashboardAgentOptions) {
  const { i18n } = useTranslation()
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [running, setRunning] = useState(false)
  const [contextOptions, setContextOptions] = useState<ContextOptions>(
    DEFAULT_CONTEXT_OPTIONS
  )
  const [canUndo, setCanUndo] = useState(false)

  // Conversation kept across turns so follow-ups ("make it wider") work; reset
  // clears it, which is the whole point of the reset button.
  const historyRef = useRef<ChatMessage[]>([])
  const snapshotRef = useRef<Snapshot | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const locale = i18n.language?.slice(0, 2) || 'en'
  const datasets = useDatasetStore((s) => s.files)

  const push = useCallback((entry: Omit<TranscriptEntry, 'id'>) => {
    setTranscript((prev) => [...prev, { ...entry, id: nextId() }])
  }, [])

  const pluginSummaries = useMemo(
    // MVP scope: plot-builder only. Widening this is a one-line change once the
    // derived docs have been checked against more manifests.
    () => getLabPlugins().filter((p) => p.manifest.id === PLOT_BUILDER_ID)
      .map((p) => pluginSummary(p.manifest)),
    []
  )

  const buildPrompt = useCallback((): string => {
    const state = useDashboardStore.getState()
    const dashboard = state.dashboards.find((d) => d.id === dashboardId)
    const tabs = state.tabs.filter((t) => t.dashboardId === dashboardId)
    const tabIds = new Set(tabs.map((t) => t.id))
    const widgets = state.widgets.filter((w) => tabIds.has(w.tabId))

    return buildSystemPrompt({
      dashboard: {
        dashboardName: localized(dashboard?.name, locale) || 'Dashboard',
        activeTabId: state.activeTabId[dashboardId] ?? null,
        tabs: tabs.map((t) => ({ id: t.id, name: localized(t.name, locale) })),
        widgets: widgets.map((w) => ({
          id: w.id,
          tabId: w.tabId,
          name: localized(w.name, locale),
        })),
      },
      datasets: datasets
        .filter((file) => file.type === 'file' && file.columns?.length)
        .map((file) => ({
          id: file.id,
          name: file.name,
          columns: file.columns ?? [],
          rowCount: file.rowCount,
        })),
      pluginSummaries,
      options: contextOptions,
    })
  }, [dashboardId, datasets, locale, pluginSummaries, contextOptions])

  const contextTokens = useMemo(
    () => estimateTokens(buildPrompt()),
    [buildPrompt]
  )

  const toolContext = useCallback((): ToolContext => {
    const store = useDashboardStore.getState()
    const tabsOf = () =>
      useDashboardStore.getState().tabs.filter((t) => t.dashboardId === dashboardId)
    const widgetsOf = () => {
      const ids = new Set(tabsOf().map((t) => t.id))
      return useDashboardStore.getState().widgets.filter((w) => ids.has(w.tabId))
    }
    return {
      dashboardId,
      activeTabId: store.activeTabId[dashboardId] ?? null,
      addTab: store.addTab,
      updateTab: store.updateTab,
      addWidget: store.addWidget,
      updateWidgetSource: store.updateWidgetSource,
      updateWidgetLayout: store.updateWidgetLayout,
      tabIds: () => tabsOf().map((t) => t.id),
      widgetIds: () => widgetsOf().map((w) => w.id),
      datasetIds: () => useDatasetStore.getState().files.map((f) => f.id),
      lastWidgetIdInTab: (tabId) => {
        const inTab = widgetsOf().filter((w) => w.tabId === tabId)
        return inTab.length ? inTab[inTab.length - 1].id : null
      },
      lastTabId: () => {
        const all = tabsOf()
        return all.length ? all[all.length - 1].id : null
      },
      locale,
    }
  }, [dashboardId, locale])

  const describe = useCallback((pluginId: string): string | null => {
    const plugin = getPlugin(pluginId)
    return plugin ? pluginDoc(plugin.manifest) : null
  }, [])

  const snapshot = useCallback((): Snapshot => {
    const s = useDashboardStore.getState()
    return {
      tabs: s.tabs.map((t) => ({ ...t })),
      widgets: s.widgets.map((w) => ({ ...w, layout: { ...w.layout } })),
      activeTabId: { ...s.activeTabId },
    }
  }, [])

  const undo = useCallback(() => {
    const snap = snapshotRef.current
    if (!snap) return
    useDashboardStore.setState({
      tabs: snap.tabs,
      widgets: snap.widgets,
      activeTabId: snap.activeTabId,
    })
    snapshotRef.current = null
    setCanUndo(false)
    push({ kind: 'assistant', text: 'reverted' })
  }, [push])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }, [])

  const reset = useCallback(() => {
    stop()
    historyRef.current = []
    snapshotRef.current = null
    setCanUndo(false)
    setTranscript([])
  }, [stop])

  const send = useCallback(
    async (userText: string) => {
      const text = userText.trim()
      if (!text || running) return
      if (!endpoint) {
        push({ kind: 'error', text: 'no_provider' })
        return
      }

      push({ kind: 'user', text })
      setRunning(true)
      // Snapshot before any mutation so [Undo] restores the pre-turn dashboard.
      snapshotRef.current = snapshot()

      const controller = new AbortController()
      abortRef.current = controller

      const messages: ChatMessage[] = [
        { role: 'system', content: buildPrompt() },
        ...historyRef.current,
        { role: 'user', content: text },
      ]

      try {
        let mutated = false
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const step = await requestStep(
            endpoint,
            messages,
            DASHBOARD_TOOLS,
            controller.signal
          )
          if (step.text) push({ kind: 'assistant', text: step.text })

          if (!step.calls.length) {
            messages.push({ role: 'assistant', content: step.text })
            break
          }

          messages.push(assistantToolMessage(step))
          for (const call of step.calls) {
            const result = runDashboardTool(call.name, call.args, toolContext(), describe)
            if (result.ok && call.name !== 'describe_plugin') mutated = true
            push({
              kind: 'tool',
              text: call.name,
              detail: result.message,
              ok: result.ok,
            })
            messages.push(toolResultMessage(call, result.message))
          }
        }
        setCanUndo(mutated)
        // Keep only the user/assistant exchange in history: replaying tool calls
        // on the next turn would re-describe stale ids, and the fresh system
        // prompt already carries the current state.
        historyRef.current = [
          ...historyRef.current,
          { role: 'user' as const, content: text },
        ].slice(-8)
      } catch (error) {
        if ((error as Error)?.name !== 'AbortError') {
          push({
            kind: 'error',
            text: error instanceof AgentError ? error.message : 'unexpected_error',
          })
        }
      } finally {
        abortRef.current = null
        setRunning(false)
      }
    },
    [buildPrompt, describe, endpoint, push, running, snapshot, toolContext]
  )

  return {
    transcript,
    running,
    canUndo,
    contextTokens,
    contextOptions,
    setContextOptions,
    send,
    stop,
    undo,
    reset,
  }
}
