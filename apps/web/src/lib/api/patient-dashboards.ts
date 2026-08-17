import { apiRequest } from '@/lib/api-client'
import type {
  PatientDashboardStorage,
  PatientDashboardTabStorage,
  PatientDashboardWidgetStorage,
} from '@/lib/storage'
import type {
  PatientDashboard,
  PatientDashboardTab,
  PatientDashboardWidget,
} from '@/types'

const BOARDS = '/patient-dashboards'

/**
 * Server-mode patient-dashboard storage. Boards are project-scoped; their tabs and
 * widgets are flat and keyed by parent id (patientDashboardId / tabId), mirroring
 * the front-only IndexedDB object stores so the store is unchanged.
 */
export const apiPatientDashboardStorage: PatientDashboardStorage = {
  getByProject: (projectUid) =>
    apiRequest<PatientDashboard[]>(
      `${BOARDS}?projectUid=${encodeURIComponent(projectUid)}`,
    ),

  getById: async (id) => {
    try {
      return await apiRequest<PatientDashboard>(`${BOARDS}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (dashboard) => {
    await apiRequest(BOARDS, { method: 'POST', body: JSON.stringify(dashboard) })
  },

  update: async (id, changes) => {
    await apiRequest(`${BOARDS}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`${BOARDS}/${id}`, { method: 'DELETE' })
  },
}

export const apiPatientDashboardTabStorage: PatientDashboardTabStorage = {
  getByDashboard: (patientDashboardId) =>
    apiRequest<PatientDashboardTab[]>(`${BOARDS}/${patientDashboardId}/tabs`),

  getById: async (id) => {
    try {
      return await apiRequest<PatientDashboardTab>(`${BOARDS}/tabs/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (tab) => {
    await apiRequest(`${BOARDS}/tabs`, { method: 'POST', body: JSON.stringify(tab) })
  },

  update: async (id, changes) => {
    await apiRequest(`${BOARDS}/tabs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`${BOARDS}/tabs/${id}`, { method: 'DELETE' })
  },

  deleteByDashboard: async (patientDashboardId) => {
    await apiRequest(`${BOARDS}/${patientDashboardId}/tabs`, { method: 'DELETE' })
  },
}

export const apiPatientDashboardWidgetStorage: PatientDashboardWidgetStorage = {
  getByTab: (tabId) =>
    apiRequest<PatientDashboardWidget[]>(`${BOARDS}/tabs/${tabId}/widgets`),

  getById: async (id) => {
    try {
      return await apiRequest<PatientDashboardWidget>(`${BOARDS}/widgets/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (widget) => {
    await apiRequest(`${BOARDS}/widgets`, {
      method: 'POST',
      body: JSON.stringify(widget),
    })
  },

  update: async (id, changes) => {
    await apiRequest(`${BOARDS}/widgets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`${BOARDS}/widgets/${id}`, { method: 'DELETE' })
  },

  deleteByTab: async (tabId) => {
    await apiRequest(`${BOARDS}/tabs/${tabId}/widgets`, { method: 'DELETE' })
  },
}
