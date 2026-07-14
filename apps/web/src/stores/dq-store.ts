import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { migrateEntityIds } from '@/lib/slugify-id'
import { localized, toLocalized } from '@/lib/localized'
import type { DqRuleSet, DqCustomCheck, DqRunHistoryEntry } from '@/types'
import type { DqReport } from '@/lib/duckdb/data-quality'

// Re-exported so existing imports (`from '@/stores/dq-store'`) keep working; the
// canonical definition now lives in @/types alongside the other DQ entities.
export type { DqRunHistoryEntry }

// --- Store interface ---

interface DqState {
  // Rule set CRUD
  dqRuleSets: DqRuleSet[]
  dqRuleSetsLoaded: boolean
  loadDqRuleSets: () => Promise<void>
  getWorkspaceRuleSets: (workspaceId: string) => DqRuleSet[]
  createRuleSet: (ruleSet: DqRuleSet) => Promise<void>
  updateRuleSet: (id: string, changes: Partial<DqRuleSet>) => Promise<void>
  deleteRuleSet: (id: string) => Promise<void>
  /** Enable/disable one or more checks (custom or built-in) for a rule set. */
  setChecksDisabled: (ruleSetId: string, checkIds: string[], disabled: boolean) => Promise<void>

  // Custom check CRUD (scoped to active rule set)
  customChecks: DqCustomCheck[]
  customChecksLoaded: boolean
  activeRuleSetId: string | null
  loadRuleSetChecks: (ruleSetId: string) => Promise<void>
  createCustomCheck: (check: DqCustomCheck) => Promise<void>
  updateCustomCheck: (id: string, changes: Partial<DqCustomCheck>) => Promise<void>
  deleteCustomCheck: (id: string) => Promise<void>

  // Editor state
  selectedCheckId: string | null
  selectCheck: (id: string) => void
  updateCheckSql: (id: string, sql: string) => void

  // Dirty tracking
  _dirtyMap: Map<string, string>
  _dirtyVersion: number
  isCheckDirty: (id: string) => boolean
  saveCheck: (id: string) => Promise<void>
  revertCheck: (id: string) => void

  // Scan state
  scanRunning: boolean
  scanProgress: { done: number; total: number }
  currentReport: DqReport | null
  startScan: () => void
  updateScanProgress: (done: number, total: number) => void
  finishScan: (report: DqReport) => void
  failScan: () => void

  // Run history (persisted per rule set; loaded on demand)
  runHistory: DqRunHistoryEntry[]
  runHistoryRuleSetId: string | null
  loadRunHistory: (ruleSetId: string) => Promise<void>
  addRunHistory: (entry: DqRunHistoryEntry) => Promise<void>
  updateRunHistory: (id: string, changes: Partial<DqRunHistoryEntry>) => Promise<void>
  deleteRunHistory: (id: string) => Promise<void>
  clearRunHistory: (ruleSetId: string) => Promise<void>
}

