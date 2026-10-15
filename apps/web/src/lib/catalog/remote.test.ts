import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  CatalogError,
  DEFAULT_CATALOG_SOURCE,
  catalogFileUrl,
  diffCatalog,
  fetchCatalog,
  fetchCatalogIndex,
  parseCatalogUrl,
  toCache,
} from './remote'
import type { CatalogFile, CatalogIndexFile } from './types'

const api = vi.hoisted(() => ({ serverMode: true, apiFetch: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ isServerMode: () => api.serverMode, apiFetch: api.apiFetch }))

// parseCatalogUrl accepts whatever a user pastes into Settings. A wrong parse points the
// whole catalog at a 404, so the tolerated forms are pinned here.
describe('parseCatalogUrl', () => {
  it('parses a plain repo URL', () => {
    const s = parseCatalogUrl('https://framagit.org/interhop/linkr/linkr-catalog')
    expect(s).toMatchObject({ host: 'framagit.org', project: 'interhop/linkr/linkr-catalog', branch: 'main' })
  })

  it('strips a GitLab repo-page suffix', () => {
    expect(parseCatalogUrl('https://framagit.org/g/sub/repo/-/tree/main?ref_type=heads')?.project)
      .toBe('g/sub/repo')
  })

  it('strips a .git clone suffix and trailing slashes', () => {
    expect(parseCatalogUrl('https://gitlab.com/g/repo.git')?.project).toBe('g/repo')
    expect(parseCatalogUrl('https://gitlab.com/g/repo///')?.project).toBe('g/repo')
  })

  it('keeps a custom branch', () => {
    expect(parseCatalogUrl('https://gitlab.com/g/repo', 'staging')?.branch).toBe('staging')
  })

  it('falls back to main for a blank branch', () => {
    expect(parseCatalogUrl('https://gitlab.com/g/repo', '  ')?.branch).toBe('main')
  })

  it('rejects non-https, garbage, and group-only URLs', () => {
    expect(parseCatalogUrl('http://gitlab.com/g/repo')).toBeNull()
    expect(parseCatalogUrl('not a url')).toBeNull()
    // A single path segment is a user/group, not a repo — nothing to fetch from.
    expect(parseCatalogUrl('https://gitlab.com/justagroup')).toBeNull()
  })

  it('supports any GitLab host, including self-hosted', () => {
    expect(parseCatalogUrl('https://git.chu-example.fr/team/catalog')?.host).toBe('git.chu-example.fr')
  })
})

describe('catalogFileUrl', () => {
  it('url-encodes the project path into the API v4 route', () => {
    const url = catalogFileUrl(DEFAULT_CATALOG_SOURCE, 'catalog-index.json')
    expect(url).toBe(
      'https://framagit.org/api/v4/projects/interhop%2Flinkr%2Flinkr-catalog/repository/files/catalog-index.json/raw?ref=main',
    )
  })
})

// diffCatalog drives the "Updates available (3 new, 1 updated)" affordance. A wrong
// diff either nags the user forever or silently hides new catalog content.
describe('diffCatalog', () => {
  const index = (hashes: Record<string, string>): Pick<CatalogIndexFile, 'hashes'> => ({ hashes })

  it('reports no change when hashes match', () => {
    const d = diffCatalog({ hashes: { a: '1', b: '2' } }, index({ a: '1', b: '2' }))
    expect(d).toEqual({ changed: false, added: [], modified: [], removed: [] })
  })

  it('detects added, modified and removed entries at once', () => {
    const d = diffCatalog({ hashes: { keep: '1', bump: '2', gone: '3' } }, index({ keep: '1', bump: '9', fresh: '4' }))
    expect(d.changed).toBe(true)
    expect(d.added).toEqual(['fresh'])
    expect(d.modified).toEqual(['bump'])
    expect(d.removed).toEqual(['gone'])
  })

  it('treats a null cache as everything-added (first load)', () => {
    const d = diffCatalog(null, index({ a: '1', b: '2' }))
    expect(d.changed).toBe(true)
    expect(d.added).toEqual(['a', 'b'])
    expect(d.modified).toEqual([])
  })

  it('sorts each list so the UI order is stable across fetches', () => {
    const d = diffCatalog({ hashes: {} }, index({ zulu: '1', alpha: '2', mike: '3' }))
    expect(d.added).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('handles a missing hashes map without throwing', () => {
    const d = diffCatalog({ hashes: { a: '1' } }, { hashes: undefined as unknown as Record<string, string> })
    expect(d.removed).toEqual(['a'])
  })
})

// The fetch layer must fail in distinguishable ways: the page shows a different message
// for "you're offline" vs "this Linkr is too old for that catalog".
describe('fetch error classification', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stub = (impl: () => unknown) => vi.stubGlobal('fetch', vi.fn(impl))

  const ok = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  })

  it('classifies a thrown fetch as network', async () => {
    stub(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(fetchCatalogIndex()).rejects.toMatchObject({ kind: 'network' })
  })

  it('classifies HTTP 404 as not-found', async () => {
    stub(() => ({ ok: false, status: 404 }))
    await expect(fetchCatalogIndex()).rejects.toMatchObject({ kind: 'not-found' })
  })

  it('classifies unparseable JSON as malformed', async () => {
    stub(() => ({ ok: true, status: 200, json: async () => { throw new Error('bad') } }))
    await expect(fetchCatalogIndex()).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a catalog newer than this build understands', async () => {
    stub(() => ok({ schemaVersion: 99, contentHash: 'x', hashes: {} }))
    await expect(fetchCatalogIndex()).rejects.toMatchObject({ kind: 'unsupported-version' })
  })

  it('rejects an index with no contentHash', async () => {
    stub(() => ok({ schemaVersion: 1, hashes: {} }))
    await expect(fetchCatalogIndex()).rejects.toBeInstanceOf(CatalogError)
  })

  it('accepts a well-formed index', async () => {
    stub(() => ok({ schemaVersion: 1, contentHash: 'abc', count: 1, hashes: { a: '1' }, generatedAt: '2026-08-04T00:00:00Z' }))
    await expect(fetchCatalogIndex()).resolves.toMatchObject({ contentHash: 'abc' })
  })

  it('requests the API v4 raw route, not /-/raw/ (the only one sending CORS headers)', async () => {
    // Typed arg so `spy.mock.calls[0][0]` is the URL rather than a never-indexed tuple.
    const spy = vi.fn((_url: string) => ok({ schemaVersion: 1, contentHash: 'a', hashes: {} }))
    vi.stubGlobal('fetch', spy)
    await fetchCatalogIndex()
    const url = String(spy.mock.calls[0]![0])
    expect(url).toContain('/api/v4/projects/')
    expect(url).toContain('/repository/files/')
    expect(url).not.toContain('/-/raw/')
  })
})

