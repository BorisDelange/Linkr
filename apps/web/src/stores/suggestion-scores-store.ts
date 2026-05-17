import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { ScoresIndex } from '@/types'
import { validateScoresFile, type ParsedScoreRow } from '@/lib/concept-mapping/scores-parser'
import { saveScoresFile, deleteScoresFile } from '@/lib/concept-mapping/scores-storage'
import { buildIndex, queryScoresForSource, unregisterProject } from '@/lib/concept-mapping/scores-engine'

interface SuggestionScoresState {
  activeProjectId: string | null
  index: ScoresIndex | null
  loaded: boolean

  loadProjectMeta: (projectId: string) => Promise<void>
  importScores: (projectId: string, file: File) => Promise<ScoresIndex>
  deleteProjectScores: (projectId: string) => Promise<void>

  hasSuggestionsFor: (vocabId: string, code: string) => boolean
  queryScoresForSource: (vocabId: string, code: string) => Promise<ParsedScoreRow[]>
}

export const useSuggestionScoresStore = create<SuggestionScoresState>((set, get) => ({
  activeProjectId: null,
  index: null,
  loaded: false,

  async loadProjectMeta(projectId) {
    if (get().activeProjectId === projectId && get().loaded) return
    const index = await getStorage().scoresMeta.get(projectId) ?? null
    set({ activeProjectId: projectId, index, loaded: true })
  },

  async importScores(projectId, file) {
    const validation = await validateScoresFile(file)
    if (!validation.ok) throw new Error(validation.error)

    await saveScoresFile(projectId, file)
    await unregisterProject(projectId)

    const index = await buildIndex(projectId)
    if (!index) throw new Error('Failed to build scores index after save.')

    await getStorage().scoresMeta.put(index)
    set({ activeProjectId: projectId, index, loaded: true })
    return index
  },

  async deleteProjectScores(projectId) {
    await unregisterProject(projectId)
    await deleteScoresFile(projectId)
    await getStorage().scoresMeta.delete(projectId)
    if (get().activeProjectId === projectId) {
      set({ index: null, loaded: true })
    }
  },

  hasSuggestionsFor(vocabId, code) {
    const idx = get().index
    if (!idx) return false
    return idx.sourceKeys.has(`${vocabId}::${code}`)
  },

  async queryScoresForSource(vocabId, code) {
    const projectId = get().activeProjectId
    if (!projectId) return []
    return queryScoresForSource(projectId, vocabId, code)
  },
}))
