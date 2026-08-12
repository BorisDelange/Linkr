import { create } from 'zustand'
import type { SourceConceptFilters, SourceConceptSorting } from '@/lib/concept-mapping/mapping-queries'
import type { MappingStatusFilter } from '@/features/warehouse/concept-mapping/components/SourceConceptTable'
import type { SuggestionCategory } from '@/types'

/**
 * Source-table filters of the mapping editor, kept outside the page so they
 * survive navigation — leaving the editor and coming back used to reset every
 * filter to "all".
 *
 * Stored per mapping project: two projects have unrelated vocabularies, so
 * carrying one's filters over to the other would hide most of its concepts.
 *
 * Only the filters the *user* sets are kept. The derived key lists on
 * `SourceConceptFilters` (mappedKeys, suggestionCategoryKeys…) are recomputed
 * from live store state on each load and would go stale if persisted.
 */
const STORAGE_KEY = 'linkr.mappingEditor.filters'

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
  columnVisibility: Record<string, boolean>
}

const COLUMN_FILTER_KEYS: (keyof PersistedColumnFilters)[] = [
  'searchText', 'searchId', 'searchCode', 'searchTextFuzzy',
  'vocabularyId', 'terminologyName', 'category', 'subcategory', 'domainId', 'conceptClassId',
]

const STRING_KEYS = new Set(['searchText', 'searchId', 'searchCode', 'searchTextFuzzy'])

/** Keep only known keys with the right shape: localStorage is user-editable and
 *  survives across app versions, so a stale blob must not reach the SQL builder. */
function sanitize(raw: unknown): EditorFilterState | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const filters: PersistedColumnFilters = {}
  const rawFilters = (obj.filters ?? {}) as Record<string, unknown>
  for (const key of COLUMN_FILTER_KEYS) {
    const value = rawFilters[key]
    if (STRING_KEYS.has(key)) {
      if (typeof value === 'string' && value !== '') filters[key] = value as never
    } else if (Array.isArray(value)) {
      const list = value.filter((v): v is string => typeof v === 'string')
      if (list.length > 0) filters[key] = list as never
    }
  }

  const rawSorting = obj.sorting as Record<string, unknown> | null | undefined
  const sorting =
    rawSorting && typeof rawSorting.columnId === 'string' && typeof rawSorting.desc === 'boolean'
      ? { columnId: rawSorting.columnId, desc: rawSorting.desc }
      : null

  const status = obj.mappingStatusFilter
  const mappingStatusFilter: MappingStatusFilter =
    status === 'unmapped' || status === 'mapped' || status === 'mapped_elsewhere' ? status : 'all'

  const suggestionCategories = Array.isArray(obj.suggestionCategories)
    ? obj.suggestionCategories.filter((c): c is SuggestionCategory => typeof c === 'string')
    : []

  const columnVisibility: Record<string, boolean> = {}
  const rawVisibility = obj.columnVisibility
  if (rawVisibility && typeof rawVisibility === 'object') {
    for (const [key, value] of Object.entries(rawVisibility as Record<string, unknown>)) {
      if (typeof value === 'boolean') columnVisibility[key] = value
    }
  }

  return { filters, sorting, mappingStatusFilter, suggestionCategories, columnVisibility }
}

type Stored = Record<string, EditorFilterState>

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Stored = {}
    for (const [projectId, state] of Object.entries(parsed)) {
      const clean = sanitize(state)
      if (clean) out[projectId] = clean
    }
    return out
  } catch {
    return {}
  }
}

function persist(state: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // A full or unavailable localStorage must not break filtering.
  }
}

interface MappingEditorFiltersState {
  byProject: Stored
  get: (projectId: string) => EditorFilterState | null
  save: (projectId: string, state: EditorFilterState) => void
  clear: (projectId: string) => void
}

export const useMappingEditorFiltersStore = create<MappingEditorFiltersState>((set, get) => ({
  byProject: load(),
  get: (projectId) => get().byProject[projectId] ?? null,
  save: (projectId, state) => {
    const byProject = { ...get().byProject, [projectId]: state }
    set({ byProject })
    persist(byProject)
  },
  clear: (projectId) => {
    const byProject = { ...get().byProject }
    delete byProject[projectId]
    set({ byProject })
    persist(byProject)
  },
}))
