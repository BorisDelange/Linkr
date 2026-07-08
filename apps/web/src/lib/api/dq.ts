import { apiRequest } from '@/lib/api-client'
import type { DqCustomCheckStorage, DqRuleSetStorage } from '@/lib/storage'
import type { DqCustomCheck, DqRuleSet } from '@/types'

const SET = '/dq-rule-sets'
const CHECK = '/dq-custom-checks'

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
