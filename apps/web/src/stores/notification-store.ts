import { create } from 'zustand'
import {
  clearNotifications, listNotifications, markNotificationsRead, openNotificationSocket, undoNotification,
  type AppNotification, type ChangeEvent, type UiContext,
} from '@/lib/api/notifications'
import { useCohortStore } from '@/stores/cohort-store'
import { useConceptListStore } from '@/stores/concept-list-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useFileStore } from '@/stores/file-store'

/**
 * Applies a change made elsewhere to the store that holds the entity, so an open
 * page shows it without a reload. Stores write optimistically and never read
 * back, so without this an agent's write leaves the tab stale.
 */
const REFRESHERS: Record<string, (event: ChangeEvent) => Promise<void>> = {
  cohort: (e) => useCohortStore.getState().applyRemoteChange(e.entityId, e.action === 'deleted'),
  dashboard: (e) => useDashboardStore.getState().applyRemoteChange(e.entityId, e.action === 'deleted'),
  script: async (e) => {
    if (e.projectUid) await useFileStore.getState().applyRemoteChange(e.projectUid)
  },
  concept_list: () => useConceptListStore.getState().loadConceptLists(),
  dataset: async (e) => {
    const store = useDatasetStore.getState()
    if (e.projectUid && store.activeProjectUid === e.projectUid) await store.reloadDatasetsFromDisk(e.projectUid)
  },
}

const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

interface NotificationState {
  items: AppNotification[]
  unread: number
  connect: () => void
  disconnect: () => void
  markAllRead: () => Promise<void>
  clearAll: () => Promise<void>
  /** Reverse the change a notification reports; the list is re-read, since undoing
   *  one change makes the one before it on the same item undoable. */
  undo: (id: string) => Promise<void>
  /** Tell the server where the user is in this tab (sent again on reconnect). */
  publishContext: (context: UiContext) => void
}

let socket: WebSocket | null = null
let wanted = false
let attempt = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let lastContext: UiContext | null = null

const sendContext = () => {
  if (socket?.readyState === WebSocket.OPEN && lastContext) {
    socket.send(JSON.stringify({ type: 'ui-context', context: lastContext }))
  }
}

const countUnread = (items: AppNotification[]) => items.filter((n) => !n.readAt).length

export const useNotificationStore = create<NotificationState>((set, get) => {
  const reload = async () => {
    const items = await listNotifications()
    set({ items, unread: countUnread(items) })
  }

  const open = () => {
    socket = openNotificationSocket({
      onOpen: sendContext,
      onEvent: (event) => {
        attempt = 0
        void REFRESHERS[event.entityType]?.(event)
        if (event.notification) {
          const items = [event.notification, ...get().items.filter((n) => n.id !== event.notification!.id)]
          set({ items, unread: countUnread(items) })
        }
      },
      onClose: ({ authFailed }) => {
        socket = null
        if (!wanted) return
        // An expired access token: a normal request refreshes it (apiRequest
        // handles the 401), then the socket reconnects with the new one. The same
        // reload catches up on anything missed while disconnected.
        const delay = authFailed ? 0 : RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]
        attempt++
        retryTimer = setTimeout(() => {
          reload().then(() => { if (wanted && !socket) open() }).catch(() => {})
        }, delay)
      },
    })
  }

  return {
    items: [],
    unread: 0,

    connect: () => {
      if (wanted) return
      wanted = true
      attempt = 0
      reload().catch(() => {})
      open()
    },

    disconnect: () => {
      wanted = false
      clearTimeout(retryTimer)
      socket?.close()
      socket = null
    },

    markAllRead: async () => {
      if (get().unread === 0) return
      const now = new Date().toISOString()
      set((s) => ({ items: s.items.map((n) => (n.readAt ? n : { ...n, readAt: now })), unread: 0 }))
      await markNotificationsRead()
    },

    clearAll: async () => {
      set({ items: [], unread: 0 })
      await clearNotifications()
    },

    undo: async (id) => {
      await undoNotification(id)
      await reload()
    },

    publishContext: (context) => {
      lastContext = context
      sendContext()
    },
  }
})
