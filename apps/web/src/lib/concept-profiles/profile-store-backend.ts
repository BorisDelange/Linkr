/**
 * Where a database's concept profiles live: on the server, shared by everyone
 * who opens the database; in the browser (IndexedDB) for the client-only build.
 * Same rows either way (`StoredProfile`).
 */
import { openDB, type IDBPDatabase } from 'idb'
import { apiRequest, isServerMode } from '@/lib/api-client'
import type { SourceExtraction } from '@/types'
import type { BatchProfileStore } from '@/lib/concept-mapping/source-extraction'
import type { SectionKey, StoredProfile } from './profile-store'

/** The Concepts tab's profiling run, as `startRun` reports it, with the data it reads. */
export type ProfileRunState = SourceExtraction & { fingerprint: string }

export interface ProfileStoreSummary {
  count: number
  lastComputedAt: string | null
  sections: Partial<Record<SectionKey, number>>
  /** Profiles per data fingerprint: those under another one than today's are stale. */
  fingerprints: Record<string, number>
  run: ProfileRunState | null
}

export interface ProfileStoreBackend {
  read: (sourceId: string, dictKey: string, conceptIds: readonly number[]) => Promise<StoredProfile[]>
  write: (sourceId: string, profiles: StoredProfile[]) => Promise<void>
  summary: (sourceId: string) => Promise<ProfileStoreSummary>
  saveRun: (sourceId: string, run: ProfileRunState | null) => Promise<void>
  clear: (sourceId: string) => Promise<void>
}

const READ_CHUNK = 20_000
const WRITE_CHUNK = 1_000

const base = (sourceId: string) => `/data-sources/${encodeURIComponent(sourceId)}/concept-profiles`

const serverBackend: ProfileStoreBackend = {
  async read(sourceId, dictKey, conceptIds) {
    const out: StoredProfile[] = []
    for (let i = 0; i < conceptIds.length; i += READ_CHUNK) {
      const res = await apiRequest<{ profiles: StoredProfile[] }>(`${base(sourceId)}/read`, {
        method: 'POST',
        body: JSON.stringify({ dictKey, conceptIds: conceptIds.slice(i, i + READ_CHUNK) }),
      })
      out.push(...res.profiles)
    }
    return out
  },
  async write(sourceId, profiles) {
    for (let i = 0; i < profiles.length; i += WRITE_CHUNK) {
      await apiRequest<void>(base(sourceId), {
        method: 'PUT',
        body: JSON.stringify({ profiles: profiles.slice(i, i + WRITE_CHUNK) }),
      })
    }
  },
  summary: (sourceId) => apiRequest<ProfileStoreSummary>(`${base(sourceId)}/summary`),
  saveRun: (sourceId, run) => apiRequest<void>(`${base(sourceId)}/run`, {
    method: 'PUT',
    body: JSON.stringify({ run, computedAt: new Date().toISOString() }),
  }),
  clear: (sourceId) => apiRequest<void>(base(sourceId), { method: 'DELETE' }),
}

// --- Client-only build -------------------------------------------------------

const DB_NAME = 'linkr-concept-profiles'
const PROFILES = 'profiles'
const RUNS = 'runs'

type Row = StoredProfile & { sourceId: string }

let dbPromise: Promise<IDBPDatabase> | null = null
function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade: (d) => {
      const profiles = d.createObjectStore(PROFILES, { keyPath: ['sourceId', 'dictKey', 'conceptId'] })
      profiles.createIndex('bySource', 'sourceId')
      d.createObjectStore(RUNS)
    },
  })
  return dbPromise
}

const idbBackend: ProfileStoreBackend = {
  async read(sourceId, dictKey, conceptIds) {
    const store = (await db()).transaction(PROFILES).store
    const rows = await Promise.all(conceptIds.map((id) => store.get([sourceId, dictKey, id]) as Promise<Row | undefined>))
    return rows.filter((r): r is Row => !!r).map(({ sourceId: _s, ...p }) => p)
  },
  async write(sourceId, profiles) {
    const tx = (await db()).transaction(PROFILES, 'readwrite')
    await Promise.all([...profiles.map((p) => tx.store.put({ ...p, sourceId })), tx.done])
  },
  async summary(sourceId) {
    const d = await db()
    const rows = (await d.getAllFromIndex(PROFILES, 'bySource', sourceId)) as Row[]
    const sections: Partial<Record<SectionKey, number>> = {}
    const fingerprints: Record<string, number> = {}
    let last: string | null = null
    for (const r of rows) {
      for (const s of r.sections) sections[s] = (sections[s] ?? 0) + 1
      fingerprints[r.fingerprint] = (fingerprints[r.fingerprint] ?? 0) + 1
      if (!last || r.computedAt > last) last = r.computedAt
    }
    const run = ((await d.get(RUNS, sourceId)) as ProfileRunState | undefined) ?? null
    return { count: rows.length, lastComputedAt: last, sections, fingerprints, run }
  },
  async saveRun(sourceId, run) {
    const d = await db()
    if (run) await d.put(RUNS, run, sourceId)
    else await d.delete(RUNS, sourceId)
  },
  async clear(sourceId) {
    const d = await db()
    const tx = d.transaction([PROFILES, RUNS], 'readwrite')
    const keys = await tx.objectStore(PROFILES).index('bySource').getAllKeys(sourceId)
    await Promise.all([...keys.map((k) => tx.objectStore(PROFILES).delete(k)), tx.objectStore(RUNS).delete(sourceId), tx.done])
  },
}

export function profileStore(): ProfileStoreBackend {
  return isServerMode() ? serverBackend : idbBackend
}

/**
 * The store as an extraction batch reads and adds to it, for one database's
 * data. Never what fails a run: unreadable, every concept is profiled; not
 * writable (a reader of the database, who may still extract), nothing is kept.
 */
export function batchProfileStore(sourceId: string, fingerprint: string): BatchProfileStore {
  const backend = profileStore()
  let writable = true
  return {
    fingerprint,
    read: async (dictKey, ids) => {
      try {
        return new Map((await backend.read(sourceId, dictKey, ids)).map((p) => [p.conceptId, p]))
      } catch {
        return new Map()
      }
    },
    write: async (profiles) => {
      if (!writable) return
      try {
        await backend.write(sourceId, profiles)
      } catch {
        writable = false
      }
    },
  }
}
