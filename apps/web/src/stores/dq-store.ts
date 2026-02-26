import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { DqRuleSet, DqCustomCheck } from '@/types'
import type { DqReport } from '@/lib/duckdb/data-quality'

// --- Run history type (in-memory only) ---

export interface DqRunHistoryEntry {
  id: string
  ruleSetId?: string
  dataSourceId: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'success' | 'error'
  score?: number
  totalChecks: number
  passed: number
  failed: number
  errors: number
  notApplicable: number
  durationMs?: number
}

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

  // Run history (in-memory, capped at 50)
  runHistory: DqRunHistoryEntry[]
  addRunHistory: (entry: DqRunHistoryEntry) => void
  updateRunHistory: (id: string, changes: Partial<DqRunHistoryEntry>) => void
  clearRunHistory: () => void
}

export const useDqStore = create<DqState>((set, get) => ({
  // --- Rule set CRUD ---
  dqRuleSets: [],
  dqRuleSetsLoaded: false,

  loadDqRuleSets: async () => {
    const all = await getStorage().dqRuleSets.getAll()
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

  // --- Run history ---
  runHistory: [],

  addRunHistory: (entry) => {
    set((s) => ({
      runHistory: [entry, ...s.runHistory].slice(0, 50),
    }))
  },

  updateRunHistory: (id, changes) => {
    set((s) => ({
      runHistory: s.runHistory.map((e) => (e.id === id ? { ...e, ...changes } : e)),
    }))
  },

  clearRunHistory: () => {
    set({ runHistory: [] })
  },
}))
