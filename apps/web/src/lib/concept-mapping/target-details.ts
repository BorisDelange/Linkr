/**
 * Target concept details read from the workspace vocabulary library, for
 * mappings created from an id alone (a file's target concept ID column, read
 * before the vocabularies were imported).
 */
import { queryDataSourceAll } from '@/lib/duckdb/engine'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import type { TargetConceptDetails } from './file-target-mappings'

/** Details of `ids` in the vocabulary library; ids it lacks are absent. */
export async function fetchTargetDetails(vocabularyDataSourceId: string, ids: readonly number[]): Promise<Map<number, TargetConceptDetails>> {
  const out = new Map<number, TargetConceptDetails>()
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await queryDataSourceAll(vocabularyDataSourceId,
      'SELECT concept_id, concept_name, vocabulary_id, domain_id, concept_class_id, concept_code, standard_concept '
      + `FROM concept WHERE concept_id IN (${ids.slice(i, i + 1000).map(Number).join(', ')})`)
    for (const r of rows) {
      out.set(Number(r.concept_id), {
        conceptId: Number(r.concept_id),
        conceptName: String(r.concept_name ?? ''),
        vocabularyId: String(r.vocabulary_id ?? ''),
        domainId: String(r.domain_id ?? ''),
        conceptCode: String(r.concept_code ?? ''),
        conceptClassId: r.concept_class_id != null ? String(r.concept_class_id) : undefined,
        standardConcept: r.standard_concept ? String(r.standard_concept) : undefined,
      })
    }
  }
  return out
}

/**
 * Fill in the target details a project's mappings lack, from the library.
 * Returns how many mappings were completed.
 */
export async function fillMissingTargetDetails(projectId: string, vocabularyDataSourceId: string): Promise<number> {
  const { mappings, updateMapping } = useConceptMappingStore.getState()
  const missing = mappings.filter((m) => m.projectId === projectId
    && m.status !== 'ignored' && m.targetConceptId > 0 && !m.targetConceptName)
  if (missing.length === 0) return 0
  const details = await fetchTargetDetails(vocabularyDataSourceId, [...new Set(missing.map((m) => m.targetConceptId))])
  let filled = 0
  for (const m of missing) {
    const d = details.get(m.targetConceptId)
    if (!d) continue
    await updateMapping(m.id, {
      targetConceptName: d.conceptName,
      targetVocabularyId: d.vocabularyId,
      targetDomainId: d.domainId,
      targetConceptCode: d.conceptCode,
      targetConceptClassId: d.conceptClassId,
      targetStandardConcept: d.standardConcept,
    })
    filled++
  }
  return filled
}
