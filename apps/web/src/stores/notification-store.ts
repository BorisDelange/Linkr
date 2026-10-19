import { create } from 'zustand'
import {
  clearNotifications, listNotifications, markNotificationsRead, openNotificationSocket, undoNotification,
  type AppNotification, type ChangeEvent, type UiContext,
} from '@/lib/api/notifications'
import { useCohortStore } from '@/stores/cohort-store'
import { useConceptListStore } from '@/stores/concept-list-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useEtlStore } from '@/stores/etl-store'
import { useAppStore } from '@/stores/app-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useDqStore } from '@/stores/dq-store'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useWikiStore } from '@/stores/wiki-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useFileStore } from '@/stores/file-store'
import { useSuggestionScoresStore } from '@/stores/suggestion-scores-store'
import { getStorage } from '@/lib/storage'
import { clearPatientQueries } from '@/features/projects/warehouse/patient-data/patient-prefetch'

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
  database: (e) => useDataSourceStore.getState().applyRemoteChange(e.entityId, e.action === 'deleted'),
  etl_pipeline: (e) => useEtlStore.getState().applyRemoteChange(e.entityId, e.action === 'deleted'),
  etl_run: async (e) => {
    const etl = useEtlStore.getState()
    // The event carries no run status, so this clears on start and every update
    // too: dropping kept patient rows only costs a re-read. A script may write
    // through any role, the source included.
    const pipeline = etl.etlPipelines.find((p) => p.id === e.entityId)
      ?? await getStorage().etlPipelines.getById(e.entityId)
    // An empty id would clear every database's rows.
    for (const id of [pipeline?.sourceDataSourceId, pipeline?.targetDataSourceId]) if (id) clearPatientQueries(id)
    if (etl.activePipelineId === e.entityId) await etl.loadRunHistory(e.entityId)
  },
  sql_collection: (e) => useSqlScriptsStore.getState().applyRemoteChange(e.entityId, e.action === 'deleted'),
  wiki_page: async (e) => {
    const wiki = useWikiStore.getState()
    if (e.workspaceId && wiki.currentWorkspaceId === e.workspaceId) await wiki.loadPages(e.workspaceId)
  },
  user_plugin: () => usePluginEditorStore.getState().refreshPluginList(),
  schema_preset: async (e) => {
    if (e.workspaceId && useWorkspaceStore.getState().activeWorkspaceId === e.workspaceId) {
      await useSchemaPresetStore.getState().loadPresets(e.workspaceId)
    }
  },
  workspace: () => useWorkspaceStore.getState().loadWorkspaces(),
  project: () => useAppStore.getState().loadProjects(),
  data_catalog: async (e) => {
    const catalogs = useCatalogStore.getState()
    await catalogs.loadCatalogs()
    if (catalogs.resultCacheLoadedFor === e.entityId) await catalogs.loadResultCache(e.entityId)
  },
  dq_rule_set: async (e) => {
    const dq = useDqStore.getState()
    await dq.loadDqRuleSets()
    if (dq.activeRuleSetId === e.entityId && e.action !== 'deleted') await dq.loadRuleSetChecks(e.entityId)
  },
  dq_run: async (e) => {
    const dq = useDqStore.getState()
    if (dq.activeRuleSetId === e.entityId) await dq.loadRunHistory(e.entityId)
  },
  patient_board: async (e) => {
    const boards = usePatientChartStore.getState()
    if (!e.projectUid || boards.activeProjectUid !== e.projectUid) return
    // The loader skips a project it already holds: drop that before re-reading.
    usePatientChartStore.setState({ loaded: false })
    await boards.loadProjectDashboards(e.projectUid)
  },
  project_pipeline: () => usePipelineStore.getState().loadPipelines(),
  mapping_project: async (e) => {
    if (!e.notification?.detail?.part) await useConceptMappingStore.getState().loadMappingProjects()
    const mappings = useConceptMappingStore.getState()
    if (mappings.activeProjectId === e.entityId) await mappings.loadProjectMappings(e.entityId, { force: true })
    await useSuggestionScoresStore.getState().reindexProject(e.entityId)
  },
}

const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** The server keeps this many per user (`notification_service.MAX_KEPT`). */
const MAX_ITEMS = 200

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
/** The newest notification the user has seen marked read: a list read that was
 *  already in flight when they opened the bell must not bring those back unread. */
let readThrough = 0

const sendContext = () => {
  if (socket?.readyState === WebSocket.OPEN && lastContext) {
    socket.send(JSON.stringify({ type: 'ui-context', context: lastContext }))
  }
}

const countUnread = (items: AppNotification[]) => items.filter((n) => !n.readAt).length

export const useNotificationStore = create<NotificationState>((set, get) => {
  const reload = async () => {
    const items = (await listNotifications()).map((n) =>
      !n.readAt && Date.parse(n.createdAt) <= readThrough ? { ...n, readAt: new Date(readThrough).toISOString() } : n)
    set({ items, unread: countUnread(items) })
  }

  const open = () => {
    socket = openNotificationSocket({
      onOpen: sendContext,
      onEvent: (event) => {
        attempt = 0
        REFRESHERS[event.entityType]?.(event).catch((e) => console.warn('Remote change refresh failed', event.entityType, e))
        if (event.notification) {
          const items = [event.notification, ...get().items.filter((n) => n.id !== event.notification!.id)].slice(0, MAX_ITEMS)
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
      readThrough = 0
      clearTimeout(retryTimer)
      socket?.close()
      socket = null
    },

    markAllRead: async () => {
      if (get().unread === 0) return
      readThrough = Math.max(readThrough, ...get().items.map((n) => Date.parse(n.createdAt)))
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
