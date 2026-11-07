import { apiRequest } from '@/lib/api-client'
import type {
  DashboardStorage,
  DashboardTabStorage,
  DashboardWidgetStorage,
} from '@/lib/storage'
import type { Dashboard, DashboardTab, DashboardWidget } from '@/types'

const DASHBOARDS = '/dashboards'

/**
 * Server-mode dashboard storage. Dashboards are project-scoped; their tabs and
 * widgets are flat and keyed by parent id (dashboardId / tabId), mirroring the
 * front-only IndexedDB object stores so the dashboard store is unchanged.
 */
export const apiDashboardStorage: DashboardStorage = {
  getByProject: (projectUid) =>
    apiRequest<Dashboard[]>(
      `${DASHBOARDS}?projectUid=${encodeURIComponent(projectUid)}`,
    ),

  getById: async (id) => {
    try {
      return await apiRequest<Dashboard>(`${DASHBOARDS}/${encodeURIComponent(id)}`)
    } catch {
      return undefined
    }
  },

  create: async (dashboard) => {
    await apiRequest(DASHBOARDS, { method: 'POST', body: JSON.stringify(dashboard) })
  },

  update: async (id, changes) => {
    await apiRequest(`${DASHBOARDS}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`${DASHBOARDS}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
}

export const apiDashboardTabStorage: DashboardTabStorage = {
  getByDashboard: (dashboardId) =>
    apiRequest<DashboardTab[]>(`${DASHBOARDS}/${encodeURIComponent(dashboardId)}/tabs`),

  getById: async (id) => {
    try {
      return await apiRequest<DashboardTab>(`${DASHBOARDS}/tabs/${encodeURIComponent(id)}`)
    } catch {
      return undefined
    }
  },

  create: async (tab) => {
    await apiRequest(`${DASHBOARDS}/tabs`, { method: 'POST', body: JSON.stringify(tab) })
  },

  update: async (id, changes) => {
    await apiRequest(`${DASHBOARDS}/tabs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`${DASHBOARDS}/tabs/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  deleteByDashboard: async (dashboardId) => {
    await apiRequest(`${DASHBOARDS}/${encodeURIComponent(dashboardId)}/tabs`, { method: 'DELETE' })
  },
}

export const apiDashboardWidgetStorage: DashboardWidgetStorage = {
  getByTab: (tabId) =>
    apiRequest<DashboardWidget[]>(`${DASHBOARDS}/tabs/${encodeURIComponent(tabId)}/widgets`),

  getById: async (id) => {
    try {
      return await apiRequest<DashboardWidget>(`${DASHBOARDS}/widgets/${encodeURIComponent(id)}`)
    } catch {
      return undefined
    }
  },

  create: async (widget) => {
    await apiRequest(`${DASHBOARDS}/widgets`, {
      method: 'POST',
      body: JSON.stringify(widget),
    })
  },

  update: async (id, changes) => {
    await apiRequest(`${DASHBOARDS}/widgets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`${DASHBOARDS}/widgets/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  deleteByTab: async (tabId) => {
    await apiRequest(`${DASHBOARDS}/tabs/${encodeURIComponent(tabId)}/widgets`, { method: 'DELETE' })
  },
}
