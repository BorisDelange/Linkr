import { useEffect, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { queryConceptCache } from '@/lib/api/concept-cache'
import { queryDataSource } from '@/lib/duckdb/engine'
import type { SchemaMapping } from '@/types'
import { buildCacheDetailQuery, buildConceptFullQuery } from './concept-queries'

type ConceptInfo = Record<string, unknown>

const known = new Map<string, Promise<ConceptInfo | null>>()

/**
 * One concept's row, as the concept list shows it: from the concepts cache in
 * server mode — never the remote dictionary — else from the source. Null when
 * it cannot be read (not loaded, or not in the dictionary). Read once per
 * session and database.
 */
export function fetchConceptInfo(dataSourceId: string, mapping: SchemaMapping, conceptId: number): Promise<ConceptInfo | null> {
  const key = `${dataSourceId}::${conceptId}`
  let pending = known.get(key)
  if (!pending) {
    const read = async () => {
      if (isServerMode()) return queryConceptCache(dataSourceId, buildCacheDetailQuery(conceptId))
      const sql = buildConceptFullQuery(mapping, conceptId)
      return sql ? queryDataSource(dataSourceId, sql) : []
    }
    pending = read().then((rows) => rows[0] ?? null, () => {
      known.delete(key)
      return null
    })
    known.set(key, pending)
  }
  return pending
}

/** `fetchConceptInfo` once `enabled` — on the first hover, say. */
export function useConceptInfo(
  dataSourceId: string | undefined,
  mapping: SchemaMapping | undefined,
  conceptId: number,
  enabled: boolean,
): { info: ConceptInfo | null; loading: boolean } {
  const [state, setState] = useState<{ key: string; info: ConceptInfo | null } | null>(null)
  const key = `${dataSourceId}::${conceptId}`
  useEffect(() => {
    if (!enabled || !dataSourceId || !mapping) return
    let live = true
    void fetchConceptInfo(dataSourceId, mapping, conceptId).then((info) => { if (live) setState({ key, info }) })
    return () => { live = false }
  }, [enabled, dataSourceId, mapping, conceptId, key])
  const done = state?.key === key
  return { info: done ? state.info : null, loading: enabled && !done }
}
