import type { ClassRelation } from '@/lib/schema-classes/relations'
import type { ProfileSource } from '@/lib/concept-mapping/concept-profile'
import type { ConceptCounts } from '@/lib/concept-mapping/source-extraction'
import { getRelationRecords } from '@/lib/api/concept-cache'
import { isServerMode } from '@/lib/api-client'
import { countedRelationSignature } from './concept-count-plan'

/**
 * A database's concept counts, per event table, as a ranking of its concepts
 * reads them (`StartRunInput.countedRecords`): null when the last count did not
 * cover the table under its current SQL, or in client mode, which has no count.
 * A code-only dictionary keys its concepts on a hash the count does not use.
 */
export function countedRecordsOf(sourceId: string) {
  return async (source: ProfileSource, event: ClassRelation): Promise<ConceptCounts[] | null> => {
    if (!isServerMode() || !source.dictionary.ownId) return null
    const counts = await getRelationRecords(sourceId, event.name, countedRelationSignature(event, source.dict))
    return counts?.map((c) => ({ concept_id: Number(c.conceptId), record_count: c.recordCount, patient_count: null })) ?? null
  }
}
