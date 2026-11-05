import { useEffect, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { queryConceptCache } from '@/lib/api/concept-cache'
import { queryDataSource } from '@/lib/duckdb/engine'
import type { SchemaMapping } from '@/types'
import { LruMap } from '@/lib/lru-map'
import { buildCacheDetailQuery, buildCacheDetailsQuery, buildConceptFullQuery, buildConceptsFullQuery } from './concept-queries'

type ConceptInfo = Record<string, unknown>

const KNOWN_MAX = 5_000
/** How many concepts one query reads. */
const INFO_BATCH = 500

const known = new LruMap<string, Promise<ConceptInfo | null>>(KNOWN_MAX)

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
      return sql ? queryDataSource(dataSourceId, sql, { origin: `Concepts · details of ${conceptId}` }) : []
    }
    pending = read().then((rows) => rows[0] ?? null, () => {
      known.delete(key)
      return null
    })
    known.set(key, pending)
  }
  return pending
}

/**
 * fetchConceptInfo for several concepts, the ones not read yet in one query per
 * INFO_BATCH. An id absent from the map could not be read.
 */
export async function fetchConceptInfos(
  dataSourceId: string,
  mapping: SchemaMapping,
  conceptIds: readonly number[],
): Promise<Map<number, ConceptInfo | null>> {
  const ids = [...new Set(conceptIds.map(Number))].filter(Number.isSafeInteger)
  const keyOf = (id: number) => `${dataSourceId}::${id}`
  const pending = new Map<number, Promise<ConceptInfo | null>>()
  const unread: number[] = []
  for (const id of ids) {
    const hit = known.get(keyOf(id))
    if (hit) pending.set(id, hit)
    else unread.push(id)
  }
  for (let i = 0; i < unread.length; i += INFO_BATCH) {
    const batch = unread.slice(i, i + INFO_BATCH)
    const read = (async () => {
      const sql = isServerMode() ? buildCacheDetailsQuery(batch) : buildConceptsFullQuery(mapping, batch)
      if (!sql) return []
      return isServerMode()
        ? queryConceptCache(dataSourceId, sql)
        : queryDataSource(dataSourceId, sql, { origin: `Concepts · details of ${batch.length} concepts` })
    })()
    const byId = read.then((rows) => {
      const out = new Map<number, ConceptInfo>()
      for (const row of rows) {
        const id = Number(row.concept_id)
        if (!out.has(id)) out.set(id, row)
      }
      return out
    })
    for (const id of batch) {
      const one = byId.then((rows) => rows.get(id) ?? null, () => {
        known.delete(keyOf(id))
        return null
      })
      known.set(keyOf(id), one)
      pending.set(id, one)
    }
  }
  const out = new Map<number, ConceptInfo | null>()
  await Promise.all([...pending].map(async ([id, info]) => { out.set(id, await info) }))
  return out
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
