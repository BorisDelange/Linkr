import { apiRequest } from '@/lib/api-client'
import { cancellableOnServer } from '@/lib/api/data-sources'
import type { ConceptCountManifest } from '@/features/projects/warehouse/concepts/concept-count-plan'

/** The last counting run of a source's concept list, as the server keeps it. */
export interface ConceptRunStatus {
  manifest: Partial<ConceptCountManifest>
  doneUnits: string[]
  /** Epoch seconds the last unit was written. */
  lastUnitAt: number | null
}

/** Status of a source's materialized concept-list Parquet cache. */
export interface ConceptCacheStatus {
  exists: boolean
  /** Epoch seconds of the cache file's mtime — the "last refreshed" time. */
  refreshedAt: number | null
  run: ConceptRunStatus | null
}

const base = (sourceId: string) =>
  `/data-sources/${encodeURIComponent(sourceId)}/concept-cache`

/** Whether the source has a concept cache, and when it was last refreshed. */
export function getConceptCacheStatus(sourceId: string): Promise<ConceptCacheStatus> {
  return apiRequest<ConceptCacheStatus>(base(sourceId))
}

/** Store a counting run's manifest; `reset` drops the units already done. */
export function startConceptRun(sourceId: string, manifest: ConceptCountManifest, reset: boolean): Promise<void> {
  return apiRequest<void>(`${base(sourceId)}/run`, {
    method: 'PUT',
    body: JSON.stringify({ manifest, reset }),
  })
}

/** Run one counting unit server-side; `signal` interrupts it. */
export function writeConceptUnit(sourceId: string, key: string, sql: string, signal?: AbortSignal): Promise<void> {
  return cancellableOnServer(sourceId, signal, (queryId) =>
    apiRequest<void>(`${base(sourceId)}/units/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: JSON.stringify({ sql, ...(queryId ? { queryId } : {}) }),
    }),
  )
}

/** Write the concept list (`selectSql`) from the units done so far. */
export function assembleConceptCache(sourceId: string, selectSql: string): Promise<ConceptCacheStatus> {
  return apiRequest<ConceptCacheStatus>(`${base(sourceId)}/assemble`, {
    method: 'POST',
    body: JSON.stringify({ selectSql }),
  })
}

/** Run a page/filter/sort query against the cached Parquet (view `concepts`).
 * Rejects (404) if the cache has not been built yet. */
export async function queryConceptCache(
  sourceId: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const res = await apiRequest<{ rows: Record<string, unknown>[] }>(
    `${base(sourceId)}/query`,
    { method: 'POST', body: JSON.stringify({ sql }) },
  )
  return res.rows
}

/** Shared cached detail-panel stats for one concept (undefined if not cached). */
export async function getConceptStats<T>(
  sourceId: string,
  conceptId: number,
): Promise<T | undefined> {
  try {
    const res = await apiRequest<{ stats: T }>(
      `/data-sources/${encodeURIComponent(sourceId)}/concept-stats/${conceptId}`,
    )
    return res.stats
  } catch {
    return undefined
  }
}

/** Persist computed stats for one concept, sharing them with every user. */
export function saveConceptStats<T>(
  sourceId: string,
  conceptId: number,
  stats: T,
): Promise<void> {
  return apiRequest(
    `/data-sources/${encodeURIComponent(sourceId)}/concept-stats/${conceptId}`,
    { method: 'PUT', body: JSON.stringify({ stats }) },
  ).then(() => undefined)
}
