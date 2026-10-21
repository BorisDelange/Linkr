import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { queryDataSource, discoverTables } from '@/lib/duckdb/engine'
import { conceptRelations } from '@/lib/schema-classes/relations'
import { isServerMode } from '@/lib/api-client'
import {
  queryConceptCache,
  diagnoseConceptStats,
  getConceptStats,
  saveConceptStats,
} from '@/lib/api/concept-cache'
import { useConceptCount } from './use-concept-count'
import { PRECOMPUTED_STATS_VARIANT } from './concept-count-plan'
import { tableListHas } from '@/lib/schema-helpers'
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
  buildCachePageQuery,
  buildCacheCountQuery,
  buildCacheFilterOptionsQuery,
  buildCacheDetailQuery,
  EMPTY_FILTERS,
  NULL_FILTER_VALUE,
} from './concept-queries'
import type { ConceptFilters, ConceptFilterValue, ConceptSorting } from './concept-queries'

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
  /** Quartiles, for the box plot. Absent on rows cached before it existed. */
  q1_val?: number
  q3_val?: number
}

export interface HistogramBin {
  bin_start: number
  count: number
  /** Rows dropped by the P1–P99 clip (same value on every bin). */
  excluded_count?: number
}

/** Bumped when the stats SQL changes, so shared-cache rows written by an older
 *  build are recomputed instead of served.
 *
 *  `p1p99-union`: value stats used to read a single event table — whichever the
 *  mapping happened to declare first — so a concept stored elsewhere cached a
 *  row with a real rowCount but an empty distribution and no histogram. Reading
 *  every value-bearing table fixed the query, and this bump is what stops those
 *  rows from being served forever. */
export const HISTOGRAM_VARIANT = 'p1p99-union-q'

/**
 * Whether a row from the shared cache may be served as-is.
 *
 * The cache is keyed by concept id alone, so a row written by an older build can
 * hold stats the current query no longer produces. `histogramVariant` tags what
 * a row actually contains; anything else is recomputed rather than trusted.
 *
 * An empty histogram is checked too. It used to be waved through as "nothing to
 * be stale about", which is exactly backwards: a concept whose values live in a
 * table the old query never read cached a real rowCount with an empty
 * distribution, and that emptiness was then served forever — the fixed query
 * never got a chance to run. Only a row with no distribution at all is trusted
 * without a matching tag: nothing was ever computed for it, so nothing is stale.
 */
export function isFreshCachedStats(stats: ConceptStats): boolean {
  if (stats.histogramVariant === HISTOGRAM_VARIANT || stats.histogramVariant === PRECOMPUTED_STATS_VARIANT) return true
  return !stats.histogram?.length && !stats.distribution
}

export interface ConceptStats {
  /** Which histogram SQL produced `histogram` (absent on pre-clip rows). */
  histogramVariant?: string
  rowCount: number
  distribution?: MeasurementDistribution
  histogram?: HistogramBin[]
}

// ---------------------------------------------------------------------------
// Module-level caches (survive component unmount/remount)
// ---------------------------------------------------------------------------

/**
 * Which view is browsing the concepts. Each view keeps its own filters, sort and
 * page, so narrowing the list in a picker does not narrow the Concepts page.
 * A picker keeps nothing between openings: it starts from the defaults.
 */
export type ConceptsScope = 'project' | 'database' | 'picker'

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
}

const stateCache = new Map<string, CachedState>()

// Data, unlike the UI state, is the same for every view of a database: a page
// fetched by the Concepts page is served to a picker asking for the same SQL.
const resultCaches = new Map<string, Map<string, CachedResult>>()
// Per database and outlier setting, keyed by `statsKey`: a concept id is only
// unique within its dictionary.
const statsCaches = new Map<string, Map<string, ConceptStats>>()
const RESULT_CACHE_LIMIT = 200

function cacheFor<K, V>(caches: Map<string, Map<K, V>>, key: string): Map<K, V> {
  let cache = caches.get(key)
  if (!cache) {
    cache = new Map()
    caches.set(key, cache)
  }
  return cache
}

