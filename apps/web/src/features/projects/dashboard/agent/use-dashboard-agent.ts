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
  salvageTextToolCall,
  toolResultMessage,
  type ChatMessage,
  type LlmEndpoint,
  type ParsedToolCall,
} from '@/lib/agent/agent-loop'
import {
  DASHBOARD_TOOLS,
  PLOT_BUILDER_ID,
  runDashboardTool,
  type PendingAction,
  type ToolContext,
  type ToolResult,
} from '@/lib/agent/dashboard-tools'
import { pluginDoc, pluginSummary } from '@/lib/agent/plugin-context'
import { datasetContext } from '@/lib/agent/dataset-context'
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
  /** Set while the assistant text is still streaming in. */
  streaming?: boolean
  at: number
  /** Wall-clock milliseconds the model took, set once the turn finishes. */
  durationMs?: number
}

/**
 * One request/response pair, kept verbatim so the user can audit exactly what
 * left the browser. This matters most with a remote provider: "what did you send
 * about my patients?" must have an exact answer, not a summary.
 */
export interface ExchangeRecord {
  id: string
  at: number
  /** Messages sent, including the full system prompt. */
  request: ChatMessage[]
  responseText: string
  toolCalls: { name: string; args: Record<string, unknown> }[]
  usage?: { promptTokens: number; completionTokens: number }
  durationMs: number
}

/** Live counters for the session-info dialog. */
export interface SessionStats {
  startedAt: number
  exchanges: number
  promptTokens: number
  completionTokens: number
  /** Milliseconds spent waiting on the model, for a tokens/s figure. */
  elapsedMs: number
}