export const useDqStore = create<DqState>((set, get) => ({
  // --- Rule set CRUD ---
  dqRuleSets: [],
  dqRuleSetsLoaded: false,

  loadDqRuleSets: async () => {
    const storage = getStorage()
    const all = await storage.dqRuleSets.getAll()
    for (const r of migrateEntityIds(all, e => localized(e.name, 'en'))) {
      storage.dqRuleSets.update(r.id, { entityId: r.entityId }).catch(() => {})
    }
    // Backfill legacy plain-string name/description into LocalizedString.
    for (const r of all) {
      if (typeof r.name === 'string' || typeof r.description === 'string') {
        r.name = toLocalized(r.name)
        r.description = toLocalized(r.description)
        storage.dqRuleSets.update(r.id, { name: r.name, description: r.description }).catch(() => {})
      }
    }
    set({ dqRuleSets: all, dqRuleSetsLoaded: true })
  },

  getWorkspaceRuleSets: (workspaceId) =>
    get().dqRuleSets.filter((s) => s.workspaceId === workspaceId),

  createRuleSet: async (ruleSet) => {
    await getStorage().dqRuleSets.create(ruleSet)
    set((s) => ({ dqRuleSets: [...s.dqRuleSets, ruleSet] }))
  },

  updateRuleSet: async (id, changes) => {
    await getStorage().dqRuleSets.update(id, changes)
    set((s) => ({
      dqRuleSets: s.dqRuleSets.map((rs) =>
        rs.id === id ? { ...rs, ...changes, updatedAt: new Date().toISOString() } : rs,
      ),
    }))
  },

  deleteRuleSet: async (id) => {
    await getStorage().dqCustomChecks.deleteByRuleSet(id)
    await getStorage().dqRuleSets.delete(id)
    set((s) => ({
      dqRuleSets: s.dqRuleSets.filter((rs) => rs.id !== id),
      customChecks: s.activeRuleSetId === id ? [] : s.customChecks,
      activeRuleSetId: s.activeRuleSetId === id ? null : s.activeRuleSetId,
    }))
  },

  setChecksDisabled: async (ruleSetId, checkIds, disabled) => {
    const rs = get().dqRuleSets.find((r) => r.id === ruleSetId)
    if (!rs) return
    const current = new Set(rs.disabledCheckIds ?? [])
    for (const id of checkIds) {
      if (disabled) current.add(id)
      else current.delete(id)
    }
    await get().updateRuleSet(ruleSetId, { disabledCheckIds: [...current] })
  },

  // --- Custom check CRUD ---
  customChecks: [],
  customChecksLoaded: false,
  activeRuleSetId: null,

  loadRuleSetChecks: async (ruleSetId) => {
    const checks = await getStorage().dqCustomChecks.getByRuleSet(ruleSetId)
    set({
      customChecks: checks.sort((a, b) => a.order - b.order),
      customChecksLoaded: true,
      activeRuleSetId: ruleSetId,
      _dirtyMap: new Map(),
      _dirtyVersion: 0,
    })
  },

  createCustomCheck: async (check) => {
    await getStorage().dqCustomChecks.create(check)
    set((s) => ({
      customChecks: [...s.customChecks, check].sort((a, b) => a.order - b.order),
    }))
  },

  updateCustomCheck: async (id, changes) => {
    await getStorage().dqCustomChecks.update(id, changes)
    set((s) => ({
      customChecks: s.customChecks.map((c) => (c.id === id ? { ...c, ...changes } : c)),
    }))
  },

  deleteCustomCheck: async (id) => {
    await getStorage().dqCustomChecks.delete(id)
    set((s) => {
      const newDirtyMap = new Map(s._dirtyMap)
      newDirtyMap.delete(id)
      return {
        customChecks: s.customChecks.filter((c) => c.id !== id),
        selectedCheckId: s.selectedCheckId === id ? null : s.selectedCheckId,
        _dirtyMap: newDirtyMap,
      }
    })
  },

  // --- Editor state ---
  selectedCheckId: null,

  selectCheck: (id) => {
    set({ selectedCheckId: id })
  },

  updateCheckSql: (id, sql) => {
    set((s) => {
      const dirtyMap = new Map(s._dirtyMap)
      const check = s.customChecks.find((c) => c.id === id)
      if (!dirtyMap.has(id) && check) {
        dirtyMap.set(id, check.sql)
      }
      return {
        customChecks: s.customChecks.map((c) => (c.id === id ? { ...c, sql } : c)),
        _dirtyMap: dirtyMap,
        _dirtyVersion: s._dirtyVersion + 1,
      }
    })
  },

  // --- Dirty tracking ---
  _dirtyMap: new Map(),
  _dirtyVersion: 0,

  isCheckDirty: (id) => {
    const s = get()
    if (!s._dirtyMap.has(id)) return false
    const check = s.customChecks.find((c) => c.id === id)
    return check?.sql !== s._dirtyMap.get(id)
  },

  saveCheck: async (id) => {
    const check = get().customChecks.find((c) => c.id === id)
    if (!check) return
    await getStorage().dqCustomChecks.update(id, { sql: check.sql })
    set((s) => {
      const dirtyMap = new Map(s._dirtyMap)
      dirtyMap.delete(id)
      return { _dirtyMap: dirtyMap, _dirtyVersion: s._dirtyVersion + 1 }
    })
  },

  revertCheck: (id) => {
    const original = get()._dirtyMap.get(id)
    if (original === undefined) return
    set((s) => {
      const dirtyMap = new Map(s._dirtyMap)
      dirtyMap.delete(id)
      return {
        customChecks: s.customChecks.map((c) => (c.id === id ? { ...c, sql: original } : c)),
        _dirtyMap: dirtyMap,
        _dirtyVersion: s._dirtyVersion + 1,
      }
    })
  },

  // --- Scan state ---
  scanRunning: false,
  scanProgress: { done: 0, total: 0 },
  currentReport: null,

  startScan: () => {
    set({ scanRunning: true, scanProgress: { done: 0, total: 0 }, currentReport: null })
  },

  updateScanProgress: (done, total) => {
    set({ scanProgress: { done, total } })
  },

  finishScan: (report) => {
    set({ scanRunning: false, currentReport: report })
  },

  failScan: () => {
    set({ scanRunning: false })
  },

  // --- Run history (persisted per rule set) ---
  runHistory: [],
  runHistoryRuleSetId: null,

  loadRunHistory: async (ruleSetId) => {
    const entries = await getStorage().dqRunHistory.getByRuleSet(ruleSetId)
    // Newest first.
    entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    set({ runHistory: entries, runHistoryRuleSetId: ruleSetId })
  },

  addRunHistory: async (entry) => {
    await getStorage().dqRunHistory.create(entry)
    set((s) => (
      entry.ruleSetId === s.runHistoryRuleSetId
        ? { runHistory: [entry, ...s.runHistory] }
        : {}
    ))
  },

  updateRunHistory: async (id, changes) => {
    await getStorage().dqRunHistory.update(id, changes)
    set((s) => ({
      runHistory: s.runHistory.map((e) => (e.id === id ? { ...e, ...changes } : e)),
    }))
  },

  deleteRunHistory: async (id) => {
    await getStorage().dqRunHistory.delete(id)
    set((s) => ({ runHistory: s.runHistory.filter((e) => e.id !== id) }))
  },

  clearRunHistory: async (ruleSetId) => {
    await getStorage().dqRunHistory.deleteByRuleSet(ruleSetId)
    set((s) => (ruleSetId === s.runHistoryRuleSetId ? { runHistory: [] } : {}))
  },
}))
