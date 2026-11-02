import type { SchemaMapping } from '@/types/schema-mapping'
import { conceptRelations, eventRelations } from '@/lib/schema-classes/relations'
import { countedRelationSignature, emptyCountedRelations, resumable } from '@/features/projects/warehouse/concepts/concept-count-plan'
import { getConceptCacheStatus, getCountedRelations, type ConceptCacheStatus, type CountedRelation } from '@/lib/api/concept-cache'
import { isServerMode } from '@/lib/api-client'
import { sourceTables } from '@/lib/duckdb/engine'
import { LruMap } from '@/lib/lru-map'

/**
 * The event relations a read of some concepts — a patient's timeline, a cohort
 * criterion — can leave out: those
 * the last concept count counted, under the SQL they still have, and found none
 * of these concepts in. One not counted, or counted under another SQL, is read —
 * the counts never hide a relation they did not see. They do not see rows loaded
 * after the count either: a concept a relation never held before is missed until
 * the next count.
 */
export function relationsWithout(mapping: SchemaMapping, counted: readonly CountedRelation[], empty: Iterable<string> = []): Set<string> {
  const dicts = conceptRelations(mapping)
  const out = new Set<string>(empty)
  for (const event of eventRelations(mapping)) {
    const dict = dicts.find((d) => d.name === event.dictionary)
    if (!dict) continue
    const signature = countedRelationSignature(event, dict)
    const rows = counted.filter((c) => c.relation === event.name && c.signature === signature)
    if (rows.length > 0 && !rows.some((r) => r.holds)) out.add(event.name)
  }
  return out
}

/**
 * For each event relation the last concept count speaks for (counted, under the
 * SQL it still has), the ids among those asked about it holds — empty: none. A
 * relation it cannot speak for is absent, and is read for every id.
 */
/** `empty`: relations the count covered whole and found no row in (`emptyCountedRelations`). */
export function relationsHolding(mapping: SchemaMapping, counted: readonly CountedRelation[], empty: Iterable<string> = []): Map<string, Set<number>> {
  const dicts = conceptRelations(mapping)
  const out = new Map<string, Set<number>>([...empty].map((name) => [name, new Set<number>()]))
  for (const event of eventRelations(mapping)) {
    const dict = dicts.find((d) => d.name === event.dictionary)
    if (!dict) continue
    const signature = countedRelationSignature(event, dict)
    const rows = counted.filter((c) => c.relation === event.name && c.signature === signature)
    // A server that names no ids can only say "none".
    if (rows.length === 0 || rows.some((r) => r.holds && !r.held)) continue
    out.set(event.name, new Set(rows.flatMap((r) => r.held ?? []).map(Number)))
  }
  return out
}

const MEMO_MS = 60_000
const MEMO_MAX = 200
const memo = new LruMap<string, { at: number; relations: Promise<CountedRelation[]> }>(MEMO_MAX)
const countedAtMemo = new LruMap<string, { at: number; countedAt: Promise<string | null> }>(MEMO_MAX)
const statusMemo = new LruMap<string, { at: number; status: Promise<ConceptCacheStatus>; tables: Promise<string[] | null> }>(MEMO_MAX)

/** relationsWithout for a server database, asked once a minute per concept set.
 *  Empty — every relation read — when the server cannot tell. */
export async function relationsWithoutConcepts(
  sourceId: string,
  mapping: SchemaMapping,
  conceptIds: readonly number[],
): Promise<Set<string>> {
  const counted = await countedRelations(sourceId, conceptIds)
  return relationsWithout(mapping, counted, await emptyRelations(sourceId, mapping, counted))
}

/** relationsHolding for a server database, asked once a minute per concept set.
 *  Empty — every relation read for every id — when the server cannot tell. */
export async function relationsHoldingConcepts(
  sourceId: string,
  mapping: SchemaMapping,
  conceptIds: readonly number[],
): Promise<Map<string, Set<number>>> {
  const counted = await countedRelations(sourceId, conceptIds)
  return relationsHolding(mapping, counted, await emptyRelations(sourceId, mapping, counted))
}

/** emptyRelations, asked of the counted relations themselves. */
export async function emptyCountedRelationsOf(sourceId: string, mapping: SchemaMapping): Promise<string[]> {
  // Any id: every relation a counted row names comes back, holding it or not.
  return emptyRelations(sourceId, mapping, await countedRelations(sourceId, [0]))
}

/**
 * The relations the last count covered whole and found no row in: an empty
 * table, which no counted row names. Read from the run's plan, when it was
 * planned on the current mapping (`resumable`); none otherwise.
 */
export async function emptyRelations(
  sourceId: string,
  mapping: SchemaMapping,
  counted: readonly CountedRelation[],
): Promise<string[]> {
  if (!isServerMode()) return []
  let hit = statusMemo.get(sourceId)
  if (!hit || Date.now() - hit.at > MEMO_MS) {
    hit = { at: Date.now(), status: getConceptCacheStatus(sourceId), tables: sourceTables(sourceId) }
    statusMemo.set(sourceId, hit)
  }
  try {
    const [status, tables] = await Promise.all([hit.status, hit.tables])
    if (!status.run || !resumable(status.run.manifest, mapping, tables)) return []
    return emptyCountedRelations(mapping, status.run.doneUnits, new Set(counted.map((c) => c.relation)))
  } catch {
    statusMemo.delete(sourceId)
    return []
  }
}

async function countedRelations(sourceId: string, conceptIds: readonly number[]): Promise<CountedRelation[]> {
  if (!isServerMode() || conceptIds.length === 0) return []
  const key = `${sourceId}:${[...conceptIds].sort((a, b) => a - b).join(',')}`
  let hit = memo.get(key)
  if (!hit || Date.now() - hit.at > MEMO_MS) {
    hit = { at: Date.now(), relations: getCountedRelations(sourceId, conceptIds) }
    memo.set(key, hit)
  }
  try {
    return await hit.relations
  } catch {
    memo.delete(key)
    return []
  }
}

/** When the counts the timeline narrows on were taken: the run's end, else its
 *  last unit (a paused run's record units can already narrow it). */
export function countedAtOf(status: ConceptCacheStatus | null): string | null {
  const run = status?.run
  if (!run) return null
  if (run.manifest.finishedAt) return run.manifest.finishedAt
  return run.lastUnitAt != null ? new Date(run.lastUnitAt * 1000).toISOString() : null
}

/** countedAtOf for a server database, asked once a minute. */
export function relationsCountedAt(sourceId: string): Promise<string | null> {
  let hit = countedAtMemo.get(sourceId)
  if (!hit || Date.now() - hit.at > MEMO_MS) {
    hit = { at: Date.now(), countedAt: getConceptCacheStatus(sourceId).then(countedAtOf, () => null) }
    countedAtMemo.set(sourceId, hit)
  }
  return hit.countedAt
}
