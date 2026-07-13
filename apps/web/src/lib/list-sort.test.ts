import { describe, it, expect, vi } from 'vitest'

const lastVisited: Record<string, string> = {}
vi.mock('@/stores/visit-store', () => ({
  useVisitStore: { getState: () => ({ lastVisited }) },
}))

import { applySort, SORT_KEYS } from './list-sort'

interface Item {
  id: string
  label: string
  createdAt: string
  updatedAt: string
}

const items: Item[] = [
  { id: 'a', label: 'Banana', createdAt: '2024-01-02', updatedAt: '2024-03-01' },
  { id: 'b', label: 'apple', createdAt: '2024-01-01', updatedAt: '2024-02-01' },
  { id: 'c', label: 'Cherry', createdAt: '2024-01-03', updatedAt: '2024-01-01' },
]

const acc = {
  name: (i: Item) => i.label,
  createdAt: (i: Item) => i.createdAt,
  updatedAt: (i: Item) => i.updatedAt,
}

const ids = (list: Item[]) => list.map((i) => i.id)

describe('applySort', () => {
  it('falls back to alphabetical A→Z when sort is null', () => {
    // "apple" < "Banana" < "Cherry" case-insensitively via localeCompare
    expect(ids(applySort(items, null, acc))).toEqual(['b', 'a', 'c'])
  })

  it('sorts by name ascending and descending', () => {
    expect(ids(applySort(items, { key: SORT_KEYS.name, dir: 'asc' }, acc))).toEqual(['b', 'a', 'c'])
    expect(ids(applySort(items, { key: SORT_KEYS.name, dir: 'desc' }, acc))).toEqual(['c', 'a', 'b'])
  })

  it('sorts by creation date', () => {
    expect(ids(applySort(items, { key: SORT_KEYS.created, dir: 'asc' }, acc))).toEqual(['b', 'a', 'c'])
    expect(ids(applySort(items, { key: SORT_KEYS.created, dir: 'desc' }, acc))).toEqual(['c', 'a', 'b'])
  })

  it('sorts by modification date', () => {
    expect(ids(applySort(items, { key: SORT_KEYS.updated, dir: 'asc' }, acc))).toEqual(['c', 'b', 'a'])
    expect(ids(applySort(items, { key: SORT_KEYS.updated, dir: 'desc' }, acc))).toEqual(['a', 'b', 'c'])
  })

  it('does not throw on a null/undefined name (coerces to empty string)', () => {
    const withNull: Item[] = [
      { id: 'x', label: 'Zebra', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      { id: 'y', label: null as unknown as string, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
    ]
    // The null name sorts as '' (first ascending); no throw.
    expect(ids(applySort(withNull, { key: SORT_KEYS.name, dir: 'asc' }, acc))).toEqual(['y', 'x'])
  })

  it('does not mutate the input array', () => {
    const before = ids(items)
    applySort(items, { key: SORT_KEYS.name, dir: 'desc' }, acc)
    expect(ids(items)).toEqual(before)
  })

  it('sorts by last visit, falling back to updatedAt for never-visited items', () => {
    lastVisited['workspace:b'] = '2024-12-01' // b visited most recently
    lastVisited['workspace:a'] = '2024-06-01'
    // c never visited → falls back to its updatedAt (2024-01-01), the oldest stamp
    const visitAcc = { ...acc, entityType: 'workspace' as const, id: (i: Item) => i.id }
    expect(ids(applySort(items, { key: SORT_KEYS.lastVisit, dir: 'desc' }, visitAcc))).toEqual(['b', 'a', 'c'])
    delete lastVisited['workspace:b']
    delete lastVisited['workspace:a']
  })
})
