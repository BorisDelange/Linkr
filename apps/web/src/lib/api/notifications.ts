/**
 * Notification centre (server mode): changes made to entities by external
 * clients — an agent over MCP — pushed live and kept server-side.
 *
 * The socket is server → client only. The JWT travels as ?token= (a browser
 * cannot set headers on a WS handshake); on an auth close the caller refreshes
 * the token through a normal request and reconnects.
 */
import { apiRequest } from '@/lib/api-client'
import { wsBaseUrl, WS_AUTH_FAILED } from '@/lib/api/terminal-ws'
import type { LocalizedString } from '@/types'

export interface AppNotification {
  id: string
  source: string
  action: 'created' | 'updated' | 'deleted'
  entityType: string
  entityId: string
  projectUid: string | null
  label: LocalizedString
  readAt: string | null
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

export function openNotificationSocket(handlers: {
  onEvent: (event: ChangeEvent) => void
  onClose: (info: { authFailed: boolean }) => void
}): WebSocket {
  const token = localStorage.getItem('linkr-access-token') ?? ''
  const ws = new WebSocket(`${wsBaseUrl()}/api/v1/notifications/ws?token=${encodeURIComponent(token)}`)
  ws.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data as string) as ChangeEvent
      if (event.type === 'change') handlers.onEvent(event)
    } catch { /* not ours */ }
  }
  ws.onclose = (e) => handlers.onClose({ authFailed: e.code === WS_AUTH_FAILED })
  return ws
}