const EMPTY_STATS: SessionStats = {
  startedAt: Date.now(),
  exchanges: 0,
  promptTokens: 0,
  completionTokens: 0,
  elapsedMs: 0,
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

/**
 * Readable label for a tool call. The raw name ("remove_tab") tells a developer
 * what happened; a user wants "Deleted tab Test". Falls back to the tool name so
 * an unknown tool still shows something.
 */
function toolLabel(
  call: ParsedToolCall,
  result: ToolResult,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const name =
    (typeof call.args.name === 'string' && call.args.name) ||
    (typeof call.args.tabId === 'string' && call.args.tabId) ||
    (typeof call.args.widgetId === 'string' && call.args.widgetId) ||
    ''
  const key = `agent.tool.${call.name}${result.ok ? '' : '_failed'}`
  const label = t(key, { name, defaultValue: '' })
  return label || call.name
}

export function useDashboardAgent({ dashboardId, endpoint }: DashboardAgentOptions) {
  const { t, i18n } = useTranslation()
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [running, setRunning] = useState(false)
  const [contextOptions, setContextOptions] = useState<ContextOptions>(
    DEFAULT_CONTEXT_OPTIONS
  )
  const [canUndo, setCanUndo] = useState(false)
  const [stats, setStats] = useState<SessionStats>(() => ({
    ...EMPTY_STATS,
    startedAt: Date.now(),
  }))
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [exchanges, setExchanges] = useState<ExchangeRecord[]>([])
  /** When the current turn started, for the live elapsed counter. */
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
  const pendingRef = useRef<{
    call: ParsedToolCall
    action: PendingAction
    messages: ChatMessage[]
  } | null>(null)

  // Conversation kept across turns so follow-ups ("make it wider") work; reset
  // clears it, which is the whole point of the reset button.
  const historyRef = useRef<ChatMessage[]>([])
  const snapshotRef = useRef<Snapshot | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const locale = i18n.language?.slice(0, 2) || 'en'
  const datasets = useDatasetStore((s) => s.files)

  const push = useCallback((entry: Omit<TranscriptEntry, 'id' | 'at'>) => {
    setTranscript((prev) => [...prev, { ...entry, id: nextId(), at: Date.now() }])
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
      removeTab: store.removeTab,
      removeWidget: store.removeWidget,
      tabName: (tabId) => {
        const tab = tabsOf().find((t) => t.id === tabId)
        return tab ? localized(tab.name, locale) : null
      },
      widgetName: (widgetId) => {
        const widget = widgetsOf().find((w) => w.id === widgetId)
        return widget ? localized(widget.name, locale) : null
      },
      findTabByName: (name) => {
        const wanted = name.trim().toLowerCase()
        if (!wanted) return null
        return (
          tabsOf().find((t) => localized(t.name, locale).toLowerCase() === wanted)?.id ??
          null
        )
      },
      findWidgetByName: (name) => {
        const wanted = name.trim().toLowerCase()
        if (!wanted) return null
        return (
          widgetsOf().find((w) => localized(w.name, locale).toLowerCase() === wanted)
            ?.id ?? null
        )
      },
      describeDataset: (datasetId) => {
        const file = useDatasetStore.getState().files.find((f) => f.id === datasetId)
        if (!file || file.type !== 'file') return null
        return datasetContext({
          id: file.id,
          name: file.name,
          columns: file.columns ?? [],
          rowCount: file.rowCount,
        })
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
    pendingRef.current = null
    setPending(null)
    setCanUndo(false)
    setTranscript([])
    setExchanges([])
    setStats({ ...EMPTY_STATS, startedAt: Date.now() })
  }, [stop])

  /** Run a destructive call the user just approved. */
  const confirmPending = useCallback(() => {
    const held = pendingRef.current
    if (!held) return
    pendingRef.current = null
    setPending(null)
    const result = runDashboardTool(
      held.call.name,
      held.action.args,
      toolContext(),
      describe,
      true
    )
    push({
      kind: 'tool',
      text: toolLabel(held.call, result, t),
      detail: result.message,
      ok: result.ok,
    })
    if (result.ok) setCanUndo(true)
  }, [describe, push, t, toolContext])

  const cancelPending = useCallback(() => {
    pendingRef.current = null
    setPending(null)
    push({ kind: 'assistant', text: t('agent.cancelled') })
  }, [push, t])

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
      setTurnStartedAt(Date.now())
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
          const startedAt = Date.now()
          // Stream into a single entry so the user watches the reply form rather
          // than staring at a frozen panel.
          const entryId = nextId()
          let streamed = false
          const step = await requestStep(
            endpoint,
            messages,
            DASHBOARD_TOOLS,
            controller.signal,
            (chunk) => {
              setTranscript((prev) => {
                if (!streamed) {
                  streamed = true
                  return [
                    ...prev,
                    {
                      id: entryId,
                      kind: 'assistant',
                      text: chunk,
                      streaming: true,
                      at: startedAt,
                    },
                  ]
                }
                return prev.map((entry) =>
                  entry.id === entryId ? { ...entry, text: entry.text + chunk } : entry
                )
              })
            }
          )

          const elapsed = Date.now() - startedAt
          // Snapshot the exact payload sent, before tool results are appended.
          const sent = messages.map((message) => ({ ...message }))
          setExchanges((prev) => [
            ...prev,
            {
              id: nextId(),
              at: startedAt,
              request: sent,
              responseText: step.text,
              toolCalls: step.calls.map((call) => ({ name: call.name, args: call.args })),
              usage: step.usage,
              durationMs: elapsed,
            },
          ])
          setStats((prev) => ({
            ...prev,
            exchanges: prev.exchanges + 1,
            promptTokens: prev.promptTokens + (step.usage?.promptTokens ?? 0),
            completionTokens: prev.completionTokens + (step.usage?.completionTokens ?? 0),
            elapsedMs: prev.elapsedMs + elapsed,
          }))

          if (streamed) {
            setTranscript((prev) =>
              prev.map((entry) =>
                entry.id === entryId
                  ? { ...entry, text: step.text, streaming: false, durationMs: elapsed }
                  : entry
              )
            )
          } else if (step.text) {
            push({ kind: 'assistant', text: step.text, durationMs: elapsed })
          }

          // A model that printed a tool call as prose instead of emitting it
          // properly would otherwise do nothing at all, silently.
          const calls = step.calls.length
            ? step.calls
            : [salvageTextToolCall(step.text)].filter(
                (call): call is ParsedToolCall => call !== null
              )

          if (!calls.length) {
            messages.push({ role: 'assistant', content: step.text })
            break
          }

          messages.push(assistantToolMessage({ ...step, calls }))
          let awaitingConfirmation = false
          for (const call of calls) {
            const result = runDashboardTool(call.name, call.args, toolContext(), describe)

            if (result.needsConfirmation) {
              pendingRef.current = { call, action: result.needsConfirmation, messages }
              setPending(result.needsConfirmation)
              messages.push(toolResultMessage(call, result.message))
              awaitingConfirmation = true
              break
            }

            if (result.ok && call.name !== 'describe_plugin') mutated = true
            push({
              kind: 'tool',
              text: toolLabel(call, result, t),
              detail: result.message,
              ok: result.ok,
            })
            messages.push(toolResultMessage(call, result.message))
          }
          if (awaitingConfirmation) break
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
        setTurnStartedAt(null)
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
    /** The exact system prompt that will be sent with the next message. */
    systemPrompt: buildPrompt,
    exchanges,
    turnStartedAt,
    stats,
    pending,
    confirmPending,
    cancelPending,
    send,
    stop,
    undo,
    reset,
  }
}
