import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeEvent } from '@/lib/api/notifications'

/**
 * A pipeline run started elsewhere (an agent, another tab) rewrites its
 * databases: the patient rows this tab kept for them must go.
 */

const handlers: { onEvent?: (e: ChangeEvent) => void } = {}
const cleared: (string | undefined)[] = []

vi.mock('@/lib/api/notifications', () => ({
  listNotifications: async () => [],
  markNotificationsRead: async () => {},
  clearNotifications: async () => {},
  undoNotification: async () => {},
  openNotificationSocket: (h: { onEvent: (e: ChangeEvent) => void }) => {
    handlers.onEvent = h.onEvent
    return { close: () => {}, readyState: 0 } as unknown as WebSocket
  },
}))
vi.mock('@/features/projects/warehouse/patient-data/patient-prefetch', () => ({
  clearPatientQueries: (id?: string) => { cleared.push(id) },
}))

const { useNotificationStore } = await import('./notification-store')
const { useEtlStore } = await import('./etl-store')
const { initStorage } = await import('@/lib/storage')

const runEvent = (entityId: string): ChangeEvent =>
  ({ type: 'change', action: 'updated', entityType: 'etl_run', entityId, projectUid: null })

describe('notification store: an ETL run made elsewhere', () => {
  beforeEach(() => {
    cleared.length = 0
    initStorage({
      etlPipelines: {
        getById: async (id: string) => (id === 'stored' ? { id, sourceDataSourceId: 'src2', targetDataSourceId: '' } : undefined),
      },
    } as unknown as Parameters<typeof initStorage>[0])
    useEtlStore.setState({
      etlPipelines: [{ id: 'p1', sourceDataSourceId: 'src', targetDataSourceId: 'tgt' }] as never,
      activePipelineId: null,
    })
    useNotificationStore.getState().disconnect()
    useNotificationStore.getState().connect()
  })

  it('clears the kept patient rows of its source and target', async () => {
    handlers.onEvent!(runEvent('p1'))
    await vi.waitFor(() => expect(cleared).toEqual(['src', 'tgt']))
  })

  it('reads a pipeline the store does not hold, and never clears every database', async () => {
    handlers.onEvent!(runEvent('stored'))
    await vi.waitFor(() => expect(cleared).toEqual(['src2']))
    handlers.onEvent!(runEvent('unknown'))
    await new Promise((r) => setTimeout(r, 0))
    expect(cleared).toEqual(['src2'])
  })
})
