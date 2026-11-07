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
      return await apiRequest<DqRuleSet>(`${SET}/${encodeURIComponent(id)}`)
    } catch {
      return undefined
    }
  },

  create: async (ruleSet) => {
    await apiRequest(SET, { method: 'POST', body: JSON.stringify(ruleSet) })
  },

  update: async (id, changes) => {
    await apiRequest(`${SET}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${SET}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
}

/** Server-mode DQ custom check storage (a rule set's checks). */
export const apiDqCustomCheckStorage: DqCustomCheckStorage = {
  getByRuleSet: (ruleSetId) =>
    apiRequest<DqCustomCheck[]>(`${SET}/${encodeURIComponent(ruleSetId)}/checks`),

  getById: async (id) => {
    // No single-check GET endpoint; callers resolve checks via getByRuleSet.
    void id
    return undefined
  },

  create: async (check) => {
    await apiRequest(CHECK, { method: 'POST', body: JSON.stringify(check) })
  },

  createMany: async (ruleSetId, checks) => {
    await apiRequest(`${SET}/${encodeURIComponent(ruleSetId)}/checks`, { method: 'POST', body: JSON.stringify(checks) })
  },

  replaceByRuleSet: async (ruleSetId, checks) => {
    await apiRequest(`${SET}/${encodeURIComponent(ruleSetId)}/checks`, { method: 'PUT', body: JSON.stringify(checks) })
  },

  update: async (id, changes) => {
    await apiRequest(`${CHECK}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  updateMany: async (ruleSetId, patches) => {
    await apiRequest(`${SET}/${encodeURIComponent(ruleSetId)}/checks`, {
      method: 'PATCH',
      body: JSON.stringify(patches.map(({ id, changes }) => ({ ...changes, id }))),
    })
  },

  delete: async (id) => {
    await apiRequest(`${CHECK}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  deleteMany: async (ruleSetId, ids) => {
    await apiRequest(`${SET}/${encodeURIComponent(ruleSetId)}/checks/batch-delete`, { method: 'POST', body: JSON.stringify({ ids }) })
  },

  deleteByRuleSet: async (ruleSetId) => {
    await apiRequest(`${SET}/${encodeURIComponent(ruleSetId)}/checks`, { method: 'DELETE' })
  },
}

/** Server-mode DQ scan-run history storage (a rule set's past runs). */
export const apiDqRunHistoryStorage: DqRunHistoryStorage = {
  getByRuleSet: (ruleSetId) =>
    apiRequest<DqRunHistoryEntry[]>(`${SET}/${encodeURIComponent(ruleSetId)}/runs`),

  create: async (entry) => {
    await apiRequest(RUN, { method: 'POST', body: JSON.stringify(entry) })
  },

  update: async (id, changes) => {
    await apiRequest(`${RUN}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${RUN}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  deleteByRuleSet: async (ruleSetId) => {
    await apiRequest(`${SET}/${encodeURIComponent(ruleSetId)}/runs`, { method: 'DELETE' })
  },
}
