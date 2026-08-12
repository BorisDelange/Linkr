import { create } from 'zustand'
import type { SourceConceptFilters, SourceConceptSorting } from '@/lib/concept-mapping/mapping-queries'
import type { MappingStatusFilter } from '@/features/warehouse/concept-mapping/components/SourceConceptTable'
import type { SuggestionCategory } from '@/types'

/**
 * Source-table filters of the mapping editor, kept outside the page so they
 * survive navigation — leaving the editor and coming back used to reset every
 * filter to "all".
 *
 * In memory only: reopening the app starts from an unfiltered table. Persisting
 * them restored controls that live outside the column-filter row (mapping
 * status, suggestion categories), so a session-old selection silently cut the
 * table down to a few thousand concepts with no visible filter to clear.
 *
 * Stored per mapping project: two projects have unrelated vocabularies, so
 * carrying one's filters over to the other would hide most of its concepts.
 *
 * Only the filters the *user* sets are kept. The derived key lists on
 * `SourceConceptFilters` (mappedKeys, suggestionCategoryKeys…) are recomputed
 * from live store state on each load and would go stale if kept.
 */

/** Column filters that are a user choice, as opposed to derived key lists. */
export type PersistedColumnFilters = Pick<
  SourceConceptFilters,
  | 'searchText'
  | 'searchId'
  | 'searchCode'
  | 'searchTextFuzzy'
  | 'vocabularyId'
  | 'terminologyName'
  | 'category'
  | 'subcategory'
  | 'domainId'
  | 'conceptClassId'
>

export interface EditorFilterState {
  filters: PersistedColumnFilters
  sorting: SourceConceptSorting | null
  mappingStatusFilter: MappingStatusFilter
  suggestionCategories: SuggestionCategory[]
}

interface MappingEditorFiltersState {
  byProject: Record<string, EditorFilterState>
  get: (projectId: string) => EditorFilterState | null
  save: (projectId: string, state: EditorFilterState) => void
  clear: (projectId: string) => void
}

export const useMappingEditorFiltersStore = create<MappingEditorFiltersState>((set, get) => ({
  byProject: {},
  get: (projectId) => get().byProject[projectId] ?? null,
  save: (projectId, state) => {
    set({ byProject: { ...get().byProject, [projectId]: state } })
  },
  clear: (projectId) => {
    const byProject = { ...get().byProject }
    delete byProject[projectId]
    set({ byProject })
  },
}))
