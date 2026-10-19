import { apiRequest } from '@/lib/api-client'
import type { Job } from '@/lib/api/environments'
import type { QueryJobItem } from '@/lib/api/query-jobs'
import type { ConceptCountManifest, StatsRange } from '@/features/projects/warehouse/concepts/concept-count-plan'

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

/** Run counting units of run `runId` (and assemblies of the list, keyed
 *  `assemble-…`) as a server job; follow it with `followQueryJob`. Rejects
 *  (409) once that run was replaced. */
export function startConceptUnitsJob(sourceId: string, label: string, runId: string, units: readonly QueryJobItem[]): Promise<Job> {
  return apiRequest<Job>(`${base(sourceId)}/units-job`, {
    method: 'POST',
    body: JSON.stringify({ label, runId, units }),
  })
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

/** The id ranges of the run's `stats` units, about `maxRows` values each,
 *  packed by the server from the row counts of its record units. */
export async function planConceptStats(
  sourceId: string,
  dicts: readonly { dictKey: string; relations: string[] }[],
  maxRows: number,
): Promise<StatsRange[]> {
  const res = await apiRequest<{ ranges: StatsRange[] }>(`${base(sourceId)}/stats-plan`, {
    method: 'POST',
    body: JSON.stringify({ dicts, maxRows }),
  })
  return res.ranges
}

/** An event relation the last counting run counted the records of. */
export interface CountedRelation {
  relation: string
  /** Of its SQL and its dictionary's when counted (countedRelationSignature). */
  signature: string | null
  /** Whether it holds any of the concepts asked about. */
  holds: boolean
}

/** The relations the last counting run counted, and which hold any of `conceptIds`. */
export async function getCountedRelations(sourceId: string, conceptIds: readonly number[]): Promise<CountedRelation[]> {
  const res = await apiRequest<{ relations: CountedRelation[] }>(`${base(sourceId)}/relations`, {
    method: 'POST',
    body: JSON.stringify({ conceptIds }),
  })
  return res.relations
}

/** Detail-panel stats for one concept — precomputed by the counting run, or
 *  shared by a click — undefined if neither exists. */
export async function getConceptStats<T>(
  sourceId: string,
  conceptId: number,
  dictKey?: string,
): Promise<T | undefined> {
  try {
    const query = dictKey ? `?dictKey=${encodeURIComponent(dictKey)}` : ''
    const res = await apiRequest<{ stats: T }>(
      `/data-sources/${encodeURIComponent(sourceId)}/concept-stats/${conceptId}${query}`,
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
