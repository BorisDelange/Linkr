import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'
import { queryDataSource, queryDataSourceAll } from '@/lib/duckdb/engine'
import { useDataSourceStore } from '@/stores/data-source-store'
import { DEFAULT_PROFILE_OPTIONS, availableSections, resolveProfileSource } from '@/lib/concept-mapping/concept-profile'
import { DEFAULT_EXTRACTION_SORT } from '@/lib/concept-mapping/source-extraction'
import { clearRunError, getRunSnapshot, pauseRun, startRun, watchRun, type RunSnapshot } from '@/lib/concept-mapping/extraction-runner'
import { SECTION_KEYS, exactOptions, sectionSet, sectionsOf, type SectionKey } from '@/lib/concept-profiles/profile-store'
import { batchProfileStore, profileStore, type ProfileStoreSummary } from '@/lib/concept-profiles/profile-store-backend'
import { dataFingerprint } from '@/lib/concept-profiles/fingerprint'

export interface ConceptProfilesView {
  /** The sections the database's schema can produce. */
  offered: SectionKey[]
  /** What the next run computes for each concept: the last run's, until changed. */
  sections: SectionKey[]
  setSections: (sections: SectionKey[]) => void
  summary: ProfileStoreSummary | null
  running: boolean
  /** Counting the concepts' rows before the first profile (`ranking`). */
  preparing: boolean
  error: string | null
  /** Concepts profiled, of those with records. */
  done: number
  total: number
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
  pause: () => void
  /** Bumped when a run stops: what it stored can be read. */
  version: number
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
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const key = runKey(dataSourceId)
  const [snapshot, setSnapshot] = useState<RunSnapshot>(() => getRunSnapshot(key))
  const [summary, setSummary] = useState<ProfileStoreSummary | null>(null)
  const [picked, setPicked] = useState<{ dataSourceId: string; sections: SectionKey[] } | null>(null)
  const [current, setCurrent] = useState<{ fingerprint: string; checking: boolean } | null>(null)
  const [version, setVersion] = useState(0)

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
  const { running } = snapshot
  useEffect(() => {
    if (running) return
    let cancelled = false
    const settle = (s: ProfileStoreSummary | null) => {
      if (cancelled) return
      setSummary(s)
      setVersion((v) => v + 1)
    }
    profileStore().summary(dataSourceId).then(settle, () => settle(null))
    return () => { cancelled = true }
  }, [running, dataSourceId])

  const query = useCallback((sql: string) => queryDataSource(dataSourceId, sql, { heavy: true }), [dataSourceId])
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
  const done = (running ? snapshot.extracted : null) ?? run?.extracted ?? 0
  const total = (running ? snapshot.total : null) ?? run?.total ?? 0
  const finished = !running && !!run && total > 0 && done >= total

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
    startRun({
      projectId: key,
      mapping: schemaMapping,
      sources,
      options,
      sort: DEFAULT_EXTRACTION_SORT,
      onlyWithRecords: true,
      resumeFrom: resume && run && !fresh ? { extracted: run.extracted, total: run.total, sizes: run.sizes, walked: run.walked } : null,
      query: (sql, signal) => queryDataSource(dataSourceId, sql, { signal }),
      queryAll: (sql, signal) => queryDataSourceAll(dataSourceId, sql, { signal }),
      queryAggregate: (sql, signal) => queryDataSource(dataSourceId, sql, { signal, allRows: true, heavy: true }),
      persist: async (state) => {
        await profileStore().saveRun(dataSourceId, { ...state, fingerprint })
      },
      persistError: async (message) => {
        if (run) await profileStore().saveRun(dataSourceId, { ...run, error: message, updatedAt: new Date().toISOString() })
      },
      store: async () => {
        fingerprint = await dataFingerprint(schemaMapping, query)
        setCurrent({ fingerprint, checking: false })
        return batchProfileStore(dataSourceId, fingerprint)
      },
    })
  }, [key, ensureMounted, dataSourceId, sections, schemaMapping, sources, run, query])

  return {
    offered,
    sections,
    setSections: (next) => setPicked({ dataSourceId, sections: SECTION_KEYS.filter((k) => next.includes(k)) }),
    summary,
    running,
    preparing: running && snapshot.phase !== 'extracting',
    error: snapshot.error,
    done,
    total,
    finished,
    current: finished && sameSections,
    resumable: !!run && sameSections && !finished && done > 0,
    stale: current && !current.checking && summary ? summary.count - (summary.fingerprints[current.fingerprint] ?? 0) : null,
    checking: !!current?.checking,
    check,
    start,
    pause: () => pauseRun(key),
    version,
  }
}
