import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SchemaMapping } from '@/types/schema-mapping'
import { prepareQuerySql, queryDataSource, queryDataSourceAll } from '@/lib/duckdb/engine'
import { useDataSourceStore } from '@/stores/data-source-store'
import { DEFAULT_PROFILE_OPTIONS, availableSections, resolveProfileSource } from '@/lib/concept-mapping/concept-profile'
import { DEFAULT_EXTRACTION_SORT } from '@/lib/concept-mapping/source-extraction'
import { clearRunError, getRunSnapshot, pauseRun, startRun, watchRun, workDone, type RunSnapshot } from '@/lib/concept-mapping/extraction-runner'
import { SECTION_KEYS, exactOptions, sectionSet, sectionsOf, type SectionKey } from '@/lib/concept-profiles/profile-store'
import { batchProfileStore, profileStore, type ProfileStoreSummary } from '@/lib/concept-profiles/profile-store-backend'
import { dataFingerprint } from '@/lib/concept-profiles/fingerprint'
import { isServerMode } from '@/lib/api-client'
import { localized } from '@/lib/localized'
import { buildRunSpec, type RunCountSpec, type RunStepName } from '@/lib/concept-mapping/run-spec'
import { runShare, type ConceptRunState } from '@/lib/api/concept-runs'
import { useServerRun, type ServerRunView } from '@/hooks/use-server-run'
import { countedRecordsOf } from '@/features/projects/warehouse/concepts/counted-records'
import { conceptsJobGroup } from '@/features/projects/warehouse/concepts/concept-count-runner'

export interface ConceptProfilesView {
  /** The sections the database's schema can produce. */
  offered: SectionKey[]
  /** What the next run computes for each concept: the last run's, until changed. */
  sections: SectionKey[]
  setSections: (sections: SectionKey[]) => void
  summary: ProfileStoreSummary | null
  /** The summary has come back for this database. */
  loaded: boolean
  running: boolean
  /** Counting the concepts' rows before the first profile (`ranking`). */
  preparing: boolean
  error: string | null
  /** Concepts profiled, of those with records. */
  done: number
  total: number
  /** The share of the work done (0 to 1), the concepts weighed by their
   *  records; null when not known (not running, or unranked). */
  share: number | null
  /** The last run reached its end. */
  finished: boolean
  /** It did, for the sections asked now: nothing to compute. */
  current: boolean
  /** A paused run of the same sections, to go on with. */
  resumable: boolean
  /** Profiles computed on data that changed since; null until checked. */
  stale: number | null
  checking: boolean
  check: () => Promise<void>
  /** `fresh`: drop every stored profile first. */
  start: (opts: { resume: boolean; fresh?: boolean }) => Promise<void>
  /** Settles once the pause is asked; rejects when it could not be. */
  pause: () => Promise<void>
  /** A pause asked and not yet done: the query in flight is being stopped. */
  pausing: boolean
  /** Bumped when a run stops: what it stored can be read. */
  version: number
  /** Server mode: the database's run — its counts, then these statistics. */
  server: ServerRunView<ConceptRunState> | null
  /** Server mode: the run being compiled, before the server has it. */
  starting: boolean
  /** Server mode: start a run; the counts `counts` plans first when given, the
   *  statistics when `stats`. */
  startOnServer: (opts: { fresh: boolean; counts: (() => Promise<RunCountSpec>) | null; stats: boolean }) => Promise<void>
}

/** The run's key in the extraction registry: one per database, beside the projects'. */
const runKey = (dataSourceId: string) => `concept-profiles:${dataSourceId}`

/**
 * A database's concept profiles — the *Statistics* step of its Concepts tab:
 * what to compute for each concept, the run that computes it (paused, resumed —
 * it outlives the tab), and how much of the store is up to date with the data.
 * Every view describing a concept reads this store (lib/concept-profiles).
 */
