import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { SuggestionScore } from '@/types'

interface SuggestionScoresState {
  scores: SuggestionScore[]
  loaded: boolean
  activeProjectId: string | null

  loadProjectScores: (projectId: string, options?: { force?: boolean }) => Promise<void>
  importScores: (projectId: string, incoming: Omit<SuggestionScore, 'id' | 'importedAt' | 'projectId'>[]) => Promise<{ added: number; replaced: number }>
  deleteProjectScores: (projectId: string) => Promise<void>
}

function scoreId(s: Pick<SuggestionScore, 'projectId' | 'sourceVocabularyId' | 'sourceConceptCode' | 'conceptId' | 'method'>): string {
  return `${s.projectId}__${s.sourceVocabularyId}__${s.sourceConceptCode}__${s.conceptId}__${s.method}`
}

export const useSuggestionScoresStore = create<SuggestionScoresState>((set, get) => ({
  scores: [],
  loaded: false,
  activeProjectId: null,

  async loadProjectScores(projectId, options) {
    if (get().activeProjectId === projectId && get().loaded && !options?.force) return
    const scores = await getStorage().suggestionScores.getByProject(projectId)
    set({ scores, loaded: true, activeProjectId: projectId })
  },

  async importScores(projectId, incoming) {
    const now = new Date().toISOString()
    const existing = await getStorage().suggestionScores.getByProject(projectId)
    const existingById = new Map(existing.map((s) => [s.id, s]))

    let added = 0
    let replaced = 0
    const toUpsert: SuggestionScore[] = []

    for (const row of incoming) {
      const key = { projectId, sourceVocabularyId: row.sourceVocabularyId, sourceConceptCode: row.sourceConceptCode, conceptId: row.conceptId, method: row.method }
      const id = scoreId(key)
      const full: SuggestionScore = { id, projectId, importedAt: now, ...row }
      if (existingById.has(id)) {
        const prev = existingById.get(id)!
        if (prev.score !== row.score) {
          toUpsert.push(full)
          replaced++
        }
      } else {
        toUpsert.push(full)
        added++
      }
    }

    if (toUpsert.length > 0) {
      await getStorage().suggestionScores.upsertBatch(toUpsert)
      const updated = await getStorage().suggestionScores.getByProject(projectId)
      set({ scores: updated })
    }

    return { added, replaced }
  },

  async deleteProjectScores(projectId) {
    await getStorage().suggestionScores.deleteByProject(projectId)
    if (get().activeProjectId === projectId) {
      set({ scores: [], loaded: false })
    }
  },
}))
