import { create } from 'zustand'
import { isServerMode } from '@/lib/api-client'
import {
  listSessions,
  createSession as apiCreate,
  deleteSession as apiDelete,
  type ExecutionSession,
  type SessionLanguage,
} from '@/lib/api/execution-sessions'

/** The always-present implicit session (the kernel's "default" env), one per
 * language. Never created or deleted; every project has it in each language. */
export function defaultSession(
  projectUid: string,
  language: SessionLanguage,
): ExecutionSession {
  return { id: 'default', projectUid, language, name: 'Default' }
}

const ACTIVE_KEY = 'linkr-active-session'

/** Sessions are scoped per (project, language), so caches key on both. */
function scopeKey(projectUid: string, language: SessionLanguage): string {
  return `${projectUid}:${language}`
}

function loadActive(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function saveActive(map: Record<string, string>): void {
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(map))
}

interface SessionState {
  /** Named sessions per (project, language) scope (excludes the implicit default). */
  sessions: Record<string, ExecutionSession[]>
  /** Active session id per (project, language) scope (persisted). Defaults to 'default'. */
  activeByScope: Record<string, string>
  loadSessions: (projectUid: string, language: SessionLanguage) => Promise<void>
  createSession: (
    projectUid: string,
    language: SessionLanguage,
    name: string,
  ) => Promise<string>
  removeSession: (
    projectUid: string,
    language: SessionLanguage,
    sessionId: string,
  ) => Promise<void>
  setActiveSession: (
    projectUid: string,
    language: SessionLanguage,
    sessionId: string,
  ) => void
  /** The active session id for a (project, language) scope (or 'default'). */
  getActiveSessionId: (projectUid: string, language: SessionLanguage) => string
  /** default + named sessions for a (project, language), for a dropdown. */
  getSessionsForProject: (
    projectUid: string,
    language: SessionLanguage,
  ) => ExecutionSession[]
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: {},
  activeByScope: loadActive(),

  loadSessions: async (projectUid, language) => {
    if (!isServerMode()) return
    const key = scopeKey(projectUid, language)
    try {
      const list = await listSessions(projectUid, language)
      set((s) => ({ sessions: { ...s.sessions, [key]: list } }))
    } catch {
      // Leave existing (or empty) — the dropdown still offers Default.
    }
  },

  createSession: async (projectUid, language, name) => {
    const id = crypto.randomUUID()
    const key = scopeKey(projectUid, language)
    const created = await apiCreate(projectUid, id, language, name)
    set((s) => ({
      sessions: {
        ...s.sessions,
        [key]: [...(s.sessions[key] ?? []), created],
      },
    }))
    return id
  },

  removeSession: async (projectUid, language, sessionId) => {
    const key = scopeKey(projectUid, language)
    await apiDelete(sessionId)
    set((s) => {
      const next = (s.sessions[key] ?? []).filter((x) => x.id !== sessionId)
      // If the deleted session was active, fall back to default.
      const active = { ...s.activeByScope }
      if (active[key] === sessionId) {
        active[key] = 'default'
        saveActive(active)
      }
      return { sessions: { ...s.sessions, [key]: next }, activeByScope: active }
    })
  },

  setActiveSession: (projectUid, language, sessionId) => {
    const key = scopeKey(projectUid, language)
    set((s) => {
      const active = { ...s.activeByScope, [key]: sessionId }
      saveActive(active)
      return { activeByScope: active }
    })
  },

  getActiveSessionId: (projectUid, language) =>
    get().activeByScope[scopeKey(projectUid, language)] ?? 'default',

  getSessionsForProject: (projectUid, language) => [
    defaultSession(projectUid, language),
    ...(get().sessions[scopeKey(projectUid, language)] ?? []),
  ],
}))
