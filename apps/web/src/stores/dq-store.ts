import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { migrateEntityIds } from '@/lib/slugify-id'
import { localized, toLocalized } from '@/lib/localized'
import type { DqRuleSet, DqCustomCheck, DqRunHistoryEntry } from '@/types'
import type { DqReport } from '@/lib/duckdb/data-quality'
import { normalizeDqCheck } from '@/lib/dq-taxonomy'
import { usableExploreSql } from '@/lib/duckdb/data-quality-checks'

// Re-exported so existing imports (`from '@/stores/dq-store'`) keep working; the
// canonical definition now lives in @/types alongside the other DQ entities.
export type { DqRunHistoryEntry }

export type CheckQueryField = 'sql' | 'exploreSql'
type SavedQueries = Pick<DqCustomCheck, CheckQueryField>

/** A stored check with every field filled: rows written before the Kahn
 *  categories and the generated checks lack some. */
function readCheck(check: DqCustomCheck): DqCustomCheck {
  return normalizeDqCheck({
    ...check,
    subcategory: check.subcategory ?? null,
    exploreSql: check.exploreSql ?? null,
    origin: check.origin ?? 'manual',
    templateKey: check.templateKey ?? null,
    tableName: check.tableName ?? null,
    disabled: check.disabled ?? false,
  })
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

  // Check CRUD (scoped to active rule set)
  customChecks: DqCustomCheck[]
  customChecksLoaded: boolean
  activeRuleSetId: string | null
  loadRuleSetChecks: (ruleSetId: string) => Promise<void>
  createCustomCheck: (check: DqCustomCheck) => Promise<void>
  /** Writes a whole batch at once — a rule set generated from a schema starts with hundreds. */
  createCustomChecks: (checks: DqCustomCheck[]) => Promise<void>
  setChecksDisabled: (ids: string[], disabled: boolean) => Promise<void>
  /** The same change on several checks: a group renamed, checks moved to another. */
  updateChecks: (ids: string[], changes: Partial<DqCustomCheck>) => Promise<void>
  updateCustomCheck: (id: string, changes: Partial<DqCustomCheck>) => Promise<void>
  deleteCustomCheck: (id: string) => Promise<void>
  /** Several of the active rule set's checks, removed together: all or none. */
  deleteCustomChecks: (ids: string[]) => Promise<void>

  // Editor state
  selectedCheckId: string | null
  selectCheck: (id: string) => void
  /** Edits one of a check's two queries in memory; Save writes it, Cancel restores it. */
  updateCheckQuery: (id: string, field: CheckQueryField, value: string) => void

  // Dirty tracking: the saved queries of each check being edited
  _dirtyMap: Map<string, SavedQueries>
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

  // --- Custom check CRUD ---
  customChecks: [],
  customChecksLoaded: false,
  activeRuleSetId: null,

  loadRuleSetChecks: async (ruleSetId) => {
    const checks = await getStorage().dqCustomChecks.getByRuleSet(ruleSetId)
    set({
      customChecks: checks.map(readCheck).sort((a, b) => a.order - b.order),
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

  createCustomChecks: async (checks) => {
    if (!checks.length) return
    await getStorage().dqCustomChecks.createMany(checks[0].ruleSetId, checks)
    set((s) => (
      checks[0]?.ruleSetId === s.activeRuleSetId
        ? { customChecks: [...s.customChecks, ...checks].sort((a, b) => a.order - b.order) }
        : {}
    ))
  },

  setChecksDisabled: (ids, disabled) => get().updateChecks(ids, { disabled }),

  updateChecks: async (ids, changes) => {
    const ruleSetId = get().activeRuleSetId
    if (!ruleSetId || !ids.length) return
    // One transaction: a failure part-way used to leave some checks changed in
    // storage and none in the list.
    await getStorage().dqCustomChecks.updateMany(ruleSetId, ids.map((id) => ({ id, changes })))
    const targets = new Set(ids)
    set((s) => ({
      customChecks: s.customChecks.map((c) => (targets.has(c.id) ? { ...c, ...changes } : c)),
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

  deleteCustomChecks: async (ids) => {
    const ruleSetId = get().activeRuleSetId
    if (!ruleSetId || !ids.length) return
    await getStorage().dqCustomChecks.deleteMany(ruleSetId, ids)
    const gone = new Set(ids)
    set((s) => {
      const dirtyMap = new Map(s._dirtyMap)
      for (const id of ids) dirtyMap.delete(id)
      return {
        customChecks: s.customChecks.filter((c) => !gone.has(c.id)),
        selectedCheckId: s.selectedCheckId && gone.has(s.selectedCheckId) ? null : s.selectedCheckId,
        _dirtyMap: dirtyMap,
      }
    })
  },

  // --- Editor state ---
  selectedCheckId: null,

  selectCheck: (id) => {
    set({ selectedCheckId: id })
  },

  updateCheckQuery: (id, field, value) => {
    set((s) => {
      const dirtyMap = new Map(s._dirtyMap)
      const check = s.customChecks.find((c) => c.id === id)
      if (!dirtyMap.has(id) && check) {
        dirtyMap.set(id, { sql: check.sql, exploreSql: check.exploreSql })
      }
      return {
        customChecks: s.customChecks.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
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
    const saved = s._dirtyMap.get(id)!
    return check?.sql !== saved.sql || (check?.exploreSql || null) !== (saved.exploreSql || null)
  },

  saveCheck: async (id) => {
    const check = get().customChecks.find((c) => c.id === id)
    if (!check) return
    await getStorage().dqCustomChecks.update(id, { sql: check.sql, exploreSql: usableExploreSql(check) })
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
        customChecks: s.customChecks.map((c) => (c.id === id ? { ...c, ...original } : c)),
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
