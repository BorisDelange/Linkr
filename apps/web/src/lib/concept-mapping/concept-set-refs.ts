/**
 * Portable references from a mapping project to the concept sets it uses.
 *
 * `conceptSetIds` are local keys, minted per import, so they cannot travel. The
 * export writes `conceptSets` instead: the set's `uniqueId` (set by the
 * authoring tool, identical on every instance) and the dictionary repo it came
 * from; a hand-made set without one is named. The import resolves them against
 * the workspace's concept sets. Twin of `_concept_set_refs` in
 * apps/api/app/services/mapping_project_export.py.
 */
import type { ConceptSet } from '@/types'
import { compareCodePoints } from './source-concept-ids-io'

export interface ConceptSetRef {
  uniqueId?: string
  sourceRepo?: string
  /** Only for a set without a uniqueId — the one identity it has. */
  name?: string
}

function refKey(ref: ConceptSetRef): string {
  return ref.uniqueId ? `u:${ref.uniqueId}` : `n:${ref.name ?? ''}`
}

/** The refs of `ids`, sorted so an unchanged selection exports the same bytes.
 *  An id whose set is gone is dropped: it names nothing to resolve. */
export function toConceptSetRefs(ids: readonly string[], sets: readonly ConceptSet[]): ConceptSetRef[] {
  const byId = new Map(sets.map((s) => [s.id, s]))
  const refs = new Map<string, ConceptSetRef>()
  for (const id of ids) {
    const set = byId.get(id)
    if (!set) continue
    const ref: ConceptSetRef = set.uniqueId
      ? { uniqueId: set.uniqueId, ...(set.sourceRepo ? { sourceRepo: set.sourceRepo } : {}) }
      : { name: set.name }
    refs.set(refKey(ref), ref)
  }
  return [...refs.entries()].sort(([a], [b]) => compareCodePoints(a, b)).map(([, ref]) => ref)
}

export interface ResolvedConceptSetRefs {
  ids: string[]
  /** Refs no workspace set answers — the dictionary to import, when known. */
  missing: ConceptSetRef[]
}

/**
 * Resolve refs against the workspace's sets. A uniqueId matches on it alone,
 * preferring the set from the same repo when several carry it (a fork keeps
 * its origin's uniqueId); a name matches only when exactly one set has it.
 */
export function resolveConceptSetRefs(refs: readonly ConceptSetRef[] | undefined, sets: readonly ConceptSet[]): ResolvedConceptSetRefs {
  const ids: string[] = []
  const missing: ConceptSetRef[] = []
  for (const ref of refs ?? []) {
    let match: ConceptSet | undefined
    if (ref.uniqueId) {
      const candidates = sets.filter((s) => s.uniqueId === ref.uniqueId)
      match = candidates.find((s) => s.sourceRepo === ref.sourceRepo) ?? candidates[0]
    } else if (ref.name) {
      const named = sets.filter((s) => s.name === ref.name)
      if (named.length === 1) match = named[0]
    }
    if (match && !ids.includes(match.id)) ids.push(match.id)
    else if (!match) missing.push(ref)
  }
  return { ids, missing }
}
