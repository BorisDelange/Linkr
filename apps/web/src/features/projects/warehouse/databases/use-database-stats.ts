import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { computeDatabaseStats, statsJobName, streamTableCounts, type StatsPhase } from '@/lib/duckdb/database-stats'
import { hasRememberedJob } from '@/lib/duckdb/run-query-job'
import { useDataSourceStore } from '@/stores/data-source-store'
import { localized } from '@/lib/localized'
import type { DatabaseStatsCache, SchemaMapping } from '@/types'
import { clearPatientQueries } from '../patient-data/patient-prefetch'

// Shared across hook instances: the sheet mounts useDatabaseStats twice (summary
// cards + table list). Without this, both would launch the full recompute at
// once for the same source. Keyed by dataSourceId → the in-flight refresh promise.
const _inFlight = new Map<string, Promise<void>>()
/** The stop of each in-flight refresh, shared the same way. */
const _controllers = new Map<string, AbortController>()
/** Every mounted instance per source, fed the live statistics of a refresh any
 *  of them started — a tab left and reopened mid-run shows the run, not a
 *  fresh "Load statistics" that would start a second one. */
const _listeners = new Map<string, Set<(stats: DatabaseStatsCache) => void>>()

function publish(dataSourceId: string, stats: DatabaseStatsCache) {
  for (const listener of _listeners.get(dataSourceId) ?? []) listener(stats)
}
const BUSY_DELAY_MS = 400

