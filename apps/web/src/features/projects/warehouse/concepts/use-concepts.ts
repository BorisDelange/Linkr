import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { queryDataSource, discoverTables } from '@/lib/duckdb/engine'
import { isServerMode } from '@/lib/api-client'
import {
  getConceptCacheStatus,
  refreshConceptCache,
  queryConceptCache,
  getConceptStats,
  saveConceptStats,
} from '@/lib/api/concept-cache'
import type { SchemaMapping } from '@/types'
import {
  computeAvailableColumns,
  buildFilterOptionsQuery,
  buildConceptsQuery,
  buildConceptsCountQuery,
  buildConceptsMaterializeQuery,
  buildConceptFullQuery,
  buildDomainCountQuery,
  buildValueDistributionQuery,
  buildValueHistogramQuery,
  hasValueColumnForDict,
  buildCachePageQuery,
  buildCacheCountQuery,
  buildCacheFilterOptionsQuery,
  buildCacheDetailQuery,
  EMPTY_FILTERS,
} from './concept-queries'
import type { ConceptFilters, ConceptSorting } from './concept-queries'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A concept row is a generic record with guaranteed id/name fields. */
export interface ConceptRow {
  concept_id: number
  concept_name: string
  record_count: number
  patient_count: number
  _dict_key?: string
  [key: string]: unknown
}

export interface MeasurementDistribution {
  total_count: number
  non_null_count: number
  min_val: number
  max_val: number
  mean_val: number
  median_val: number
  std_val: number
}

export interface HistogramBin {
  bin_start: number
  count: number
  /** Rows dropped by the P1–P99 clip (same value on every bin). */
  excluded_count?: number
}

/** Bumped when the histogram SQL changes, so shared-cache rows written by an
 *  older build are recomputed instead of served. */
export const HISTOGRAM_VARIANT = 'p1p99'

export interface ConceptStats {
  /** Which histogram SQL produced `histogram` (absent on pre-clip rows). */
  histogramVariant?: string
  rowCount: number
  distribution?: MeasurementDistribution
  histogram?: HistogramBin[]
}

// ---------------------------------------------------------------------------
// Module-level state cache (survives component unmount/remount)
// ---------------------------------------------------------------------------

interface CachedResult {
  concepts: ConceptRow[]
  totalCount: number
}

interface CachedState {
  filters: ConceptFilters
  sorting: ConceptSorting | null
  page: number
  pageSize: number
  selectedConceptId: number | null
  filterOptions: Record<string, string[]>
  statsCache: Map<number, ConceptStats>
  resultCache: Map<string, CachedResult>
}

