import { useCallback, useMemo, useState } from 'react'
import type { SortState } from '@/components/ui/list-page-toolbar'
import { SORT_KEYS } from '@/lib/list-sort'
import { useAuthStore } from '@/stores/auth-store'
import { isServerMode } from '@/lib/api-client'

/**
 * Identifies which list's sort choice is being remembered. One key per list
 * page, so picking "last visit" on Projects never reorders Databases.
 */
export type SortScope =
  | 'workspaces'
  | 'projects'
  | 'project-databases'
  | 'project-dashboards'
  | 'project-cohorts'
  | 'project-patient-data'
  | 'app-databases'
  | 'schema-presets'
  | 'etl-pipelines'
  | 'data-catalogs'
  | 'dq-rule-sets'
  | 'mapping-projects'
  | 'sql-scripts'
  | 'community-catalog'
  | 'plugins'

/** Key under which every list's sort choice lives in `user.preferences`. */
const PREF_KEY = 'listSort'
/** Client-only mode has no user row; mirror the same map in localStorage. */
const LS_KEY = 'linkr:list-sort'

const SORT_FIELDS: readonly string[] = Object.values(SORT_KEYS)

/**
 * Reject anything that is not a SortState over a known field: preferences are
 * free-form JSON that an older build (or a hand-edited row) may have written,
 * and a bad `key` would silently leave the list unsorted.
 */
export function parseStoredSort(value: unknown): SortState | null {
  if (!value || typeof value !== 'object') return null
  const { key, dir } = value as Partial<SortState>
  if (typeof key !== 'string' || !SORT_FIELDS.includes(key)) return null
  if (dir !== 'asc' && dir !== 'desc') return null
  return { key, dir }
}

function readAll(): Record<string, unknown> {
  if (isServerMode()) {
    const prefs = useAuthStore.getState().user?.preferences
    const map = prefs?.[PREF_KEY]
    return map && typeof map === 'object' ? (map as Record<string, unknown>) : {}
  }
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * A list page's sort choice, remembered across sessions — server mode stores it
 * on the user (so it follows them between devices), client-only mode in
 * localStorage. Drop-in replacement for `useState<SortState | null>(null)`.
 *
 * Deliberately the ONLY part of the Filters popover that persists: the other
 * filters narrow what a list shows, and silently hiding rows at load would read
 * as missing data.
 */
export function usePersistedSort(scope: SortScope): [SortState | null, (next: SortState | null) => void] {
  // Subscribed rather than seeded into state: in server mode the user (and its
  // preferences) arrives with /auth/me, which may resolve after this hook first
  // runs. Selects the raw stored value, not a parsed copy — zustand compares
  // selector results by identity, and a fresh object every render would loop.
  const storedRaw = useAuthStore((s) =>
    isServerMode()
      ? (s.user?.preferences?.[PREF_KEY] as Record<string, unknown> | undefined)?.[scope]
      : undefined,
  )
  const storedSort = useMemo(() => parseStoredSort(storedRaw), [storedRaw])
  // Client-only mode has no store to subscribe to; localStorage is read once and
  // then kept in state.
  const [localSort, setLocalSort] = useState<SortState | null>(() =>
    isServerMode() ? null : parseStoredSort(readAll()[scope]),
  )

  const setSort = useCallback(
    (next: SortState | null) => {
      const all = { ...readAll() }
      if (next) all[scope] = next
      else delete all[scope]
      if (isServerMode()) {
        void useAuthStore.getState().setPreference(PREF_KEY, all)
      } else {
        localStorage.setItem(LS_KEY, JSON.stringify(all))
        setLocalSort(next)
      }
    },
    [scope],
  )

  return [isServerMode() ? storedSort : localSort, setSort]
}
