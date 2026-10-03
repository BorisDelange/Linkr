import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'
import { isServerMode } from '@/lib/api-client'
import { conceptRelations, has } from '@/lib/schema-classes/relations'
import { getConceptCacheStatus } from '@/lib/api/concept-cache'
import { conceptCountProgress, type ConceptCountProgress } from './concept-count-plan'
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
  /** Server mode: the counted list can only come from the cache this computes. */
  enabled: boolean
  /** Every dictionary holds its own counts (`record_count`, `patient_count`):
   *  nothing to count. */
  held: boolean
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
  /** `recordsOnly`: stop once the rows are counted; a later start goes on with
   *  the patients. */
  start: (restart: boolean, recordsOnly?: boolean) => void
  pause: () => void
}

/**
 * The concept counts of a database: the stored state the server reports, and
 * the run going on in this browser. Every view of the database's concepts — the
 * Concepts tab, the project's Concepts page, the concept pickers — reads it.
 */
export function useConceptCount(dataSourceId: string | undefined, mapping: SchemaMapping | undefined): ConceptCountView {
  const held = countsHeld(mapping)
  const enabled = isServerMode() && !!dataSourceId && !held
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

  const start = useCallback((restart: boolean, recordsOnly = false) => {
    if (!dataSourceId || !mapping) return
    startConceptCount({ dataSourceId, mapping, restart, recordsOnly })
  }, [dataSourceId, mapping])

  const pause = useCallback(() => {
    if (dataSourceId) pauseConceptCount(dataSourceId)
  }, [dataSourceId])

  return {
    enabled,
    held,
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

function countsHeld(mapping: SchemaMapping | undefined): boolean {
  const dicts = mapping ? conceptRelations(mapping) : []
  return dicts.length > 0 && dicts.every((d) => has(d, 'record_count') && has(d, 'patient_count'))
}
