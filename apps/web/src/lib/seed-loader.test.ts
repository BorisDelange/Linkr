/**
 * Seeding a git-linked mapping project.
 *
 * The regression this guards: `mappings.json` carries no `id` (an export strips
 * primary keys), the IndexedDB store is keyed on `id`, and the loader wrote the
 * rows straight through — so every `add()` threw, the transaction aborted, and a
 * portal shipped its mapping projects with zero mappings while still logging a
 * successful seed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Storage } from '@/lib/storage'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))
vi.mock('@/lib/duckdb/engine', () => ({}))
vi.mock('@/lib/plugins/default-plugins', () => ({ seedBuiltinPluginsForWorkspace: async () => {} }))
vi.mock('@/lib/concept-mapping/import', () => ({ recomputeImportedStats: async () => {} }))

const written: Array<Record<string, unknown>> = []
/** Rows that reached a store keyed on `id`, per store. */
const rows: Record<string, Array<Record<string, unknown>>> = {}

/** A store keyed on `id`: like IndexedDB, it refuses a row without one. */
function keyedStore(name: string) {
  return {
    create: async (row: Record<string, unknown>) => {
      if (!row.id) throw new Error('DataError: no key')
      ;(rows[name] ??= []).push(row)
    },
  }
}

/** Minimal storage double: records what reaches conceptMappings, no-ops the rest. */
function makeStorage(): Storage {
  const ok = async () => {}
  const store = {
    conceptMappings: {
      createBatch: async (batch: Array<Record<string, unknown>>) => {
        // Mirror the real store's key constraint: a row with no `id` is rejected,
        // and (as in IndexedDB) it takes the whole batch down with it.
        if (batch.some((m) => !m.id)) throw new Error('DataError: no key')
        written.push(...batch)
      },
      getByProject: async () => [],
    },
    mappingProjects: { create: ok, getById: async () => null },
    workspaces: { getById: async () => null, create: ok, update: ok },
    organizations: { getById: async () => null, create: ok },
    projects: { getById: async () => null, create: ok, update: ok, getAll: async () => [] },
    dataSources: { getAll: async () => [] },
    etlPipelines: keyedStore('etlPipelines'),
    etlFiles: keyedStore('etlFiles'),
    sqlScriptCollections: keyedStore('sqlScriptCollections'),
    sqlScriptFiles: keyedStore('sqlScriptFiles'),
  }
  return new Proxy(store, {
    // Any collection the loader touches that this double does not model answers
    // with no-op methods, so the test states only what it is about.
    get: (target, prop: string) =>
      prop in target
        ? target[prop as keyof typeof store]
        : new Proxy({}, { get: () => async () => [] }),
  }) as unknown as Storage
}

vi.mock('@/lib/storage', () => ({ getStorage: () => makeStorage() }))

/** One mapping as a real export writes it: every field but the primary key. */
const MAPPING_NO_ID = {
  sourceConceptId: 0,
  sourceConceptName: 'Fréquence cardiaque',
  sourceVocabularyId: 'EHOP',
  sourceDomainId: 'Measurement',
  sourceConceptCode: 'HR',
  targetConceptId: 3027018,
  targetConceptName: 'Heart rate',
  targetVocabularyId: 'LOINC',
  targetDomainId: 'Measurement',
  targetConceptCode: '8867-4',
  mappingType: 'maps_to',
  equivalence: 'skos:exactMatch',
  status: 'approved',
  createdAt: '2026-01-01T00:00:00.000Z',
}

const TREE: Record<string, unknown> = {
  'seed.json': { workspaces: ['ricdc'] },
  'ricdc/manifest.json': {
    entities: [{ type: 'mappingProject', id: 'adult-icu-rennes', folder: 'adult-icu-rennes' }],
    internals: {
      etlPipelines: ['to-omop'],
      etlFiles: { 'to-omop/scripts/10_person.sql': 'scripts/10_person.sql' },
      sqlCollections: ['checks'],
      sqlScriptFiles: { 'checks/scripts/count.sql': 'scripts/count.sql' },
    },
  },
  // Published manifests carry the portable `entityId` and no local `id`.
  'ricdc/etl/to-omop/entity.json': { entityId: 'to-omop', type: 'etl-pipeline', name: { en: 'To OMOP' } },
  'ricdc/etl/to-omop/scripts/_tree.json': [{ path: '10_person.sql', type: 'file', language: 'sql', order: 1 }],
  'ricdc/etl/to-omop/scripts/10_person.sql': 'SELECT 1',
  'ricdc/sql-scripts/checks/entity.json': { entityId: 'checks', type: 'sql-collection', name: { en: 'Checks' } },
  'ricdc/sql-scripts/checks/scripts/_tree.json': [{ path: 'count.sql', type: 'file', language: 'sql', order: 1 }],
  'ricdc/sql-scripts/checks/scripts/count.sql': 'SELECT 2',
  'ricdc/entity.json': { entityId: 'ricdc', name: { en: 'RiCDC' } },
  'ricdc/mapping-projects/adult-icu-rennes/entity.json': {
    entityId: 'adult-icu-rennes',
    name: { en: 'Adult ICU Rennes' },
    sourceType: 'database',
  },
  'ricdc/mapping-projects/adult-icu-rennes/mappings.json': [
    MAPPING_NO_ID,
    // Same source code mapped twice — ids must stay distinct.
    { ...MAPPING_NO_ID, targetConceptId: 3027017, targetConceptCode: '8887-2' },
  ],
}

