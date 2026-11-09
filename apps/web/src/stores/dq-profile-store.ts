import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { loadKeyedChecks } from '@/stores/dq-store'
import type { DqCustomCheck, DqProfile, DqRunHistoryEntry } from '@/types'

interface DqProfileState {
  profiles: DqProfile[]
  profilesLoaded: boolean
  loadProfiles: () => Promise<void>
  createProfile: (profile: DqProfile) => Promise<void>
  updateProfile: (id: string, changes: Partial<DqProfile>) => Promise<void>
  deleteProfile: (id: string) => Promise<void>

  /** The checks of the rule sets a profile page shows, by rule set id. */
  checksByRuleSet: Record<string, DqCustomCheck[]>
  loadRuleSetChecks: (ruleSetIds: string[]) => Promise<void>

  // Run history of the profile whose page is open
  runHistory: DqRunHistoryEntry[]
  runHistoryProfileId: string | null
  loadRunHistory: (profileId: string) => Promise<void>
  addRunHistory: (entry: DqRunHistoryEntry) => Promise<void>
  deleteRunHistory: (id: string) => Promise<void>
  clearRunHistory: (profileId: string) => Promise<void>
}

export const useDqProfileStore = create<DqProfileState>((set) => ({
  profiles: [],
  profilesLoaded: false,

  loadProfiles: async () => {
    set({ profiles: await getStorage().dqProfiles.getAll(), profilesLoaded: true })
  },

  createProfile: async (profile) => {
    await getStorage().dqProfiles.create(profile)
    set((s) => ({ profiles: [...s.profiles, profile] }))
  },

  updateProfile: async (id, changes) => {
    await getStorage().dqProfiles.update(id, changes)
    set((s) => ({
      profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...changes, updatedAt: new Date().toISOString() } : p)),
    }))
  },

  deleteProfile: async (id) => {
    await getStorage().dqProfiles.delete(id)
    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
      ...(s.runHistoryProfileId === id ? { runHistory: [], runHistoryProfileId: null } : {}),
    }))
  },

  checksByRuleSet: {},

  loadRuleSetChecks: async (ruleSetIds) => {
    const loaded = await Promise.all(ruleSetIds.map(async (id) => [id, await loadKeyedChecks(id)] as const))
    set((s) => ({ checksByRuleSet: { ...s.checksByRuleSet, ...Object.fromEntries(loaded) } }))
  },

  runHistory: [],
  runHistoryProfileId: null,

  loadRunHistory: async (profileId) => {
    const entries = await getStorage().dqRunHistory.getByProfile(profileId)
    entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    set({ runHistory: entries, runHistoryProfileId: profileId })
  },

  addRunHistory: async (entry) => {
    await getStorage().dqRunHistory.create(entry)
    set((s) => (entry.profileId === s.runHistoryProfileId ? { runHistory: [entry, ...s.runHistory] } : {}))
  },

  deleteRunHistory: async (id) => {
    await getStorage().dqRunHistory.delete(id)
    set((s) => ({ runHistory: s.runHistory.filter((e) => e.id !== id) }))
  },

  clearRunHistory: async (profileId) => {
    await getStorage().dqRunHistory.deleteByProfile(profileId)
    set((s) => (profileId === s.runHistoryProfileId ? { runHistory: [] } : {}))
  },
}))
