import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { ConceptList } from '@/types'

interface ConceptListState {
  conceptLists: ConceptList[]
  loaded: boolean
  /** Active list per project — where the "+" button adds concepts. */
  activeListIdByProject: Record<string, string | undefined>

  loadConceptLists: () => Promise<void>
  getProjectConceptLists: (projectUid: string) => ConceptList[]
  createConceptList: (list: ConceptList) => Promise<void>
  updateConceptList: (id: string, changes: Partial<ConceptList>) => Promise<void>
  deleteConceptList: (id: string) => Promise<void>
  setActiveListId: (projectUid: string, listId: string | undefined) => void
}

export const useConceptListStore = create<ConceptListState>((set, get) => ({
  conceptLists: [],
  loaded: false,
  activeListIdByProject: {},

  loadConceptLists: async () => {
    const all = await getStorage().conceptLists.getAll()
    set({ conceptLists: all, loaded: true })
  },

  getProjectConceptLists: (projectUid) =>
    get().conceptLists.filter((l) => l.projectUid === projectUid),

  createConceptList: async (list) => {
    await getStorage().conceptLists.create(list)
    set((s) => ({
      conceptLists: [...s.conceptLists, list],
      // A freshly created list becomes the one the "+" fills.
      activeListIdByProject: { ...s.activeListIdByProject, [list.projectUid]: list.id },
    }))
  },

  updateConceptList: async (id, changes) => {
    await getStorage().conceptLists.update(id, changes)
    set((s) => ({
      conceptLists: s.conceptLists.map((l) =>
        l.id === id ? { ...l, ...changes, updatedAt: new Date().toISOString() } : l,
      ),
    }))
  },

  deleteConceptList: async (id) => {
    await getStorage().conceptLists.delete(id)
    set((s) => {
      // Drop the active pointer wherever it referenced the deleted list.
      const active = { ...s.activeListIdByProject }
      for (const [projectUid, listId] of Object.entries(active)) {
        if (listId === id) active[projectUid] = undefined
      }
      return { conceptLists: s.conceptLists.filter((l) => l.id !== id), activeListIdByProject: active }
    })
  },

  setActiveListId: (projectUid, listId) =>
    set((s) => ({
      activeListIdByProject: { ...s.activeListIdByProject, [projectUid]: listId },
    })),
}))
