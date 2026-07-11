import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import type { ScoresIndex } from '@/types'
import { validateScoresFile, type ParsedScoreRow } from '@/lib/concept-mapping/scores-parser'
import { deleteScoresFile } from '@/lib/concept-mapping/scores-storage'
import { persistScoresFile, queryScoresForSource, unregisterProject, buildIndex } from '@/lib/concept-mapping/scores-engine'
import {
  persistScoresFileOnServer,
  fetchScoresIndexFromServer,
  queryScoresForSourceOnServer,
  deleteScoresFileOnServer,
} from '@/lib/api/scores'

interface SuggestionScoresState {
  activeProjectId: string | null
  index: ScoresIndex | null
  loaded: boolean

  loadProjectMeta: (projectId: string) => Promise<void>
  /** Rebuild the query index from the already-persisted parquet (no File needed).
   *  Used to upgrade indexes written before a schema change (e.g. category keys). */
  reindexProject: (projectId: string) => Promise<void>
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
    // In server mode the parquet lives on the server; the index is rebuilt there
    // (no client scoresMeta cache). Front-only reads the persisted index from IDB.
    const index = isServerMode()
      ? await fetchScoresIndexFromServer(projectId)
      : (await getStorage().scoresMeta.get(projectId) ?? null)
    set({ activeProjectId: projectId, index, loaded: true })
  },

  async reindexProject(projectId) {
    const index = isServerMode()
      ? await fetchScoresIndexFromServer(projectId)
      : await buildIndex(projectId)
    if (!index) return
    if (!isServerMode()) await getStorage().scoresMeta.put(index)
    if (get().activeProjectId === projectId) set({ index })
  },

  async importScores(projectId, file) {
    if (isServerMode()) {
      // The upload+attach endpoint validates the parquet server-side, so no
      // client-side DuckDB validation (which would need DuckDB-WASM).
      const index = await persistScoresFileOnServer(projectId, file)
      if (!index) throw new Error('Failed to build scores index after save.')
      set({ activeProjectId: projectId, index, loaded: true })
      return index
    }

    const validation = await validateScoresFile(file)
    if (!validation.ok) throw new Error(validation.error)

    const index = await persistScoresFile(projectId, file)
    if (!index) throw new Error('Failed to build scores index after save.')

    set({ activeProjectId: projectId, index, loaded: true })
    return index
  },

  async deleteProjectScores(projectId) {
    if (isServerMode()) {
      await deleteScoresFileOnServer(projectId)
    } else {
      await unregisterProject(projectId)
      await deleteScoresFile(projectId)
      await getStorage().scoresMeta.delete(projectId)
    }
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
    return isServerMode()
      ? queryScoresForSourceOnServer(projectId, vocabId, code)
      : queryScoresForSource(projectId, vocabId, code)
  },
}))
