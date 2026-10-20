import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'
import { isServerMode } from '@/lib/api-client'
import { getConceptCacheStatus } from '@/lib/api/concept-cache'
import { conceptCountProgress, countableSteps, type ConceptCountProgress, type ConceptCountStep } from './concept-count-plan'
import {
  getConceptCountRun,
  pauseConceptCount,
  startConceptCount,
  watchConceptCountRun,
  type ConceptCountSnapshot,
} from './concept-count-runner'

interface StoredStatus {
  dataSourceId: string
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
  /** The live run in this browser, if any. */
  live: ConceptCountSnapshot
  /** Bumped whenever the assembled list may have changed: reload it. */
  version: number
  /** `steps`: what to count; none loads the dictionary alone. A step left out
   *  waits for a later start. */
  start: (restart: boolean, steps: readonly ConceptCountStep[]) => void
  pause: () => void
}

/**
 * The concepts cache of a database and its counts: the stored state the server
 * reports, and the run going on in this browser. Every view of the database's concepts — the
 * Concepts tab, the project's Concepts page, the concept pickers — reads it.
 */
export function useConceptCount(dataSourceId: string | undefined, mapping: SchemaMapping | undefined): ConceptCountView {
  const enabled = isServerMode() && !!dataSourceId
  const key = dataSourceId ?? ''
  const live = useSyncExternalStore(
    useCallback((notify: () => void) => watchConceptCountRun(key, notify), [key]),
    () => getConceptCountRun(key),
  )
  // Tagged with its database, so switching database never shows the previous one's.
  const [stored, setStored] = useState<StoredStatus | null>(null)
  const status = stored?.dataSourceId === dataSourceId ? stored : null
  const [version, setVersion] = useState(0)

  // Re-read the stored state when a run starts, assembles, or ends.
  useEffect(() => {
    if (!enabled || !dataSourceId) return
    let cancelled = false
    const store = (s: Omit<StoredStatus, 'dataSourceId'>) => {
      if (cancelled) return
      setStored({ dataSourceId, ...s })
      setVersion((v) => v + 1)
    }
    getConceptCacheStatus(dataSourceId).then((s) => store({
      exists: s.exists,
      refreshedAt: s.refreshedAt ? new Date(s.refreshedAt * 1000).toISOString() : null,
      progress: conceptCountProgress(s.run),
    })).catch(() => store({ exists: false, refreshedAt: null, progress: conceptCountProgress(null) }))
    return () => { cancelled = true }
  }, [enabled, dataSourceId, live.running, live.assembled])

  const start = useCallback((restart: boolean, steps: readonly ConceptCountStep[]) => {
    if (!dataSourceId || !mapping) return
    startConceptCount({ dataSourceId, mapping, restart, steps })
  }, [dataSourceId, mapping])

  const pause = useCallback(() => {
    if (dataSourceId) pauseConceptCount(dataSourceId)
  }, [dataSourceId])

  return {
    enabled,
    countable: countableSteps(mapping),
    checked: !enabled || status !== null,
    exists: status?.exists ?? false,
    refreshedAt: status?.refreshedAt ?? null,
    progress: status?.progress ?? conceptCountProgress(null),
    live,
    version,
    start,
    pause,
  }
}
