import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { queryDataSource, discoverTables } from '@/lib/duckdb/engine'
import type { SchemaMapping } from '@/types'
import {
  computeAvailableColumns,
  buildFilterOptionsQuery,
  buildConceptsQuery,
  buildConceptsCountQuery,
  buildConceptFullQuery,
  buildDomainCountQuery,
  buildValueDistributionQuery,
  buildValueHistogramQuery,
  hasValueColumnForDict,
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
}

export interface ConceptStats {
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
  const [refreshTick, setRefreshTick] = useState(0)

  const resultCache = useRef<Map<string, CachedResult>>(cached?.resultCache ?? new Map())
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>(cached?.filterOptions ?? {})

  const [selectedConceptId, setSelectedConceptId] = useState<number | null>(cached?.selectedConceptId ?? null)
  const [selectedConcept, setSelectedConcept] = useState<Record<string, unknown> | null>(null)
  const [conceptStatsLoading, setConceptStatsLoading] = useState(false)
  const [conceptStats, setConceptStats] = useState<ConceptStats | null>(null)

  const statsCache = useRef<Map<number, ConceptStats>>(cached?.statsCache ?? new Map())

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

    const loadOptions = async () => {
      try {
        const filterableCols = availableColumns.filter((c) => c.filterable && c.source !== 'dict')
        const results: Record<string, string[]> = {}

        await Promise.all(
          filterableCols.map(async (col) => {
            const sql = buildFilterOptionsQuery(schemaMapping, col.id)
            if (!sql) return
            const rows = await queryDataSource(dataSourceId, sql)
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
  }, [dataSourceId, schemaMapping, hasConceptTable, availableColumns, dicts])

  // ---------------------------------------------------------------------------
  // Load concepts when filters or page change
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || hasConceptTable !== true) return

    const conceptsSql = buildConceptsQuery(schemaMapping, effectiveFilters, availableColumns, page, pageSize, sorting)
    const countSql = buildConceptsCountQuery(schemaMapping, effectiveFilters, availableColumns)
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

    let cancelled = false
    const load = async () => {
      setIsLoading(true)
      try {
        const [rows, countResult] = await Promise.all([
          queryDataSource(dataSourceId, conceptsSql),
          queryDataSource(dataSourceId, countSql),
        ])
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
  }, [dataSourceId, schemaMapping, hasConceptTable, debouncedTextFilters._searchText, debouncedTextFilters._searchId, debouncedTextFilters._searchCode, dropdownFilterKey, page, pageSize, sorting, availableColumns, refreshTick])

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
          const histSql = buildValueHistogramQuery(schemaMapping, dictKey, conceptId)
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

      const stats: ConceptStats = { rowCount, distribution, histogram }
      statsCache.current.set(conceptId, stats)
      // Only apply if this is still the selected concept — a newer click wins.
      if (!isStale()) setConceptStats(stats)
    } catch (err) {
      console.error('Failed to load concept stats:', err)
      if (!isStale()) setConceptStats(null)
    } finally {
      // Only the latest request controls the shared loading flag.
      if (!isStale()) setConceptStatsLoading(false)
    }
  }, [dataSourceId, schemaMapping])

  // Auto-load stats when selected concept changes
  useEffect(() => {
    if (selectedConceptId !== null) {
      const row = concepts.find((c) => c.concept_id === selectedConceptId)
      const dictKey = (row?._dict_key as string) ?? dicts[0]?.key
      if (dictKey) {
        loadConceptStats(selectedConceptId, dictKey)
      }
    }
  }, [selectedConceptId, concepts, dicts, loadConceptStats])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const resetCache = useCallback(() => {
    statsCache.current.clear()
    resultCache.current.clear()
    setConceptStats(null)
    setRefreshTick((t) => t + 1)
  }, [])

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
    resetCache,
  }
}
