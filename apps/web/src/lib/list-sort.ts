import type { SortState, SortField } from '@/components/ui/list-page-toolbar'
import { useVisitStore, type VisitEntityType } from '@/stores/visit-store'

export type { SortState } from '@/components/ui/list-page-toolbar'

// Canonical sort-field keys shared by every list page, so labels and comparator
// logic stay in one place.
export const SORT_KEYS = {
  name: 'name',
  created: 'created',
  updated: 'updated',
  lastVisit: 'lastVisit',
} as const

/** Sort fields for a plain widget list (no visit tracking). */
export function baseSortFields(t: (key: string) => string): SortField[] {
  return [
    { key: SORT_KEYS.name, label: t('common.sort_alphabetical') },
    { key: SORT_KEYS.created, label: t('common.sort_created') },
    { key: SORT_KEYS.updated, label: t('common.sort_updated') },
  ]
}

/** Base fields plus a "last visit" field, for entities whose visits are tracked. */
export function visitSortFields(t: (key: string) => string): SortField[] {
  return [...baseSortFields(t), { key: SORT_KEYS.lastVisit, label: t('common.sort_last_visit') }]
}

interface SortAccessors<T> {
  /** Display name in the active language (already localized). */
  name: (item: T) => string
  createdAt: (item: T) => string | null | undefined
  updatedAt: (item: T) => string | null | undefined
  /** Present only when the entity's visits are tracked. */
  entityType?: VisitEntityType
  id?: (item: T) => string
}

function time(value: string | null | undefined): number {
  if (!value) return 0
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * Apply a toolbar SortState to a list. When `sort` is null (nothing picked in
 * the popover) the list falls back to alphabetical A→Z — the implicit default —
 * so the popover can show no active field yet still sort sensibly.
 */
export function applySort<T>(items: T[], sort: SortState | null, acc: SortAccessors<T>): T[] {
  const effective: SortState = sort ?? { key: SORT_KEYS.name, dir: 'asc' }
  const mult = effective.dir === 'asc' ? 1 : -1

  if (effective.key === SORT_KEYS.name) {
    // Coerce to '' — a null/undefined name (legacy/partial entity) would throw on
    // .localeCompare and break the whole list sort.
    return [...items].sort((a, b) => mult * (acc.name(a) ?? '').localeCompare(acc.name(b) ?? ''))
  }
  if (effective.key === SORT_KEYS.created) {
    return [...items].sort((a, b) => mult * (time(acc.createdAt(a)) - time(acc.createdAt(b))))
  }
  if (effective.key === SORT_KEYS.updated) {
    return [...items].sort((a, b) => mult * (time(acc.updatedAt(a)) - time(acc.updatedAt(b))))
  }
  if (effective.key === SORT_KEYS.lastVisit && acc.entityType && acc.id) {
    const { lastVisited } = useVisitStore.getState()
    const key = (item: T) => `${acc.entityType}:${acc.id!(item)}`
    // Never-visited items fall back to updatedAt so they interleave sensibly.
    const stamp = (item: T) => time(lastVisited[key(item)] ?? acc.updatedAt(item))
    return [...items].sort((a, b) => mult * (stamp(a) - stamp(b)))
  }
  return items
}