// A private catalog never goes to GitLab from the browser: the token lives server-side.
describe('private catalog', () => {
  const source = { ...parseCatalogUrl('https://gitlab.chu.fr/g/catalog', 'prod')!, private: true }
  const index = { schemaVersion: 1, contentHash: 'a', hashes: {} }

  afterEach(() => {
    vi.unstubAllGlobals()
    api.apiFetch.mockReset()
    api.serverMode = true
  })

  it('reads through the backend route, never fetching GitLab directly', async () => {
    const direct = vi.fn()
    vi.stubGlobal('fetch', direct)
    api.apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => index })
    await expect(fetchCatalogIndex(source)).resolves.toMatchObject({ contentHash: 'a' })
    expect(direct).not.toHaveBeenCalled()
    const path = String(api.apiFetch.mock.calls[0]![0])
    expect(path).toMatch(/^\/api\/v1\/git\/catalog-file\?/)
    const query = new URLSearchParams(path.split('?')[1])
    expect(Object.fromEntries(query)).toEqual({ url: 'https://gitlab.chu.fr/g/catalog', branch: 'prod', file: 'catalog-index.json' })
  })

  it('surfaces the coded refusal the backend sends', async () => {
    api.apiFetch.mockResolvedValue({ ok: false, status: 502, json: async () => ({ detail: { code: 'unauthorized' } }) })
    await expect(fetchCatalogIndex(source)).rejects.toMatchObject({ kind: 'unauthorized' })
  })

  it('reads an unknown or missing code as network', async () => {
    api.apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ detail: 'boom' }) })
    await expect(fetchCatalogIndex(source)).rejects.toMatchObject({ kind: 'network' })
  })

  it('needs server mode, where the account holding the token lives', async () => {
    api.serverMode = false
    await expect(fetchCatalogIndex(source)).rejects.toMatchObject({ kind: 'server-mode-required' })
    expect(api.apiFetch).not.toHaveBeenCalled()
  })
})

describe('fetchCatalog', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('drops malformed entries instead of failing the whole fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: 1,
        contentHash: 'h',
        generatedAt: '2026-08-04T00:00:00Z',
        entries: [
          { id: 'good', type: 'sql-collection', git: { url: 'https://x/y', branch: 'main' } },
          { id: 'no-git', type: 'project' },
          null,
        ],
      }),
    })))
    const catalog = await fetchCatalog()
    expect(catalog.entries.map((e) => e.id)).toEqual(['good'])
  })

  it('rejects when entries is not an array', async () => {
    vi.stubGlobal('fetch', vi.fn(() => ({
      ok: true, status: 200,
      json: async () => ({ schemaVersion: 1, contentHash: 'h', entries: {} }),
    })))
    await expect(fetchCatalog()).rejects.toMatchObject({ kind: 'malformed' })
  })
})

describe('toCache', () => {
  const catalog: CatalogFile = {
    schemaVersion: 1,
    generatedAt: '2026-08-04T23:44:18+02:00',
    contentHash: 'abc',
    entries: [],
  }

  it('carries the index hashes so the next diff has a baseline', () => {
    const cache = toCache(catalog, { schemaVersion: 1, generatedAt: '', contentHash: 'abc', count: 1, hashes: { a: '1' } }, '2026-08-05T10:00:00Z')
    expect(cache.hashes).toEqual({ a: '1' })
    expect(cache.fetchedAt).toBe('2026-08-05T10:00:00Z')
    expect(cache.contentHash).toBe('abc')
  })

  it('falls back to an empty hash map when no index was fetched', () => {
    // Consequence is benign and intended: the next diff reports every entry as added
    // rather than throwing on a missing baseline.
    const cache = toCache(catalog, null, '2026-08-05T10:00:00Z')
    expect(cache.hashes).toEqual({})
    expect(diffCatalog(cache, { hashes: { a: '1' } }).added).toEqual(['a'])
  })
})