export function useConceptProfiles(dataSourceId: string, schemaMapping: SchemaMapping): ConceptProfilesView {
  const { t, i18n } = useTranslation()
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const name = useDataSourceStore((s) => s.dataSources.find((d) => d.id === dataSourceId)?.name)
  const key = runKey(dataSourceId)
  const [snapshot, setSnapshot] = useState<RunSnapshot>(() => getRunSnapshot(key))
  const [stored, setStored] = useState<{ dataSourceId: string; summary: ProfileStoreSummary | null } | null>(null)
  const loaded = stored?.dataSourceId === dataSourceId
  const summary = loaded ? stored.summary : null
  const [picked, setPicked] = useState<{ dataSourceId: string; sections: SectionKey[] } | null>(null)
  const [current, setCurrent] = useState<{ fingerprint: string; checking: boolean } | null>(null)
  const [version, setVersion] = useState(0)
  const onServer = isServerMode()
  const serverRun = useServerRun<ConceptRunState>('stats', dataSourceId, onServer)
  const [starting, setStarting] = useState(false)

  const sources = useMemo(
    () => (schemaMapping.concepts ?? [])
      .map((d) => resolveProfileSource(schemaMapping, d.key))
      .filter((s): s is NonNullable<typeof s> => !!s),
    [schemaMapping],
  )
  const offered = useMemo(
    () => SECTION_KEYS.filter((k) => sources.some((s) => availableSections(schemaMapping, s)[k])),
    [sources, schemaMapping],
  )

  useEffect(() => {
    setSnapshot(getRunSnapshot(key))
    return watchRun(key, setSnapshot)
  }, [key])
  const runState = serverRun.run?.state
  const running = onServer ? serverRun.active && runState?.stage !== 'counts' : snapshot.running
  const busy = onServer ? serverRun.active : snapshot.running
  useEffect(() => {
    if (busy) return
    let cancelled = false
    const settle = (s: ProfileStoreSummary | null) => {
      if (cancelled) return
      setStored({ dataSourceId, summary: s })
      setVersion((v) => v + 1)
    }
    profileStore().summary(dataSourceId).then(settle, () => settle(null))
    return () => { cancelled = true }
  }, [busy, dataSourceId])

  const query = useCallback((sql: string) => queryDataSource(dataSourceId, sql, { heavy: true, origin: 'Concept profiles · read profiles' }), [dataSourceId])
  const check = useCallback(async () => {
    setCurrent((c) => ({ fingerprint: c?.fingerprint ?? '', checking: true }))
    try {
      setCurrent({ fingerprint: await dataFingerprint(schemaMapping, query), checking: false })
    } catch {
      setCurrent(null)
    }
  }, [schemaMapping, query])

  const run = summary?.run ?? null
  const chosen = picked?.dataSourceId === dataSourceId ? picked.sections : run ? sectionsOf(run.options.sections) : offered
  const sections = chosen.filter((k) => offered.includes(k))
  const sameSections = !!run && sectionsOf(run.options.sections).join() === sections.join()
  // A server run's own counts while it goes on or stands paused; the stored run's otherwise.
  const live = onServer
    ? (serverRun.active || serverRun.resumable) && runState?.total != null ? { extracted: runState.done ?? 0, total: runState.total } : null
    : running ? { extracted: snapshot.extracted, total: snapshot.total } : null
  const done = live?.extracted ?? run?.extracted ?? 0
  const total = live?.total ?? run?.total ?? 0
  const finished = !running && !!run && total > 0 && done >= total
  const serverError = onServer && serverRun.run && ['failed', 'interrupted'].includes(serverRun.run.status) && runState?.stage !== 'counts'
    ? serverRun.run.error
    : null

  const start = useCallback(async ({ resume, fresh = false }: { resume: boolean; fresh?: boolean }) => {
    clearRunError(key)
    try {
      await ensureMounted(dataSourceId)
      if (fresh) await profileStore().clear(dataSourceId)
    } catch (err) {
      setSnapshot((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }))
      return
    }
    const options = exactOptions({ ...DEFAULT_PROFILE_OPTIONS, sections: sectionSet(sections) })
    let fingerprint = ''
    const group = conceptsJobGroup(dataSourceId)
    startRun({
      projectId: key,
      mapping: schemaMapping,
      sources,
      options,
      sort: DEFAULT_EXTRACTION_SORT,
      onlyWithRecords: true,
      resumeFrom: resume && run && !fresh ? { extracted: run.extracted, total: run.total, sizes: run.sizes, walked: run.walked } : null,
      query: (sql, signal) => queryDataSource(dataSourceId, sql, { signal, origin: 'Concept profiles · build list', group }),
      queryAll: (sql, signal) => queryDataSourceAll(dataSourceId, sql, { signal, origin: 'Concept profiles · build list', group }),
      queryAggregate: (sql, signal) => queryDataSource(dataSourceId, sql, { signal, allRows: true, heavy: true, origin: 'Concept profiles · compute', group }),
      persist: async (state) => {
        await profileStore().saveRun(dataSourceId, { ...state, fingerprint })
      },
      persistError: async (message, last) => {
        const stored = last ? { ...last, fingerprint } : run
        if (stored) await profileStore().saveRun(dataSourceId, { ...stored, error: message, updatedAt: new Date().toISOString() })
      },
      countedRecords: countedRecordsOf(dataSourceId, schemaMapping),
      store: async () => {
        fingerprint = await dataFingerprint(schemaMapping, (sql) => queryDataSource(dataSourceId, sql, { heavy: true, origin: 'Concept profiles · read profiles', group }))
        setCurrent({ fingerprint, checking: false })
        return batchProfileStore(dataSourceId, fingerprint)
      },
    })
  }, [key, ensureMounted, dataSourceId, sections, schemaMapping, sources, run])

  const startOnServer = useCallback(async ({ fresh, counts, stats }: { fresh: boolean; counts: (() => Promise<RunCountSpec>) | null; stats: boolean }) => {
    setStarting(true)
    setSnapshot((s) => ({ ...s, error: null }))
    try {
      await ensureMounted(dataSourceId)
      const planned = counts ? await counts() : null
      const prepare = (sql: string) => prepareQuerySql(dataSourceId, sql)
      const fingerprint = stats ? await dataFingerprint(schemaMapping, query) : ''
      // Several steps: one job, its steps listed under it.
      const steps: RunStepName[] = [
        ...(planned?.steps ?? []).map(({ step }) => ({ key: step, label: t(`concepts.count_step_${step}`) })),
        ...(stats ? [{ key: 'stats' as const, label: t('concepts.count_step_stats') }] : []),
      ]
      const spec = await buildRunSpec({
        label: t(planned ? 'concepts.job_group' : 'concepts.profiles_job_label', { name: localized(name, i18n.language) }),
        steps,
        mapping: schemaMapping,
        sources: stats ? sources : [],
        options: exactOptions({ ...DEFAULT_PROFILE_OPTIONS, sections: sectionSet(sections) }),
        sort: DEFAULT_EXTRACTION_SORT,
        onlyWithRecords: true,
        fingerprint,
        prepare,
        counts: planned,
        fresh: fresh && stats,
      })
      if (fingerprint) setCurrent({ fingerprint, checking: false })
      await serverRun.start(spec)
    } catch (err) {
      setSnapshot((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setStarting(false)
    }
  }, [ensureMounted, dataSourceId, schemaMapping, query, t, name, i18n.language, sources, sections, serverRun])

  return {
    offered,
    sections,
    setSections: (next) => setPicked({ dataSourceId, sections: SECTION_KEYS.filter((k) => next.includes(k)) }),
    summary,
    loaded,
    running,
    preparing: onServer ? running && runState?.stage === 'ranking' : running && snapshot.phase !== 'extracting',
    error: onServer ? serverError ?? serverRun.error ?? snapshot.error : snapshot.error,
    done,
    total,
    share: onServer
      ? running && serverRun.run && runState?.stage === 'batches' ? runShare(serverRun.run) : null
      : running && snapshot.work ? workDone(snapshot.work, done) : null,
    finished,
    current: finished && sameSections,
    // Begun, even with nothing saved yet: resuming it keeps its order.
    resumable: onServer ? serverRun.resumable : !!run && sameSections && !finished,
    stale: current && !current.checking && summary ? summary.count - (summary.fingerprints[current.fingerprint] ?? 0) : null,
    checking: !!current?.checking,
    check,
    start,
    pause: () => {
      if (onServer) return serverRun.pause()
      pauseRun(key)
      return Promise.resolve()
    },
    pausing: onServer ? serverRun.run?.status === 'pausing' : !!snapshot.pausing,
    version,
    server: onServer ? serverRun : null,
    starting,
    startOnServer,
  }
}