const stateCache = new Map<string, CachedState>()

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConcepts(dataSourceId: string | undefined, schemaMapping: SchemaMapping | undefined) {
  const cached = dataSourceId ? stateCache.get(dataSourceId) : undefined

  const [hasConceptTable, setHasConceptTable] = useState<boolean | null>(null)
  const [filters, setFilters] = useState<ConceptFilters>(cached?.filters ?? EMPTY_FILTERS)
  const [sorting, setSorting] = useState<ConceptSorting | null>(cached?.sorting ?? { columnId: 'record_count', desc: true })
  const [debouncedTextFilters, setDebouncedTextFilters] = useState<ConceptFilters>(cached?.filters ?? EMPTY_FILTERS)
  const [page, setPage] = useState(cached?.page ?? 0)
  const [pageSize, setPageSize] = useState(cached?.pageSize ?? 50)
  const [concepts, setConcepts] = useState<ConceptRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [isLoading, setIsLoading] = useState(false)

  const resultCache = useRef<Map<string, CachedResult>>(cached?.resultCache ?? new Map())
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>(cached?.filterOptions ?? {})

  const [selectedConceptId, setSelectedConceptId] = useState<number | null>(cached?.selectedConceptId ?? null)
  const [selectedConcept, setSelectedConcept] = useState<Record<string, unknown> | null>(null)
  const [conceptStatsLoading, setConceptStatsLoading] = useState(false)
  const [conceptStats, setConceptStats] = useState<ConceptStats | null>(null)

  const statsCache = useRef<Map<number, ConceptStats>>(cached?.statsCache ?? new Map())

  // Server mode: the concept list (with counts) is materialized to a shared
  // Parquet cache; the page reads from it. `cacheReady` gates page queries on the
  // cache existing; `lastRefreshed` is its file mtime; `countsRefreshing` drives
  // the Refresh spinner. Front-only mode ignores all this (queries the source).
  const [cacheReady, setCacheReady] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null)
  const [countsRefreshing, setCountsRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [statsEnabled, setStatsEnabled] = useState(true)
  const [excludeOutliers, setExcludeOutliers] = useState(true)
  const refreshToken = useRef(0)
  // Whether the cache status has come back yet — the auto-build must not fire
  // before we know there is genuinely no cache.
  const [cacheChecked, setCacheChecked] = useState(false)

  // The concept whose stats are the ones we currently want shown. A slow load
  // for a previously-clicked concept must not clobber a newer selection, and a
  // cached click must render instantly regardless of an in-flight request.
  const activeStatsConceptId = useRef<number | null>(null)

  // Refs to track latest values for the unmount cleanup
  const latestRef = useRef({ filters, sorting, page, pageSize, selectedConceptId, filterOptions })
  latestRef.current = { filters, sorting, page, pageSize, selectedConceptId, filterOptions }

  // Save state to module-level cache on unmount
  useEffect(() => {
    return () => {
      if (dataSourceId) {
        const s = latestRef.current
        stateCache.set(dataSourceId, {
          filters: s.filters,
          sorting: s.sorting,
          page: s.page,
          pageSize: s.pageSize,
          selectedConceptId: s.selectedConceptId,
          filterOptions: s.filterOptions,
          statsCache: statsCache.current,
          resultCache: resultCache.current,
        })
      }
    }

  }, [dataSourceId])

  // Server mode: check whether the source already has a materialized cache, so
  // page queries can read it (and the "last refreshed" time is shown). Front-only
  // needs none of this.
  useEffect(() => {
    setCacheReady(false)
    setLastRefreshed(null)
    setCacheChecked(false)
    if (!dataSourceId || !isServerMode()) return
    let cancelled = false
    getConceptCacheStatus(dataSourceId).then((status) => {
      if (cancelled) return
      setCacheReady(status.exists)
      setLastRefreshed(status.refreshedAt ? new Date(status.refreshedAt * 1000).toISOString() : null)
      setCacheChecked(true)
    }).catch(() => {
      if (!cancelled) setCacheChecked(true)
    })
    return () => { cancelled = true }
  }, [dataSourceId])

  // ---------------------------------------------------------------------------
  // Available columns (derived from schema mapping)
  // ---------------------------------------------------------------------------

  // Stabilize the reference: `?? []` would otherwise mint a fresh empty array
  // each render, churning availableColumns and re-triggering every dependent
  // effect (notably the concepts fetch) on remount.
  const dicts = useMemo(() => schemaMapping?.conceptTables ?? [], [schemaMapping])
  const availableColumns = useMemo(() => computeAvailableColumns(dicts), [dicts])

  // ---------------------------------------------------------------------------
  // Debounce text-based search fields
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedTextFilters((prev) => {
        const next = { ...prev }
        next._searchText = filters._searchText ?? null
        next._searchId = filters._searchId ?? null
        next._searchCode = filters._searchCode ?? null
        return next
      })
      setPage(0)
    }, 300)
    return () => clearTimeout(timer)
  }, [filters._searchText, filters._searchId, filters._searchCode])

  // Effective filters: non-text filters are immediate, text filters are debounced
  const effectiveFilters = useMemo<ConceptFilters>(() => {
    const ef = { ...filters }
    ef._searchText = debouncedTextFilters._searchText ?? null
    ef._searchId = debouncedTextFilters._searchId ?? null
    ef._searchCode = debouncedTextFilters._searchCode ?? null
    return ef
  }, [filters, debouncedTextFilters])

  // Stable key for non-text filters (to trigger reload)
  const dropdownFilterKey = useMemo(() => {
    return availableColumns
      .filter((c) => c.filterable)
      .map((c) => filters[c.id] ?? '')
      .join('|')
  }, [availableColumns, filters])

  // ---------------------------------------------------------------------------
  // Check if concept table exists
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!dataSourceId || dicts.length === 0) {
      setHasConceptTable(dicts.length === 0 ? false : null)
      return
    }
    discoverTables(dataSourceId).then((tables) => {
      // At least one concept dict table must exist
      setHasConceptTable(dicts.some((d) => tables.includes(d.table)))
    }).catch(() => {
      setHasConceptTable(false)
    })
  }, [dataSourceId, dicts])

  // ---------------------------------------------------------------------------
  // Load filter options (distinct values for filterable columns)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || hasConceptTable !== true) return
    const server = isServerMode()
    // Server mode: options come from the cache Parquet (needs it built first).
    if (server && !cacheReady) return

    const loadOptions = async () => {
      try {
        const filterableCols = availableColumns.filter((c) => c.filterable && c.source !== 'dict')
        const results: Record<string, string[]> = {}

        await Promise.all(
          filterableCols.map(async (col) => {
            const sql = server
              ? buildCacheFilterOptionsQuery(col.id)
              : buildFilterOptionsQuery(schemaMapping, col.id)
            if (!sql) return
            const rows = server
              ? await queryConceptCache(dataSourceId, sql)
              : await queryDataSource(dataSourceId, sql)
            results[col.id] = rows.map((r) => String(r.val))
          }),
        )

        // For _dict_key, generate from the dicts themselves
        if (dicts.length > 1) {
          results._dict_key = dicts.map((d) => d.key)
        }

        setFilterOptions(results)
      } catch (err) {
        console.error('Failed to load filter options:', err)
      }
    }
    loadOptions()
  }, [dataSourceId, schemaMapping, hasConceptTable, cacheReady, availableColumns, dicts])

  // ---------------------------------------------------------------------------
  // Load concepts when filters or page change
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || hasConceptTable !== true) return

    const server = isServerMode()

    // Server mode: read the page from the materialized Parquet cache (flat table
    // `concepts`, counts already columns). If no cache exists yet, show nothing —
    // the user builds it with Refresh. Front-only: query the source directly, with
    // counts computed inline (fast in-browser DuckDB-WASM).
    if (server && !cacheReady) {
      setConcepts([])
      setTotalCount(0)
      setIsLoading(false)
      return
    }

    const conceptsSql = server
      ? buildCachePageQuery(effectiveFilters, availableColumns, page, pageSize, sorting)
      : buildConceptsQuery(schemaMapping, effectiveFilters, availableColumns, page, pageSize, sorting, true)
    const countSql = server
      ? buildCacheCountQuery(effectiveFilters, availableColumns)
      : buildConceptsCountQuery(schemaMapping, effectiveFilters, availableColumns)
    if (!conceptsSql || !countSql) {
      setConcepts([])
      setTotalCount(0)
      return
    }

    // The SQL deterministically encodes filters + page + sorting, so it doubles
    // as the cache key: a remount with restored UI state hits the cache and skips
    // the refetch (preserving filters/page across navigation).
    const cacheKey = `${dataSourceId}::${conceptsSql}`
    const hit = resultCache.current.get(cacheKey)
    if (hit) {
      setConcepts(hit.concepts)
      setTotalCount(hit.totalCount)
      setIsLoading(false)
      return
    }

    const run = (sql: string) =>
      server ? queryConceptCache(dataSourceId, sql) : queryDataSource(dataSourceId, sql)

    let cancelled = false
    const load = async () => {
      setIsLoading(true)
      try {
        const [rows, countResult] = await Promise.all([run(conceptsSql), run(countSql)])
        if (cancelled) return
        const loadedConcepts = rows as unknown as ConceptRow[]
        const loadedTotal = Number(countResult[0]?.cnt ?? 0)
        resultCache.current.set(cacheKey, { concepts: loadedConcepts, totalCount: loadedTotal })
        setConcepts(loadedConcepts)
        setTotalCount(loadedTotal)
      } catch (err) {
        if (cancelled) return
        console.error('Failed to load concepts:', err)
        setConcepts([])
        setTotalCount(0)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSourceId, schemaMapping, hasConceptTable, cacheReady, debouncedTextFilters._searchText, debouncedTextFilters._searchId, debouncedTextFilters._searchCode, dropdownFilterKey, page, pageSize, sorting, availableColumns])

  // ---------------------------------------------------------------------------
  // Load selected concept details
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || selectedConceptId === null) {
      setSelectedConcept(null)
      setConceptStats(null)
      return
    }

    // Find the _dict_key for the selected concept
    const row = concepts.find((c) => c.concept_id === selectedConceptId)
    const dictKey = (row?._dict_key as string) ?? dicts[0]?.key

    const load = async () => {
      try {
        // Server mode: the concept row is already in the cache Parquet, so the
        // detail reads from it (no source round-trip). Front-only queries source.
        if (isServerMode()) {
          const rows = await queryConceptCache(dataSourceId, buildCacheDetailQuery(selectedConceptId))
          if (rows.length > 0) setSelectedConcept(rows[0] as Record<string, unknown>)
          return
        }
        const sql = buildConceptFullQuery(schemaMapping, selectedConceptId, dictKey)
        if (!sql) return
        const rows = await queryDataSource(dataSourceId, sql)
        if (rows.length > 0) {
          setSelectedConcept(rows[0] as Record<string, unknown>)
        }
      } catch (err) {
        console.error('Failed to load concept detail:', err)
      }
    }
    load()
  }, [dataSourceId, schemaMapping, selectedConceptId, concepts, dicts])

  // ---------------------------------------------------------------------------
  // Load concept stats (with cache)
  // ---------------------------------------------------------------------------

  const loadConceptStats = useCallback(async (conceptId: number, dictKey: string) => {
    if (!dataSourceId || !schemaMapping) return

    // This concept is now the one we want shown. Any older in-flight load that
    // resolves later will see it's no longer active and skip its state updates.
    activeStatsConceptId.current = conceptId
    const isStale = () => activeStatsConceptId.current !== conceptId

    const cachedStats = statsCache.current.get(conceptId)
    if (cachedStats) {
      // Instant: cached clicks render immediately and clear any leftover spinner
      // from a still-running load for a different concept.
      setConceptStats(cachedStats)
      setConceptStatsLoading(false)
      return
    }

    setConceptStatsLoading(true)

    // Server mode: check the shared server cache first — another user may have
    // already computed these stats. On a hit, render without touching the source.
    if (isServerMode() && excludeOutliers) {
      try {
        const shared = await getConceptStats<ConceptStats>(dataSourceId, conceptId)
        // The shared cache is keyed by concept id alone, so entries written
        // before the outlier clip existed hold a raw histogram (one bar plus a
        // few spikes). `histogramVariant` tags what a row actually contains —
        // anything else is recomputed rather than trusted.
        if (shared && (!shared.histogram?.length || shared.histogramVariant === HISTOGRAM_VARIANT)) {
          statsCache.current.set(conceptId, shared)
          if (!isStale()) {
            setConceptStats(shared)
            setConceptStatsLoading(false)
          }
          return
        }
      } catch {
        // Fall through to compute.
      }
    }

    try {
      const countSql = buildDomainCountQuery(schemaMapping, dictKey, conceptId)
      if (!countSql) {
        if (!isStale()) setConceptStats(null)
        return
      }

      const countResult = await queryDataSource(dataSourceId, countSql)
      const rowCount = Number(countResult[0]?.cnt ?? 0)

      let distribution: MeasurementDistribution | undefined
      let histogram: HistogramBin[] | undefined

      if (rowCount > 0 && hasValueColumnForDict(schemaMapping, dictKey)) {
        try {
          const distSql = buildValueDistributionQuery(schemaMapping, dictKey, conceptId)
          const histSql = buildValueHistogramQuery(schemaMapping, dictKey, conceptId, 20, excludeOutliers)
          if (distSql && histSql) {
            const [distRows, histRows] = await Promise.all([
              queryDataSource(dataSourceId, distSql),
              queryDataSource(dataSourceId, histSql),
            ])
            if (distRows.length > 0) {
              distribution = distRows[0] as unknown as MeasurementDistribution
            }
            histogram = histRows as unknown as HistogramBin[]
          }
        } catch {
          // Value-specific queries may fail
        }
      }

      const stats: ConceptStats = {
        rowCount,
        distribution,
        histogram,
        ...(excludeOutliers ? { histogramVariant: HISTOGRAM_VARIANT } : {}),
      }
      statsCache.current.set(conceptId, stats)
      // Share the computed stats with every user of this source — but only the
      // default (outliers excluded) form: the shared cache is keyed by concept
      // id alone, so storing a raw histogram would serve it to everyone.
      if (isServerMode() && excludeOutliers) {
        saveConceptStats(dataSourceId, conceptId, stats).catch(() => {})
      }
      // Only apply if this is still the selected concept — a newer click wins.
      if (!isStale()) setConceptStats(stats)
    } catch (err) {
      console.error('Failed to load concept stats:', err)
      if (!isStale()) setConceptStats(null)
    } finally {
      // Only the latest request controls the shared loading flag.
      if (!isStale()) setConceptStatsLoading(false)
    }
  }, [dataSourceId, schemaMapping, excludeOutliers])

  // Toggling the outlier clip changes the histogram SQL, and the stats cache is
  // keyed by concept id alone — drop it so the panel re-queries.
  const firstOutlierRun = useRef(true)
  useEffect(() => {
    if (firstOutlierRun.current) {
      firstOutlierRun.current = false
      return
    }
    statsCache.current.clear()
    setConceptStats(null)
  }, [excludeOutliers])

  // Auto-load stats when selected concept changes. With stats off, drop what is
  // on screen: keeping it would show the previous concept's histogram under the
  // newly selected one.
  useEffect(() => {
    if (!statsEnabled) {
      setConceptStats(null)
      setConceptStatsLoading(false)
      return
    }
    if (selectedConceptId !== null) {
      const row = concepts.find((c) => c.concept_id === selectedConceptId)
      const dictKey = (row?._dict_key as string) ?? dicts[0]?.key
      if (dictKey) {
        loadConceptStats(selectedConceptId, dictKey)
      }
    }
  }, [selectedConceptId, concepts, dicts, loadConceptStats, statsEnabled])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  // Rebuild the shared cache. Server mode: materialize the full enriched list
  // (concepts + counts) to Parquet on the server, then flip cacheReady so page
  // queries read from it. The server writes atomically (a temp file swapped in),
  // so other users keep seeing the previous cache until this one is ready.
  // Front-only has no server cache — Refresh just clears the volatile caches so
  // the source is re-queried.
  const refresh = useCallback(async () => {
    if (!dataSourceId || !schemaMapping) return
    const token = ++refreshToken.current
    statsCache.current.clear()
    resultCache.current.clear()
    setConceptStats(null)
    setRefreshError(null)

    if (!isServerMode()) {
      setCacheReady(false)
      setCacheReady(true)  // re-trigger the list effect (front-only queries source)
      return
    }

    setCountsRefreshing(true)
    try {
      const cols = computeAvailableColumns(schemaMapping.conceptTables ?? [])
      const selectSql = buildConceptsMaterializeQuery(schemaMapping, cols)
      if (!selectSql) {
        setRefreshError('no_concept_table')
        return
      }
      const status = await refreshConceptCache(dataSourceId, selectSql)
      if (refreshToken.current !== token) return
      setLastRefreshed(status.refreshedAt ? new Date(status.refreshedAt * 1000).toISOString() : new Date().toISOString())
      setCacheReady(true)
    } catch (err) {
      console.error('Failed to refresh concept cache:', err)
      if (refreshToken.current === token) {
        setRefreshError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (refreshToken.current === token) setCountsRefreshing(false)
    }
  }, [dataSourceId, schemaMapping])

  // First visit on a source with no cache: build it automatically instead of
  // waiting for a click. Keyed by source id so it fires once per source and does
  // not retry in a loop after a failure (the error banner offers a manual retry).
  const autoBuilt = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!dataSourceId || !schemaMapping || !isServerMode()) return
    if (!cacheChecked || cacheReady || countsRefreshing) return
    if (autoBuilt.current.has(dataSourceId)) return
    autoBuilt.current.add(dataSourceId)
    refresh()
  }, [dataSourceId, schemaMapping, cacheChecked, cacheReady, countsRefreshing, refresh])

  const updateFilter = useCallback((key: string, value: string | null) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
    // Text search fields reset page via debounce, others reset immediately
    if (!key.startsWith('_search')) {
      setPage(0)
    }
  }, [])

  const updateSorting = useCallback((columnId: string) => {
    setSorting((prev) => {
      if (!prev || prev.columnId !== columnId) return { columnId, desc: false }
      if (!prev.desc) return { columnId, desc: true }
      return null
    })
    setPage(0)
  }, [])

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  // Server mode with no cache yet: signal it so the page can prompt for a first
  // Refresh instead of showing an empty table with no explanation.
  const needsRefresh = concepts.length === 0 && !cacheReady && isServerMode()

  return {
    hasConceptTable,
    availableColumns,
    filters,
    updateFilter,
    sorting,
    updateSorting,
    page,
    setPage,
    pageSize,
    setPageSize,
    concepts,
    totalCount,
    totalPages,
    isLoading,
    filterOptions,
    selectedConceptId,
    setSelectedConceptId,
    selectedConcept,
    conceptStats,
    conceptStatsLoading,
    refresh,
    lastRefreshed,
    countsRefreshing,
    refreshError,
    needsRefresh,
    statsEnabled,
    setStatsEnabled,
    excludeOutliers,
    setExcludeOutliers,
  }
}