/** The seed guard flags live in localStorage; the test env has none. */
function makeLocalStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
  }
}

beforeEach(() => {
  written.length = 0
  for (const k of Object.keys(rows)) delete rows[k]
  vi.stubGlobal('localStorage', makeLocalStorage())
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace(/^.*data\/seed\//, '')
    const body = TREE[path]
    if (body === undefined) return { ok: false, status: 404, headers: new Headers() }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
  })
})

afterEach(() => { vi.unstubAllGlobals() })

describe('seedWorkspaces — git-linked mapping project', () => {
  it('writes the mappings of an export that carries no ids', async () => {
    const { seedWorkspaces } = await import('./seed-loader')
    await seedWorkspaces()

    expect(written).toHaveLength(2)
    for (const m of written) {
      expect(m.id).toBeTruthy()
      expect(m.projectId).toBe('adult-icu-rennes')
    }
    expect(written[0].sourceConceptCode).toBe('HR')
  })

  it('gives each mapping a distinct id, stable across re-seeds', async () => {
    const { seedWorkspaces } = await import('./seed-loader')
    await seedWorkspaces()
    const first = written.map((m) => m.id)
    expect(first).toHaveLength(2)
    expect(new Set(first).size).toBe(first.length)

    // A re-seed (guard flags cleared, same files) must land on the same rows
    // rather than doubling them — hence derived ids, not random ones.
    written.length = 0
    localStorage.clear()
    await seedWorkspaces()
    expect(written.map((m) => m.id)).toEqual(first)
  })

  // Two callers used to race here: the localStorage guard only closes once the
  // whole seed has finished, so StrictMode's double mount (and a second tab) both
  // started a full pass, and they collided writing the same deterministic ids.
  it('shares one run between concurrent callers', async () => {
    const { seedWorkspaces } = await import('./seed-loader')
    await Promise.all([seedWorkspaces(), seedWorkspaces()])

    expect(written).toHaveLength(2)
  })
})

// The demo's ETL pipeline used to seed as 34 empty scripts and no pipeline row:
// the manifest has no `id`, so the store refused the row, and its file list keys
// each script under `scripts/`, which the loader looked up without.
describe('seedWorkspaces — workspace ETL pipelines and SQL collections', () => {
  it('stores each owner row under the id its files hang off', async () => {
    const { seedWorkspaces } = await import('./seed-loader')
    await seedWorkspaces()

    expect(rows.etlPipelines?.map((p) => p.id)).toEqual(['to-omop'])
    expect(rows.etlFiles?.map((f) => f.pipelineId)).toEqual(['to-omop'])
    expect(rows.sqlScriptCollections?.map((c) => c.id)).toEqual(['checks'])
    expect(rows.sqlScriptFiles?.map((f) => f.collectionId)).toEqual(['checks'])
  })

  it('seeds each script with its content', async () => {
    const { seedWorkspaces } = await import('./seed-loader')
    await seedWorkspaces()

    expect(rows.etlFiles?.map((f) => f.content)).toEqual(['SELECT 1'])
    expect(rows.sqlScriptFiles?.map((f) => f.content)).toEqual(['SELECT 2'])
  })
})

describe('seedWorkspaces — optional similarity scores', () => {
  /** Serve the scores path the way a host that falls back to the SPA shell does. */
  function stubFetchWithSpaFallback(contentType: string) {
    vi.stubGlobal('fetch', async (url: string) => {
      const path = String(url).replace(/^.*data\/seed\//, '')
      const body = TREE[path]
      if (body !== undefined) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => body,
          text: async () => JSON.stringify(body),
        }
      }
      // Every absent file — the scores parquet included — answers 200 + index.html.
      const html = '<!doctype html><html><body><div id="root"></div></body></html>'
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': contentType }),
        json: async () => { throw new Error('not json') },
        text: async () => html,
        arrayBuffer: async () => new TextEncoder().encode(html).buffer,
      }
    })
  }

  it('ignores an SPA-fallback HTML body served for a missing scores file', async () => {
    const persistScoresFile = vi.fn()
    vi.doMock('@/lib/concept-mapping/scores-engine', () => ({ persistScoresFile }))
    stubFetchWithSpaFallback('text/html')

    const { seedWorkspaces } = await import('./seed-loader')
    await seedWorkspaces()

    expect(persistScoresFile).not.toHaveBeenCalled()
  })

  // The content-type check alone misses this one: the body is still HTML, but the
  // host labels it octet-stream. Only the PAR1 magic bytes catch it — otherwise it
  // reached DuckDB and surfaced as "No magic bytes found at end of file".
  it('ignores an HTML body served as octet-stream', async () => {
    const persistScoresFile = vi.fn()
    vi.doMock('@/lib/concept-mapping/scores-engine', () => ({ persistScoresFile }))
    stubFetchWithSpaFallback('application/octet-stream')

    const { seedWorkspaces } = await import('./seed-loader')
    await seedWorkspaces()

    expect(persistScoresFile).not.toHaveBeenCalled()
  })
})
