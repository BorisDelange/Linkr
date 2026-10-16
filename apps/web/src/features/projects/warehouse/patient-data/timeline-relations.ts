import type { SchemaMapping } from '@/types/schema-mapping'
import { conceptRelations, eventRelations } from '@/lib/schema-classes/relations'
import { countedRelationSignature } from '@/features/projects/warehouse/concepts/concept-count-plan'
import { getConceptCacheStatus, getCountedRelations, type ConceptCacheStatus, type CountedRelation } from '@/lib/api/concept-cache'
import { isServerMode } from '@/lib/api-client'
import { LruMap } from '@/lib/lru-map'

/**
 * The event relations a patient's timeline of some concepts can leave out: those
 * the last concept count counted, under the SQL they still have, and found none
 * of these concepts in. One not counted, or counted under another SQL, is read —
 * the counts never hide a relation they did not see. They do not see rows loaded
 * after the count either: a concept a relation never held before is missed until
 * the next count.
 */
export function relationsWithout(mapping: SchemaMapping, counted: readonly CountedRelation[]): Set<string> {
  const dicts = conceptRelations(mapping)
  const out = new Set<string>()
  for (const event of eventRelations(mapping)) {
    const dict = dicts.find((d) => d.name === event.dictionary)
    if (!dict) continue
    const signature = countedRelationSignature(event, dict)
    const rows = counted.filter((c) => c.relation === event.name && c.signature === signature)
    if (rows.length > 0 && !rows.some((r) => r.holds)) out.add(event.name)
  }
  return out
}

const MEMO_MS = 60_000
const MEMO_MAX = 200
const memo = new LruMap<string, { at: number; relations: Promise<CountedRelation[]> }>(MEMO_MAX)
const countedAtMemo = new LruMap<string, { at: number; countedAt: Promise<string | null> }>(MEMO_MAX)

/** relationsWithout for a server database, asked once a minute per concept set.
 *  Empty — every relation read — when the server cannot tell. */
export async function timelineRelationsWithout(
  sourceId: string,
  mapping: SchemaMapping,
  conceptIds: readonly number[],
): Promise<Set<string>> {
  if (!isServerMode() || conceptIds.length === 0) return new Set()
  const key = `${sourceId}:${[...conceptIds].sort((a, b) => a - b).join(',')}`
  let hit = memo.get(key)
  if (!hit || Date.now() - hit.at > MEMO_MS) {
    hit = { at: Date.now(), relations: getCountedRelations(sourceId, conceptIds) }
    memo.set(key, hit)
  }
  try {
    return relationsWithout(mapping, await hit.relations)
  } catch {
    memo.delete(key)
    return new Set()
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
