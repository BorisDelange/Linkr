import type { ConceptMapping } from '@/types'

/**
 * OMOP reserves concept ids above 2 billion for locally-defined concepts, so a
 * source concept generated from a mapping gets one of those.
 */
export const SOURCE_CONCEPT_ID_BASE = 2_000_000_000

/**
 * A source concept is identified by its vocabulary + code, not by the mapping row:
 * two mappings of the same source code (N:1 to different targets) describe one
 * source concept and must share its id.
 */
export function sourceConceptKey(m: Pick<ConceptMapping, 'sourceVocabularyId' | 'sourceConceptCode'>): string {
  return `${m.sourceVocabularyId}\u0000${m.sourceConceptCode}`
}

export interface SourceConceptIdAssignment {
  /** vocabulary\0code -> concept id, for every mapping given. */
  byKey: Map<string, number>
  /** Mapping id -> id to persist, for the ones that had none yet. */
  toPersist: Map<string, number>
}

/**
 * Decide the source-concept id of every mapping, reusing what is already stored.
 *
 * The previous approach numbered rows at generation time
 * (`2000000000 + ROW_NUMBER() OVER (ORDER BY …)`), so adding or removing a single
 * mapping renumbered everything: ids drifted between runs, and any data already
 * loaded with the old ones silently pointed at the wrong concept. Assigning them
 * here — reusing stored values, and only allocating above the highest one in use —
 * makes them stable for the life of the project.
 *
 * `toPersist` is what the caller writes back to the mapping project, so the next
 * generation reuses these too.
 */
export function assignSourceConceptIds(mappings: ConceptMapping[]): SourceConceptIdAssignment {
  const byKey = new Map<string, number>()
  const toPersist = new Map<string, number>()

  // Existing ids first, so a fresh allocation can never collide with one.
  // Starts one below the base because allocation pre-increments: the first id
  // handed out is SOURCE_CONCEPT_ID_BASE itself, which the band includes.
  let maxUsed = SOURCE_CONCEPT_ID_BASE - 1
  for (const m of mappings) {
    const stored = m.sourceConceptId
    if (!isAssigned(stored)) continue
    const key = sourceConceptKey(m)
    // Two rows of the same source concept disagreeing (possible after a merge)
    // are reconciled on the lowest id, so the choice does not depend on order.
    const current = byKey.get(key)
    if (current == null || stored < current) byKey.set(key, stored)
    if (stored > maxUsed) maxUsed = stored
  }

  // Then allocate for the rest, in a deterministic order so a re-run of the same
  // input yields the same ids.
  const unassigned = mappings
    .filter((m) => !byKey.has(sourceConceptKey(m)))
    .sort((a, b) => (
      a.sourceVocabularyId.localeCompare(b.sourceVocabularyId)
      || a.sourceConceptCode.localeCompare(b.sourceConceptCode, undefined, { numeric: true })
    ))

  for (const m of unassigned) {
    const key = sourceConceptKey(m)
    if (byKey.has(key)) continue
    byKey.set(key, ++maxUsed)
  }

  // Every mapping whose stored id differs from the agreed one needs writing —
  // including rows that shared a source concept but carried no id.
  for (const m of mappings) {
    const agreed = byKey.get(sourceConceptKey(m))
    if (agreed != null && m.sourceConceptId !== agreed) toPersist.set(m.id, agreed)
  }

  return { byKey, toPersist }
}

/** 0 and undefined both mean "never assigned" — the field defaults to 0. */
function isAssigned(id: number | undefined): id is number {
  return typeof id === 'number' && id >= SOURCE_CONCEPT_ID_BASE
}
