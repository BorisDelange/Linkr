import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CATALOG, DEFAULT_CATALOG_ID, loadCatalogSettings, updateCatalogs } from './settings'

/** Multiple catalogs: the stored list, the one-time carry-over of the old single setting, and cache clearing. */

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})

beforeEach(() => store.clear())

describe('loadCatalogSettings', () => {
  it('starts with the community catalog', () => {
    expect(loadCatalogSettings()).toEqual({ catalogs: [DEFAULT_CATALOG], activeId: DEFAULT_CATALOG_ID })
  })

  it('carries a custom repo from the single-catalog setting over as a second, active catalog', () => {
    store.set('linkr-catalog-source', JSON.stringify({ url: 'https://gitlab.example.org/chu/catalog/-/tree/main', branch: 'prod' }))
    const settings = loadCatalogSettings()
    expect(settings.catalogs).toHaveLength(2)
    const custom = settings.catalogs[1]!
    expect(custom).toMatchObject({ url: 'https://gitlab.example.org/chu/catalog', branch: 'prod' })
    expect(settings.activeId).toBe(custom.id)
    expect(store.has('linkr-catalog-source')).toBe(false)
  })

  it('keeps an emptied list empty — the community catalog can be removed', () => {
    store.set('linkr-catalogs', JSON.stringify({ catalogs: [], activeId: '' }))
    expect(loadCatalogSettings()).toEqual({ catalogs: [], activeId: '' })
  })

  it('falls back to the first catalog when the active one is gone', () => {
    const other = { ...DEFAULT_CATALOG, id: 'other', url: 'https://gitlab.com/a/b' }
    store.set('linkr-catalogs', JSON.stringify({ catalogs: [other], activeId: 'deleted' }))
    expect(loadCatalogSettings().activeId).toBe('other')
  })
})

describe('updateCatalogs', () => {
  it('drops the cache of a removed catalog and of one pointed at another repo, not of the others', () => {
    const a = { ...DEFAULT_CATALOG, id: 'a', url: 'https://gitlab.com/a/a' }
    const b = { ...DEFAULT_CATALOG, id: 'b', url: 'https://gitlab.com/b/b' }
    const c = { ...DEFAULT_CATALOG, id: 'c', url: 'https://gitlab.com/c/c' }
    for (const id of ['a', 'b', 'c']) store.set(`linkr-catalog-cache:${id}`, '{}')
    const next = updateCatalogs(
      { catalogs: [a, b, c], activeId: 'b' },
      { catalogs: [a, { ...c, url: 'https://gitlab.com/c/moved' }], activeId: 'b' },
    )
    expect(store.has('linkr-catalog-cache:a')).toBe(true)
    expect(store.has('linkr-catalog-cache:b')).toBe(false)
    expect(store.has('linkr-catalog-cache:c')).toBe(false)
    expect(next.activeId).toBe('a')
  })
})
