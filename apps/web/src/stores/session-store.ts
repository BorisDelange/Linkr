import { create } from 'zustand'
import { isServerMode } from '@/lib/api-client'
import {
  listSessions,
  createSession as apiCreate,
  deleteSession as apiDelete,
  type ExecutionSession,
} from '@/lib/api/execution-sessions'

/** The always-present implicit session (the kernel's "default" env). Never
 * created or deleted; every project has it. */
export const DEFAULT_SESSION: ExecutionSession = {
  id: 'default',
  projectUid: '',
  name: 'Default',
}

const ACTIVE_KEY = 'linkr-active-session'

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
  /** Named sessions per project (excludes the implicit default). */
  sessions: Record<string, ExecutionSession[]>
  /** Active session id per project (persisted). Defaults to 'default'. */
  activeByProject: Record<string, string>
  loadSessions: (projectUid: string) => Promise<void>
  createSession: (projectUid: string, name: string) => Promise<string>
  removeSession: (projectUid: string, sessionId: string) => Promise<void>
  setActiveSession: (projectUid: string, sessionId: string) => void
  /** The active session id for a project (or 'default'). */
  getActiveSessionId: (projectUid: string) => string
  /** default + named sessions, for a dropdown. */
  getSessionsForProject: (projectUid: string) => ExecutionSession[]
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: {},
  activeByProject: loadActive(),

  loadSessions: async (projectUid) => {
    if (!isServerMode()) return
    try {
      const list = await listSessions(projectUid)
      set((s) => ({ sessions: { ...s.sessions, [projectUid]: list } }))
    } catch {
      // Leave existing (or empty) — the dropdown still offers Default.
    }
  },

  createSession: async (projectUid, name) => {
    const id = crypto.randomUUID()
    const created = await apiCreate(projectUid, id, name)
    set((s) => ({
      sessions: {
        ...s.sessions,
        [projectUid]: [...(s.sessions[projectUid] ?? []), created],
      },
    }))
    return id
  },

  removeSession: async (projectUid, sessionId) => {
    await apiDelete(sessionId)
    set((s) => {
      const next = (s.sessions[projectUid] ?? []).filter((x) => x.id !== sessionId)
      // If the deleted session was active, fall back to default.
      const active = { ...s.activeByProject }
      if (active[projectUid] === sessionId) {
        active[projectUid] = 'default'
        saveActive(active)
      }
      return { sessions: { ...s.sessions, [projectUid]: next }, activeByProject: active }
    })
  },

  setActiveSession: (projectUid, sessionId) => {
    set((s) => {
      const active = { ...s.activeByProject, [projectUid]: sessionId }
      saveActive(active)
      return { activeByProject: active }
    })
  },

  getActiveSessionId: (projectUid) => get().activeByProject[projectUid] ?? 'default',

  getSessionsForProject: (projectUid) => [
    { ...DEFAULT_SESSION, projectUid },
    ...(get().sessions[projectUid] ?? []),
  ],
}))
