/**
 * Notification centre (server mode): changes made to entities by external
 * clients — an agent over MCP — pushed live and kept server-side.
 *
 * Server → client: entity changes. Client → server: only where the user is
 * (`ui-context`), which the MCP's get_ui_context reads back. The JWT travels as ?token= (a browser
 * cannot set headers on a WS handshake); on an auth close the caller refreshes
 * the token through a normal request and reconnects.
 */
import { apiRequest } from '@/lib/api-client'
import { wsBaseUrl, WS_AUTH_FAILED } from '@/lib/api/terminal-ws'
import type { LocalizedString } from '@/types'

/** A concept an agent mapped or suggested, as a mapping notification lists it. */
export interface MappingNotificationItem {
  sourceCode: string
  sourceName: string | null
  conceptId: number
  conceptName: string | null
  equivalence: string | null
  status?: string | null
}

/** What changed inside the entity, when not the entity itself: a dashboard's
 *  widget or tab, or the concepts a mapping write added (first few, plus a count). */
export interface NotificationDetail {
  part: 'widget' | 'tab' | 'suggestions' | 'mappings'
  action: 'created' | 'updated' | 'deleted'
  name: LocalizedString
  count?: number
  workspaceId?: string
  items?: MappingNotificationItem[]
  more?: number
}

export interface AppNotification {
  id: string
  source: string
  action: 'created' | 'updated' | 'deleted'
  entityType: string
  entityId: string
  projectUid: string | null
  label: LocalizedString
  /** What changed inside the entity (a dashboard's widget or tab), when not the entity itself. */
  detail: NotificationDetail | null
  readAt: string | null
  undoneAt: string | null
  /** Server-computed: reversible, not yet reversed, and the latest change to its item. */
  undoable: boolean
  createdAt: string
}

/** One entity change. `notification` is absent for a change not worth one (a
 *  cohort's cached count after a run), which still refreshes the open tab. */
export interface ChangeEvent {
  type: 'change'
  action: AppNotification['action']
  entityType: string
  entityId: string
  projectUid: string | null
  notification?: AppNotification
}

export const listNotifications = () => apiRequest<AppNotification[]>('/notifications')
export const markNotificationsRead = () => apiRequest<void>('/notifications/read', { method: 'POST' })
export const clearNotifications = () => apiRequest<void>('/notifications', { method: 'DELETE' })
export const undoNotification = (id: string) =>
  apiRequest<void>(`/notifications/${encodeURIComponent(id)}/undo`, { method: 'POST' })

/** Where the user is in this tab, so an agent can resolve "this cohort", "here".
 *  Ids are full (never the shortened ids of the URL). */
export interface UiContext {
  path: string
  projectUid: string | null
  page: string | null
  cohortId?: string
  dashboardId?: string
  dashboardTabId?: string
  datasetPath?: string
}

export function openNotificationSocket(handlers: {
  onOpen: () => void
  onEvent: (event: ChangeEvent) => void
  onClose: (info: { authFailed: boolean }) => void
}): WebSocket {
  const token = localStorage.getItem('linkr-access-token') ?? ''
  const ws = new WebSocket(`${wsBaseUrl()}/api/v1/notifications/ws?token=${encodeURIComponent(token)}`)
  ws.onopen = () => handlers.onOpen()
  ws.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data as string) as ChangeEvent
      if (event.type === 'change') handlers.onEvent(event)
    } catch { /* not ours */ }
  }
  ws.onclose = (e) => handlers.onClose({ authFailed: e.code === WS_AUTH_FAILED })
  return ws
}