export function useDatabaseStats(dataSourceId: string, schemaMapping: SchemaMapping, sourceStatus?: string) {
  const [cache, setCache] = useState<DatabaseStatsCache | null>(null)
  // Mounted mid-run: busy from the first render, so the debounce below does not
  // show Refresh before Stop.
  const [isLoading, setIsLoading] = useState(() => _inFlight.has(dataSourceId))
  const [isStopping, setIsStopping] = useState(() => !!_controllers.get(dataSourceId)?.signal.aborted)
  const [error, setError] = useState<unknown>(null)
  const [cacheLoaded, setCacheLoaded] = useState(false)
  const cacheRef = useRef<DatabaseStatsCache | null>(null)
  cacheRef.current = cache
  const autoRefreshed = useRef(false)

  const { t, i18n } = useTranslation()
  const sourceName = useDataSourceStore((s) => s.dataSources.find((d) => d.id === dataSourceId)?.name)
  const jobLabel = t('databases.stats_job', { name: sourceName ? localized(sourceName, i18n.language) : dataSourceId })
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const recordRowCounts = useDataSourceStore((s) => s.recordRowCounts)
  const keepCounts = useCallback((stats: DatabaseStatsCache) => {
    if (!schemaMapping.patient) return
    recordRowCounts(dataSourceId, {
      patientCount: stats.summary.patientCount,
      visitCount: schemaMapping.visit ? stats.summary.visitCount : undefined,
    }).catch(() => {})
  }, [dataSourceId, schemaMapping, recordRowCounts])
  const keepCountsRef = useRef(keepCounts)
  keepCountsRef.current = keepCounts

  useEffect(() => {
    autoRefreshed.current = false
    setCacheLoaded(false)
    setCache(null)
    let cancelled = false
    getStorage().databaseStatsCache.get(dataSourceId).then((cached) => {
      if (cached && !cancelled) {
        setCache(cached)
        // Backfills the card of a database whose statistics predate the counts
        // being kept on the source.
        keepCountsRef.current(cached)
      }
    }).catch(() => {}).finally(() => { if (!cancelled) setCacheLoaded(true) })
    const listeners = _listeners.get(dataSourceId) ?? new Set()
    _listeners.set(dataSourceId, listeners)
    listeners.add(setCache)
    return () => {
      cancelled = true
      listeners.delete(setCache)
    }
  }, [dataSourceId])

  /** `resume`: only follow the job of that phase a closed tab left (server
   *  mode) — the statistics, then the table counts as a refresh does; or the
   *  table counts alone. */
  const compute = useCallback(async (resume?: StatsPhase) => {
    setIsLoading(true)
    // The error stays up through the retry and goes only once it succeeds: a
    // retry refused at once would otherwise flash the band away and back.
    try {
      // Dedupe across the sheet's two hook instances: only one compute runs per
      // source. The owner streams live updates into its own state; a concurrent
      // instance awaits the shared promise, then loads the final cache from IDB.
      const existing = _inFlight.get(dataSourceId)
      if (existing) {
        await existing
        const cached = await getStorage().databaseStatsCache.get(dataSourceId)
        if (cached) setCache(cached)
        setError(null)
        return
      }

      const controller = new AbortController()
      const { signal } = controller
      _controllers.set(dataSourceId, controller)
      // Statistics are recomputed when the data is taken to have changed: the
      // patient rows kept for the session may no longer be what it holds.
      if (!resume) clearPatientQueries(dataSourceId)
      const previous = cacheRef.current
      const run = (async () => {
        await ensureMounted(dataSourceId)
        // Fast block first (patients/visits/age/gender/timeline) — renders in a
        // few seconds. Persist it right away so switching tabs (which unmounts
        // this panel) reloads from cache instead of recomputing from zero.
        let stats: DatabaseStatsCache
        if (resume === 'counts' && previous) {
          stats = previous
        } else {
          stats = await computeDatabaseStats(dataSourceId, schemaMapping, { signal, label: jobLabel, resumeOnly: resume === 'stats' })
          publish(dataSourceId, stats)
          setError(null)
          await getStorage().databaseStatsCache.save(stats)
          keepCounts(stats)
        }

        // Per-table counts stream in afterwards, batch by batch, persisting after
        // each batch so a mid-stream tab switch keeps the counts gathered so far.
        // They start from the previous counts and replace them table by table,
        // so a stopped run keeps the old count of every table it did not reach.
        let running: DatabaseStatsCache = { ...stats, tableCounts: previous?.tableCounts ?? [] }
        await streamTableCounts(dataSourceId, schemaMapping, (batch) => {
          const fresh = new Set(batch.map((c) => c.tableName))
          running = {
            ...running,
            tableCounts: [...running.tableCounts.filter((c) => !fresh.has(c.tableName)), ...batch]
              .sort((a, b) => b.rowCount - a.rowCount),
          }
          publish(dataSourceId, running)
          getStorage().databaseStatsCache.save(running).catch(() => {})
        }, { signal, label: jobLabel, resumeOnly: resume === 'counts' })
      })()
      _inFlight.set(dataSourceId, run)
      try {
        await run
      } finally {
        _inFlight.delete(dataSourceId)
        _controllers.delete(dataSourceId)
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.error('Failed to compute database stats:', err)
        setError(err)
      }
    } finally {
      setIsLoading(false)
      setIsStopping(false)
    }
  }, [dataSourceId, schemaMapping, ensureMounted, keepCounts, jobLabel])
  const refresh = useCallback(() => compute(), [compute])

  // A refresh already running when this instance mounts: follow it.
  useEffect(() => {
    if (!_inFlight.has(dataSourceId)) return
    void compute()
  }, [dataSourceId, compute])

  // A computation a closed tab left on the server: follow it rather than lose it.
  const resumed = useRef<string | null>(null)
  useEffect(() => {
    if (!isServerMode() || !cacheLoaded || resumed.current === dataSourceId || _inFlight.has(dataSourceId)) return
    resumed.current = dataSourceId
    if (hasRememberedJob(statsJobName(dataSourceId, 'stats'))) void compute('stats')
    else if (hasRememberedJob(statsJobName(dataSourceId, 'counts'))) void compute('counts')
  }, [cacheLoaded, dataSourceId, compute])

  /** Stop the refresh: the queries in flight are cancelled (server mode
   *  interrupts them), and what was already computed stays. */
  const stop = useCallback(() => {
    const controller = _controllers.get(dataSourceId)
    if (!controller || controller.signal.aborted) return
    setIsStopping(true)
    controller.abort()
  }, [dataSourceId])

  // Auto-compute stats only in front-only mode. In server mode the source may be
  // a database of billions of rows, so we never run COUNT(*) automatically — the
  // user triggers computation explicitly via refresh() ("Load statistics").
  useEffect(() => {
    if (isServerMode()) return
    if (!cacheLoaded || isLoading || autoRefreshed.current) return
    if (sourceStatus && sourceStatus !== 'connected') return
    if (!cache || !cache.genderDistribution) {
      autoRefreshed.current = true
      refresh()
    }
  }, [cache, cacheLoaded, isLoading, refresh, sourceStatus])

  // `cacheLoaded`: the stored statistics have been looked up — until then an
  // empty `cache` means "not read yet", not "never computed".
  // Shown busy only once a run has lasted a moment: one that fails at once (an
  // ETL run holding the database) flipped Refresh to Stop and back in a blink.
  const settledLoading = useDebouncedValue(isLoading, BUSY_DELAY_MS)
  return { cache, isLoading: isLoading && settledLoading, isStopping, error, refresh, stop, cacheLoaded }
}