function rememberResult(cache: Map<string, CachedResult>, key: string, result: CachedResult) {
  cache.set(key, result)
  // Maps iterate in insertion order: the first key is the oldest page.
  if (cache.size > RESULT_CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
}

const statsInFlight = new Map<string, Promise<ConceptStats | null>>()

const statsKey = (dictKey: string, conceptId: number) => `${dictKey}::${conceptId}`

/** A load of these stats already running (computed or live), if any. */
function pendingConceptStats(
  dataSourceId: string,
  conceptId: number,
  dictKey: string,
  excludeOutliers: boolean,
): Promise<ConceptStats | null> | undefined {
  const flightKey = `${dataSourceId}::${excludeOutliers ? 'clip' : 'raw'}::${statsKey(dictKey, conceptId)}`
  return statsInFlight.get(flightKey) ?? statsInFlight.get(`${flightKey}::live`)
}

/**
 * One concept's stats when they cost no query on the source: this session's
 * copy, or (server mode, clipped form) the server's — precomputed by the
 * counting run or cached by an earlier load. Undefined when they would have to
 * be computed.
 */
export async function peekConceptStats(
  dataSourceId: string,
  conceptId: number,
  dictKey: string,
  excludeOutliers: boolean,
): Promise<ConceptStats | undefined> {
  const statsCache = cacheFor(statsCaches, `${dataSourceId}::${excludeOutliers ? 'clip' : 'raw'}`)
  const cached = statsCache.get(statsKey(dictKey, conceptId))
  if (cached) return cached
  if (!isServerMode() || !excludeOutliers) return undefined
  const shared = await getConceptStats<ConceptStats>(dataSourceId, conceptId, dictKey).catch(() => undefined)
  if (!shared || !isFreshCachedStats(shared)) return undefined
  statsCache.set(statsKey(dictKey, conceptId), shared)
  return shared
}

/**
 * One concept's stats as every view shows them — the detail panel and the row
 * popover alike: this session's copy, else (server mode, clipped form) the
 * server's — precomputed by the counting run or cached by an earlier click —
 * else computed on the source and shared. Concurrent asks for the same concept
 * share one load. `live`: straight from the source, past what the server holds.
 */
export function fetchConceptStats(
  dataSourceId: string,
  schemaMapping: SchemaMapping,
  conceptId: number,
  dictKey: string,
  excludeOutliers: boolean,
  { live = false }: { live?: boolean } = {},
): Promise<ConceptStats | null> {
  const cacheKey = `${dataSourceId}::${excludeOutliers ? 'clip' : 'raw'}`
  const statsCache = cacheFor(statsCaches, cacheKey)
  const cached = live ? undefined : statsCache.get(statsKey(dictKey, conceptId))
  if (cached) return Promise.resolve(cached)
  const flightKey = `${cacheKey}::${statsKey(dictKey, conceptId)}${live ? '::live' : ''}`
  const pending = statsInFlight.get(flightKey)
  if (pending) return pending

  const load = async (): Promise<ConceptStats | null> => {
    // Server mode: another user, or the counting run, may have computed these
    // already. On a hit, render without touching the source.
    if (!live) {
      const known = await peekConceptStats(dataSourceId, conceptId, dictKey, excludeOutliers)
      if (known) return known
    }

    const countSql = buildDomainCountQuery(schemaMapping, dictKey, conceptId)
    if (!countSql) return null
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
          if (distRows.length > 0) distribution = distRows[0] as unknown as MeasurementDistribution
          histogram = histRows as unknown as HistogramBin[]
        }
      } catch {
        // Value-specific queries may fail (a non-numeric column): the count stands.
      }
    }

    const stats: ConceptStats = {
      rowCount,
      distribution,
      histogram,
      ...(excludeOutliers ? { histogramVariant: HISTOGRAM_VARIANT } : {}),
    }
    statsCache.set(statsKey(dictKey, conceptId), stats)
    // Share the computed stats with every user of this source — but only the
    // default (outliers excluded) form: the shared cache is keyed by concept
    // id alone, so storing a raw histogram would serve it to everyone.
    if (isServerMode() && excludeOutliers) {
      saveConceptStats(dataSourceId, conceptId, stats).catch(() => {})
    }
    return stats
  }

  const promise = load().finally(() => statsInFlight.delete(flightKey))
  statsInFlight.set(flightKey, promise)
  return promise
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConcepts(
  dataSourceId: string | undefined,
  schemaMapping: SchemaMapping | undefined,
  scope: ConceptsScope,
) {
  const persist = scope !== 'picker'
  const stateKey = dataSourceId ? `${scope}:${dataSourceId}` : undefined
  const cached = persist && stateKey ? stateCache.get(stateKey) : undefined

  // Tagged with its database: a hook remounted on another database (a picker
  // reopening) must read "not checked yet", not the previous answer — a stale
  // `false` flashed "No concepts found" before the skeleton.
  const [conceptTableCheck, setConceptTableCheck] = useState<{ dataSourceId: string | undefined; exists: boolean | null } | null>(null)
  const hasConceptTable = conceptTableCheck?.dataSourceId === dataSourceId ? conceptTableCheck?.exists ?? null : null
  const [filters, setFilters] = useState<ConceptFilters>(cached?.filters ?? EMPTY_FILTERS)
  const [sorting, setSorting] = useState<ConceptSorting | null>(cached?.sorting ?? { columnId: 'record_count', desc: true })
  const [debouncedTextFilters, setDebouncedTextFilters] = useState<ConceptFilters>(cached?.filters ?? EMPTY_FILTERS)
  const [page, setPage] = useState(cached?.page ?? 0)
  const [pageSize, setPageSize] = useState(cached?.pageSize ?? 50)
  const [concepts, setConcepts] = useState<ConceptRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  // Starts true: the very first render happens before the concept-table check
  // and the cache-status probe have run, and an empty table there reads as
  // "no concepts" rather than "not read yet".
  const [isLoading, setIsLoading] = useState(true)

  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>(cached?.filterOptions ?? {})

  const [selectedConceptId, setSelectedConceptId] = useState<number | null>(cached?.selectedConceptId ?? null)
  const [selectedConcept, setSelectedConcept] = useState<Record<string, unknown> | null>(null)
  const [conceptStatsLoading, setConceptStatsLoading] = useState(false)
  const [conceptStats, setConceptStats] = useState<ConceptStats | null>(null)
  // Why the selected concept's stats, or its row, could not be read — said in
  // the detail panel rather than an empty "no records" or "select a concept".
  const [conceptStatsError, setConceptStatsError] = useState<string | null>(null)
  // The selected concept's stats are not known without a query on the source:
  // they wait for the user to ask, one concept at a time.
  const [conceptStatsDeferred, setConceptStatsDeferred] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  // Server mode: the concept list is materialized to a shared Parquet cache,
  // loaded (with or without its counts) from the database's Concepts tab; every
  // view reads it, and reloads whenever a run assembles a newer one. Not loaded
  // yet, the list stays empty: the remote dictionary is never read, nor could it
  // run the fuzzy search. Front-only mode ignores all this (queries the source,
  // counts inline).
  const count = useConceptCount(dataSourceId, schemaMapping)
  const cacheReady = count.exists
  const cacheChecked = count.checked
  const [frontVersion, setFrontVersion] = useState(0)
  // Re-runs the loads when a run may have assembled a newer list. It is NOT the
  // cache key: it bumps on every status probe, so a picker reopened under the
  // same list would never hit the cache. The list's own mtime is the key.
  const listVersion = isServerMode() ? count.version : frontVersion
  const listStamp = isServerMode() ? (count.refreshedAt ?? '') : ''
  const [statsEnabled, setStatsEnabled] = useState(true)
  const [excludeOutliers, setExcludeOutliers] = useState(true)

  const resultCache = dataSourceId ? cacheFor(resultCaches, dataSourceId) : undefined
  // Keyed by the outlier setting too: the two histograms differ, and another
  // view may be showing the other one.
  const statsCache = dataSourceId
    ? cacheFor(statsCaches, `${dataSourceId}::${excludeOutliers ? 'clip' : 'raw'}`)
    : undefined

  // The concept whose stats are the ones we currently want shown. A slow load
  // for a previously-clicked concept must not clobber a newer selection, and a
  // cached click must render instantly regardless of an in-flight request.
  const activeStatsConceptId = useRef<number | null>(null)

  // Refs to track latest values for the unmount cleanup
  const latestRef = useRef({ filters, sorting, page, pageSize, selectedConceptId, filterOptions, totalCount })
  latestRef.current = { filters, sorting, page, pageSize, selectedConceptId, filterOptions, totalCount }

  // Save state to module-level cache on unmount
  useEffect(() => {
    return () => {
      if (persist && stateKey) {
        const s = latestRef.current
        stateCache.set(stateKey, {
          filters: s.filters,
          sorting: s.sorting,
          page: s.page,
          pageSize: s.pageSize,
          selectedConceptId: s.selectedConceptId,
          filterOptions: s.filterOptions,
        })
      }
    }
  }, [persist, stateKey])

  // Adopt the incoming database's state when it changes under a mounted hook.
  // The useState initializers above run once, so switching database otherwise
  // left the previous one's selection, filters and page in place — the detail
  // sidebar kept showing a concept that does not exist in the new database.
  // Skipped on the first render: the initializers already read the same cache.
  const adoptedRef = useRef(stateKey)
  useEffect(() => {
    if (adoptedRef.current === stateKey) return
    adoptedRef.current = stateKey

    const next = persist && stateKey ? stateCache.get(stateKey) : undefined
    setFilters(next?.filters ?? EMPTY_FILTERS)
    setDebouncedTextFilters(next?.filters ?? EMPTY_FILTERS)
    setSorting(next?.sorting ?? { columnId: 'record_count', desc: true })
    setPage(next?.page ?? 0)
    setPageSize(next?.pageSize ?? 50)
    setFilterOptions(next?.filterOptions ?? {})
    setSelectedConceptId(next?.selectedConceptId ?? null)
    // Derived from the selection; leaving them would keep the old concept's name
    // and numbers on screen until the new query lands.
    setSelectedConcept(null)
    setConceptStats(null)
    setConceptStatsError(null)
    setDetailError(null)
  }, [persist, stateKey])

  // ---------------------------------------------------------------------------
  // Available columns (derived from schema mapping)
  // ---------------------------------------------------------------------------

  // Stabilize the reference: `?? []` would otherwise mint a fresh empty array
  // each render, churning availableColumns and re-triggering every dependent
  // effect (notably the concepts fetch) on remount.
  const dicts = useMemo(() => (schemaMapping ? conceptRelations(schemaMapping) : []), [schemaMapping])
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

  // Stable key for the filters that apply immediately (no debounce): the column
  // dropdowns plus the toolbar search, which commits on Enter rather than per
  // keystroke. Multi-select values are arrays, so join them into the key.
  const dropdownFilterKey = useMemo(() => {
    const columnPart = availableColumns
      .filter((c) => c.filterable)
      .map((c) => {
        const v = filters[c.id]
        return Array.isArray(v) ? v.join(',') : (v ?? '')
      })
      .join('|')
    return `${columnPart}||${filters._searchFuzzy ?? ''}`
  }, [availableColumns, filters])

  // ---------------------------------------------------------------------------
  // Check if concept table exists
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!dataSourceId || dicts.length === 0) {
      setConceptTableCheck({ dataSourceId, exists: dicts.length === 0 ? false : null })
      return
    }
    let cancelled = false
    discoverTables(dataSourceId).then((tables) => {
      if (cancelled) return
      // At least one concept dict table must exist. Matched through `tableListHas`
      // because discovery reports qualified names (`icu.d_items`) for a source with
      // schemas, while the mapping keeps schema and table apart. A dictionary in
      // SQL names no table: trusted to exist.
      setConceptTableCheck({
        dataSourceId,
        exists: dicts.some((d) => !d.tables[0] || tableListHas(tables, d.tables[0])),
      })
    }).catch(() => {
      if (!cancelled) setConceptTableCheck({ dataSourceId, exists: false })
    })
    return () => { cancelled = true }
  }, [dataSourceId, dicts])

  // ---------------------------------------------------------------------------
  // Load filter options (distinct values for filterable columns)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || hasConceptTable !== true) return
    const server = isServerMode()
    if (server && !cacheReady) return

    const loadOptions = async () => {
      try {
        // 'conceptSet' columns have no SQL counterpart — their options come from
        // the imported dictionaries, not a SELECT DISTINCT on the source.
        const filterableCols = availableColumns.filter(
          (c) => c.filterable && c.source !== 'dict' && c.source !== 'conceptSet',
        )
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
            const values = rows.map((r) => String(r.val))
            // OMOP stores NULL for non-standard concepts, and the DISTINCT query
            // drops NULLs — add the sentinel so "NS" stays filterable.
            if (col.id === 'standard_concept') values.push(NULL_FILTER_VALUE)
            results[col.id] = values
          }),
        )

        // For _dict_key, generate from the dicts themselves
        if (dicts.length > 1) {
          results._dict_key = dicts.map((d) => d.key ?? '')
        }

        setFilterOptions(results)
      } catch (err) {
        console.error('Failed to load filter options:', err)
      }
    }
    loadOptions()
  }, [dataSourceId, schemaMapping, hasConceptTable, cacheReady, listVersion, availableColumns, dicts])

  // ---------------------------------------------------------------------------
  // Load concepts when filters or page change
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || hasConceptTable !== true) {
      // Nothing to load (no source, or the source has no concept table). The
      // page renders its own empty state, so stop the skeleton — but show it
      // while the concept-table check is still pending (hasConceptTable null).
      setIsLoading(hasConceptTable === null && !!dataSourceId && !!schemaMapping)
      return
    }

    // Server mode: read the page from the materialized Parquet cache (flat table
    // `concepts`, counts already columns). Front-only: the source, counted inline
    // (fast in-browser DuckDB-WASM).
    const server = isServerMode()
    if (server && !cacheReady) {
      // Unchecked, the table keeps its skeleton: reporting "not loading" would
      // render "No concepts found" over a cache not probed yet.
      setIsLoading(!cacheChecked)
      setConcepts([])
      setTotalCount(0)
      return
    }

    const conceptsSql = server
      ? buildCachePageQuery(effectiveFilters, availableColumns, page, pageSize, sorting)
      : buildConceptsQuery(schemaMapping, effectiveFilters, availableColumns, page, pageSize, sorting)
    const countSql = server
      ? buildCacheCountQuery(effectiveFilters, availableColumns)
      : buildConceptsCountQuery(schemaMapping, effectiveFilters, availableColumns)
    if (!conceptsSql || !countSql || !resultCache) {
      setConcepts([])
      setTotalCount(0)
      return
    }

    // The SQL deterministically encodes filters + page + sorting, so it doubles
    // as the cache key: a remount with restored UI state hits the cache and skips
    // the refetch (preserving filters/page across navigation).
    const cacheKey = `${listStamp}::${conceptsSql}`
    const hit = resultCache.get(cacheKey)
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
        rememberResult(resultCache, cacheKey, { concepts: loadedConcepts, totalCount: loadedTotal })
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
  }, [dataSourceId, schemaMapping, hasConceptTable, cacheReady, cacheChecked, listVersion, listStamp, resultCache, debouncedTextFilters._searchText, debouncedTextFilters._searchId, debouncedTextFilters._searchCode, dropdownFilterKey, page, pageSize, sorting, availableColumns])

  // ---------------------------------------------------------------------------
  // Load selected concept details
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setDetailError(null)
    if (!dataSourceId || !schemaMapping || selectedConceptId === null) {
      setSelectedConcept(null)
      setConceptStats(null)
      setConceptStatsError(null)
      return
    }

    // Find the _dict_key for the selected concept
    const row = concepts.find((c) => c.concept_id === selectedConceptId)
    const dictKey = (row?._dict_key as string) ?? dicts[0]?.key

    const load = async () => {
      try {
        // Server mode: the concept row is in the cache Parquet, never read from
        // the remote dictionary. Front-only queries the source.
        if (isServerMode()) {
          if (!cacheReady) return
          const rows = await queryConceptCache(dataSourceId, buildCacheDetailQuery(selectedConceptId))
          if (rows.length > 0) setSelectedConcept(rows[0] as Record<string, unknown>)
          else setDetailError('not found')
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
        setDetailError(err instanceof Error ? err.message : String(err))
      }
    }
    load()
  }, [dataSourceId, schemaMapping, selectedConceptId, concepts, dicts, cacheReady])

  // ---------------------------------------------------------------------------
  // Load concept stats (with cache)
  // ---------------------------------------------------------------------------

  /** `compute`: run the queries when nothing holds them yet. Without it a click
   *  only shows what is already known — on a large database, computing on every
   *  click would make browsing crawl. */
  const loadConceptStats = useCallback(async (conceptId: number, dictKey: string, compute: boolean) => {
    if (!dataSourceId || !schemaMapping || !statsCache) return

    // This concept is now the one we want shown. Any older in-flight load that
    // resolves later will see it's no longer active and skip its state updates.
    activeStatsConceptId.current = conceptId
    const isStale = () => activeStatsConceptId.current !== conceptId

    setConceptStatsError(null)
    setConceptStatsDeferred(false)
    const cachedStats = statsCache.get(statsKey(dictKey, conceptId))
    if (cachedStats) {
      // Instant: cached clicks render immediately and clear any leftover spinner
      // from a still-running load for a different concept.
      setConceptStats(cachedStats)
      setConceptStatsLoading(false)
      return
    }

    setConceptStatsLoading(true)
    try {
      // A peek while these stats are being computed waits for that load: its
      // "not known yet" would otherwise replace the spinner with the prompt.
      const pending = compute ? undefined : pendingConceptStats(dataSourceId, conceptId, dictKey, excludeOutliers)
      const stats = pending
        ? await pending
        : compute
          ? await fetchConceptStats(dataSourceId, schemaMapping, conceptId, dictKey, excludeOutliers)
          : await peekConceptStats(dataSourceId, conceptId, dictKey, excludeOutliers)
      // Only apply if this is still the selected concept — a newer click wins.
      if (!isStale()) {
        setConceptStats(stats ?? null)
        setConceptStatsDeferred(stats === undefined)
      }
    } catch (err) {
      console.error('Failed to load concept stats:', err)
      if (!isStale()) {
        setConceptStats(null)
        setConceptStatsError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      // Only the latest request controls the shared loading flag.
      if (!isStale()) setConceptStatsLoading(false)
    }
  }, [dataSourceId, schemaMapping, excludeOutliers, statsCache])

  const selectedRowDictKey = useMemo(() => {
    if (selectedConceptId === null) return undefined
    const row = concepts.find((c) => c.concept_id === selectedConceptId)
    return (row?._dict_key as string) ?? dicts[0]?.key
  }, [selectedConceptId, concepts, dicts])

  // Auto-load stats when the selected concept changes — keyed by the concept,
  // not the list: a list reloaded under a count run must not re-peek. With
  // stats off, drop what is on screen: keeping it would show the previous
  // concept's histogram under the newly selected one.
  useEffect(() => {
    if (!statsEnabled) {
      setConceptStats(null)
      setConceptStatsLoading(false)
      setConceptStatsDeferred(false)
      return
    }
    if (selectedConceptId !== null && selectedRowDictKey) {
      loadConceptStats(selectedConceptId, selectedRowDictKey, false)
    }
  }, [selectedConceptId, selectedRowDictKey, loadConceptStats, statsEnabled])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  // Front-only: re-query the source. Server mode computes the counts from the
  // database's Concepts tab (`useConceptCount`), never from a page that lists them.
  const refresh = useCallback(() => {
    if (dataSourceId) {
      resultCaches.delete(dataSourceId)
      statsCaches.delete(`${dataSourceId}::clip`)
      statsCaches.delete(`${dataSourceId}::raw`)
    }
    setConceptStats(null)
    setFrontVersion((v) => v + 1)
  }, [dataSourceId])

  const loadSelectedStats = () => {
    const dictKey = selectedRowDictKey
    if (selectedConceptId !== null && dictKey) loadConceptStats(selectedConceptId, dictKey, true)
  }

  // When the precomputed statistics hold no value for the selected concept: read
  // them from the source instead, or ask the server why.
  const computeStatsLive = async () => {
    const dictKey = selectedRowDictKey
    if (!dataSourceId || !schemaMapping || selectedConceptId === null || !dictKey) return
    const conceptId = selectedConceptId
    activeStatsConceptId.current = conceptId
    setConceptStatsLoading(true)
    setConceptStatsError(null)
    try {
      const stats = await fetchConceptStats(dataSourceId, schemaMapping, conceptId, dictKey, excludeOutliers, { live: true })
      if (activeStatsConceptId.current === conceptId) setConceptStats(stats)
    } catch (err) {
      if (activeStatsConceptId.current === conceptId) setConceptStatsError(err instanceof Error ? err.message : String(err))
    } finally {
      if (activeStatsConceptId.current === conceptId) setConceptStatsLoading(false)
    }
  }
  const diagnoseStats = () => {
    if (!dataSourceId || selectedConceptId === null) return Promise.resolve({})
    return diagnoseConceptStats(dataSourceId, selectedConceptId, selectedRowDictKey)
  }

  const updateFilter = useCallback((key: string, value: ConceptFilterValue) => {
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
  // The row as the list shows it until the detail lands — or when it fails: the
  // concept was clicked in the list, so it is never "nothing selected".
  const listedConcept = selectedConceptId === null ? null : concepts.find((c) => c.concept_id === selectedConceptId) ?? null
  const shownConcept = selectedConcept && Number(selectedConcept.concept_id) === selectedConceptId ? selectedConcept : listedConcept

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
    selectedConcept: shownConcept as Record<string, unknown> | null,
    detailError: shownConcept ? null : detailError,
    conceptStats,
    conceptStatsLoading,
    conceptStatsError,
    conceptStatsDeferred,
    loadSelectedStats,
    computeStatsLive: isServerMode() ? computeStatsLive : undefined,
    diagnoseStats: isServerMode() ? diagnoseStats : undefined,
    refresh,
    count,
    statsEnabled,
    setStatsEnabled,
    excludeOutliers,
    setExcludeOutliers,
  }
}
