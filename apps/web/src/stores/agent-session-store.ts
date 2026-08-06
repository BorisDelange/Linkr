import { create } from 'zustand'
import type { ChatMessage } from '@/lib/agent/agent-loop'

/**
 * The copilot conversation, held outside the sidebar component.
 *
 * Closing the panel unmounts it, which used to throw the conversation away —
 * surprising, because hiding a panel reads as "get out of the way", not "start
 * over". Reset is the button that clears it.
 *
 * Keyed by dashboard: two dashboards are two conversations, and the state is
 * about ids that only mean something within one dashboard.
 */

export interface TranscriptEntry {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  detail?: string
  ok?: boolean
  streaming?: boolean
  at: number
  durationMs?: number
}

export interface ExchangeRecord {
  id: string
  at: number
  request: ChatMessage[]
  responseText: string
  toolCalls: { name: string; args: Record<string, unknown> }[]
  usage?: { promptTokens: number; completionTokens: number }
  durationMs: number
}

export interface SessionStats {
  startedAt: number
  exchanges: number
  promptTokens: number
  completionTokens: number
  elapsedMs: number
}

export interface AgentSession {
  transcript: TranscriptEntry[]
  exchanges: ExchangeRecord[]
  stats: SessionStats
  history: ChatMessage[]
  canUndo: boolean
  /** Unsent input. Hiding the panel must not discard a half-typed question. */
  draft: string
}

function emptySession(): AgentSession {
  return {
    transcript: [],
    exchanges: [],
    stats: {
      startedAt: Date.now(),
      exchanges: 0,
      promptTokens: 0,
      completionTokens: 0,
      elapsedMs: 0,
    },
    history: [],
    canUndo: false,
    draft: '',
  }
}

interface AgentSessionState {
  sessions: Record<string, AgentSession>
  get: (dashboardId: string) => AgentSession
  update: (dashboardId: string, patch: Partial<AgentSession>) => void
  /** Functional update, for appending to a list without a stale read. */
  mutate: (dashboardId: string, fn: (session: AgentSession) => Partial<AgentSession>) => void
  reset: (dashboardId: string) => void
}

export const useAgentSessionStore = create<AgentSessionState>((set, get) => ({
  sessions: {},

  get: (dashboardId) => get().sessions[dashboardId] ?? emptySession(),

  update: (dashboardId, patch) =>
    set((state) => {
      const current = state.sessions[dashboardId] ?? emptySession()
      return { sessions: { ...state.sessions, [dashboardId]: { ...current, ...patch } } }
    }),

  mutate: (dashboardId, fn) =>
    set((state) => {
      const current = state.sessions[dashboardId] ?? emptySession()
      return {
        sessions: { ...state.sessions, [dashboardId]: { ...current, ...fn(current) } },
      }
    }),

  reset: (dashboardId) =>
    set((state) => ({
      sessions: { ...state.sessions, [dashboardId]: emptySession() },
    })),
}))
