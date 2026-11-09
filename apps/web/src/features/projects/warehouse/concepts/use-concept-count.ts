import { useEffect, useMemo, useState } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'
import { isServerMode } from '@/lib/api-client'
import { getConceptCacheStatus } from '@/lib/api/concept-cache'
import { ACTIVE_RUN_STATUSES } from '@/lib/api/server-runs'
import type { ConceptRun, ConceptRunState } from '@/lib/api/concept-runs'
import { useServerRun } from '@/hooks/use-server-run'
import { conceptCountProgress, countableSteps, type ConceptCountProgress, type ConceptCountStep } from './concept-count-plan'
import { IDLE_COUNT, type ConceptCountSnapshot } from './concept-count-runner'

interface StoredStatus {
  dataSourceId: string
  mappingKey: string
  exists: boolean
  refreshedAt: string | null
  progress: ConceptCountProgress
}

export interface ConceptCountView {
  /** Server mode: the list can only come from the cache this loads. */
  enabled: boolean
  /** The steps with something to count: not one whose count every dictionary
   *  already holds (`record_count`, `patient_count`). */
  countable: Readonly<Record<ConceptCountStep, boolean>>
  /** The cache status has come back. */
  checked: boolean
  /** A list has been assembled (possibly partial). */
  exists: boolean
  refreshedAt: string | null
  /** Where the stored run stands. */
  progress: ConceptCountProgress
  /** The counts the database's server run is on, if it is. */
  live: ConceptCountSnapshot
  /** Bumped whenever the assembled list may have changed: reload it. */
  version: number
}

/**
 * The concepts cache of a database and its counts: the stored state the server
 * reports, and the run going on in this browser. Every view of the database's concepts — the
 * Concepts tab, the project's Concepts page, the concept pickers — reads it.
 *
 * `mappingKey` identifies the mapping's content: the server drops the list when
 * the mapping changes, so a view that stays mounted across the change re-reads
 * the state rather than go on reporting the old list as loaded.
 */
export function useConceptCount(dataSourceId: string | undefined, mapping: SchemaMapping | undefined, mappingKey: string): ConceptCountView {
  const enabled = isServerMode() && !!dataSourceId
  // The counts are the first stage of the database's server run.
  const server = useServerRun<ConceptRunState>('stats', dataSourceId, enabled)
  const live = useMemo(() => (enabled ? countSnapshotOf(server.run) : IDLE_COUNT), [enabled, server.run])
  // Tagged with its database and mapping, so neither a switch of database nor a
  // changed mapping shows the previous list as loaded.
  const [stored, setStored] = useState<StoredStatus | null>(null)
  const status = stored?.dataSourceId === dataSourceId && stored?.mappingKey === mappingKey ? stored : null
  const [version, setVersion] = useState(0)

  // Re-read the stored state when a run starts, assembles, or ends, and when the
  // mapping changes.
  useEffect(() => {
    if (!enabled || !dataSourceId) return
    let cancelled = false
    const store = (s: Omit<StoredStatus, 'dataSourceId' | 'mappingKey'>) => {
      if (cancelled) return
      setStored({ dataSourceId, mappingKey, ...s })
      setVersion((v) => v + 1)
    }
    getConceptCacheStatus(dataSourceId).then((s) => store({
      exists: s.exists,
      refreshedAt: s.refreshedAt ? new Date(s.refreshedAt * 1000).toISOString() : null,
      progress: conceptCountProgress(s.run),
    })).catch(() => store({ exists: false, refreshedAt: null, progress: conceptCountProgress(null) }))
    return () => { cancelled = true }
  }, [enabled, dataSourceId, live.running, live.assembled, mappingKey])

  return {
    enabled,
    countable: countableSteps(mapping),
    checked: !enabled || status !== null,
    exists: status?.exists ?? false,
    refreshedAt: status?.refreshedAt ?? null,
    progress: status?.progress ?? conceptCountProgress(null),
    live,
    version,
  }
}

/** The counting stage of a server run, as the browser's run reports itself. */
export function countSnapshotOf(run: ConceptRun | null): ConceptCountSnapshot {
  const state = run?.state ?? {}
  const counting = !!run && ACTIVE_RUN_STATUSES.includes(run.status) && state.stage === 'counts'
  const step = (s: 'records' | 'patients') => state.counts?.[s] ?? { done: 0, total: 0 }
  const phase = state.phase === 'records' || state.phase === 'patients' || state.phase === 'assembling' ? state.phase : null
  return {
    running: counting,
    error: run?.status === 'failed' && state.stage === 'counts' ? run.error : null,
    phase: counting ? phase : null,
    records: step('records'),
    patients: step('patients'),
    phaseStartedAt: null,
    planningStep: null,
    reading: null,
    assembled: state.assembled ?? 0,
  }
}
