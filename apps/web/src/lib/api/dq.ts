import { apiRequest } from '@/lib/api-client'
import type { DqCustomCheckStorage, DqRuleSetStorage, DqRunHistoryStorage } from '@/lib/storage'
import type { DqCustomCheck, DqRuleSet, DqRunHistoryEntry } from '@/types'

const SET = '/dq-rule-sets'
const CHECK = '/dq-custom-checks'
const RUN = '/dq-run-history'

/** Server-mode DQ rule set storage (workspace-scoped metadata). */
export const apiDqRuleSetStorage: DqRuleSetStorage = {
  getAll: () => apiRequest<DqRuleSet[]>(SET),

  getByWorkspace: (workspaceId) =>
    apiRequest<DqRuleSet[]>(`${SET}?workspaceId=${encodeURIComponent(workspaceId)}`),

  getById: async (id) => {
    try {
      return await apiRequest<DqRuleSet>(`${SET}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (ruleSet) => {
    await apiRequest(SET, { method: 'POST', body: JSON.stringify(ruleSet) })
  },

  update: async (id, changes) => {
    await apiRequest(`${SET}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${SET}/${id}`, { method: 'DELETE' })
  },
}

/** Server-mode DQ custom check storage (a rule set's checks). */
export const apiDqCustomCheckStorage: DqCustomCheckStorage = {
  getByRuleSet: (ruleSetId) =>
    apiRequest<DqCustomCheck[]>(`${SET}/${ruleSetId}/checks`),

  getById: async (id) => {
    // No single-check GET endpoint; callers resolve checks via getByRuleSet.
    void id
    return undefined
  },

  create: async (check) => {
    await apiRequest(CHECK, { method: 'POST', body: JSON.stringify(check) })
  },

  update: async (id, changes) => {
    await apiRequest(`${CHECK}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${CHECK}/${id}`, { method: 'DELETE' })
  },

  deleteByRuleSet: async (ruleSetId) => {
    await apiRequest(`${SET}/${ruleSetId}/checks`, { method: 'DELETE' })
  },
}

/** Server-mode DQ scan-run history storage (a rule set's past runs). */
export const apiDqRunHistoryStorage: DqRunHistoryStorage = {
  getByRuleSet: (ruleSetId) =>
    apiRequest<DqRunHistoryEntry[]>(`${SET}/${ruleSetId}/runs`),

  create: async (entry) => {
    await apiRequest(RUN, { method: 'POST', body: JSON.stringify(entry) })
  },

  update: async (id, changes) => {
    await apiRequest(`${RUN}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${RUN}/${id}`, { method: 'DELETE' })
  },

  deleteByRuleSet: async (ruleSetId) => {
    await apiRequest(`${SET}/${ruleSetId}/runs`, { method: 'DELETE' })
  },
}
