import { apiRequest } from '@/lib/api-client'

/** Status of a source's materialized concept-list Parquet cache. */
export interface ConceptCacheStatus {
  exists: boolean
  /** Epoch seconds of the cache file's mtime — the "last refreshed" time. */
  refreshedAt: number | null
}

const base = (sourceId: string) =>
  `/data-sources/${encodeURIComponent(sourceId)}/concept-cache`

/** Whether the source has a concept cache, and when it was last refreshed. */
export function getConceptCacheStatus(sourceId: string): Promise<ConceptCacheStatus> {
  return apiRequest<ConceptCacheStatus>(base(sourceId))
}

/** Materialize the concept list (`selectSql`, the full unpaginated list query) to
 * the shared Parquet cache. Returns the new status. */
export function refreshConceptCache(
  sourceId: string,
  selectSql: string,
): Promise<ConceptCacheStatus> {
  return apiRequest<ConceptCacheStatus>(`${base(sourceId)}/refresh`, {
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
