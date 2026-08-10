import { apiRequest } from '@/lib/api-client'
import type {
  CatalogResultStorage,
  DatabaseStatsCacheStorage,
  EtlQualityCacheStorage,
} from '@/lib/storage'
import type { CatalogResultCache, DatabaseStatsCache, EtlQualityCache } from '@/types'

/** Server-side shared cache wire shape (see StatsCacheResponse). */
interface StatsCacheWire {
  computedAt: string
  payload: Record<string, unknown>
}

/** Shared database-statistics cache. Stored once per data source on the server so
 *  every project member reuses the same computed payload instead of recomputing
 *  into their own browser IndexedDB. The reset button deletes it for everyone. */
export const apiDatabaseStatsCacheStorage: DatabaseStatsCacheStorage = {
  async get(dataSourceId) {
    const wire = await apiRequest<StatsCacheWire | null>(
      `/data-sources/${dataSourceId}/stats-cache`,
    )
    if (!wire) return undefined
    return { ...(wire.payload as object), dataSourceId, computedAt: wire.computedAt } as DatabaseStatsCache
  },
  async save(cache) {
    const { dataSourceId, computedAt, ...payload } = cache
    await apiRequest(`/data-sources/${dataSourceId}/stats-cache`, {
      method: 'PUT',
      body: JSON.stringify({ computedAt, payload }),
    })
  },
  async delete(dataSourceId) {
    await apiRequest(`/data-sources/${dataSourceId}/stats-cache`, { method: 'DELETE' })
  },
}

/** Shared catalog-results cache, same pattern keyed by catalog id. */
export const apiCatalogResultStorage: CatalogResultStorage = {
  async get(catalogId) {
    const wire = await apiRequest<StatsCacheWire | null>(
      `/data-catalogs/${catalogId}/results-cache`,
    )
    if (!wire) return undefined
    return { ...(wire.payload as object), catalogId, computedAt: wire.computedAt } as CatalogResultCache
  },
  async save(cache) {
    const { catalogId, computedAt, ...payload } = cache
    await apiRequest(`/data-catalogs/${catalogId}/results-cache`, {
      method: 'PUT',
      body: JSON.stringify({ computedAt, payload }),
    })
  },
  async delete(catalogId) {
    await apiRequest(`/data-catalogs/${catalogId}/results-cache`, { method: 'DELETE' })
  },
}

/** Shared ETL quality-check table, same pattern keyed by pipeline id. Recomputing
 *  it means a dozen COUNT queries over the target, so one member's computation
 *  serves the whole workspace. */
export const apiEtlQualityCacheStorage: EtlQualityCacheStorage = {
  async get(pipelineId) {
    const wire = await apiRequest<StatsCacheWire | null>(
      `/etl-pipelines/${pipelineId}/quality-cache`,
    )
    if (!wire) return undefined
    return { ...(wire.payload as object), pipelineId, computedAt: wire.computedAt } as EtlQualityCache
  },
  async save(cache) {
    const { pipelineId, computedAt, ...payload } = cache
    await apiRequest(`/etl-pipelines/${pipelineId}/quality-cache`, {
      method: 'PUT',
      body: JSON.stringify({ computedAt, payload }),
    })
  },
  async delete(pipelineId) {
    await apiRequest(`/etl-pipelines/${pipelineId}/quality-cache`, { method: 'DELETE' })
  },
}
