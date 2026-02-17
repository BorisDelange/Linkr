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
import type { ConceptFilters, ConceptSorting, ColumnDescriptor } from './concept-queries'

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
// Hook
// ---------------------------------------------------------------------------

export function useConcepts(dataSourceId: string | undefined, schemaMapping: SchemaMapping | undefined) {
  const [hasConceptTable, setHasConceptTable] = useState<boolean | null>(null)
  const [filters, setFilters] = useState<ConceptFilters>(EMPTY_FILTERS)
  const [sorting, setSorting] = useState<ConceptSorting | null>({ columnId: 'record_count', desc: true })
  const [debouncedTextFilters, setDebouncedTextFilters] = useState<ConceptFilters>(EMPTY_FILTERS)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [concepts, setConcepts] = useState<ConceptRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})

  const [selectedConceptId, setSelectedConceptId] = useState<number | null>(null)
  const [selectedConcept, setSelectedConcept] = useState<Record<string, unknown> | null>(null)
  const [conceptStatsLoading, setConceptStatsLoading] = useState(false)
  const [conceptStats, setConceptStats] = useState<ConceptStats | null>(null)

  const statsCache = useRef<Map<number, ConceptStats>>(new Map())

  // ---------------------------------------------------------------------------
  // Available columns (derived from schema mapping)
  // ---------------------------------------------------------------------------

  const dicts = schemaMapping?.conceptTables ?? []
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

    const load = async () => {
      setIsLoading(true)
      try {
        const conceptsSql = buildConceptsQuery(schemaMapping, effectiveFilters, availableColumns, page, pageSize, sorting)
        const countSql = buildConceptsCountQuery(schemaMapping, effectiveFilters, availableColumns)
        if (!conceptsSql || !countSql) {
          setConcepts([])
          setTotalCount(0)
          return
        }
        const [rows, countResult] = await Promise.all([
          queryDataSource(dataSourceId, conceptsSql),
          queryDataSource(dataSourceId, countSql),
        ])
        setConcepts(rows as unknown as ConceptRow[])
        setTotalCount(Number(countResult[0]?.cnt ?? 0))
      } catch (err) {
        console.error('Failed to load concepts:', err)
        setConcepts([])
        setTotalCount(0)
      } finally {
        setIsLoading(false)
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSourceId, schemaMapping, hasConceptTable, debouncedTextFilters._searchText, debouncedTextFilters._searchId, debouncedTextFilters._searchCode, dropdownFilterKey, page, pageSize, sorting, availableColumns])

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

    const cached = statsCache.current.get(conceptId)
    if (cached) {
      setConceptStats(cached)
      return
    }

    setConceptStatsLoading(true)
    try {
      const countSql = buildDomainCountQuery(schemaMapping, dictKey, conceptId)
      if (!countSql) {
        setConceptStats(null)
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
      setConceptStats(stats)
    } catch (err) {
      console.error('Failed to load concept stats:', err)
      setConceptStats(null)
    } finally {
      setConceptStatsLoading(false)
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
