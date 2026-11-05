import type { AuthorDetails, ConceptMapping, ConceptSet, MappingEquivalence, ResolvedConcept } from '@/types'

/** A target picked in the Mapping Editor. `conceptSetId` is set only when the pick
 *  came from inside that concept set: a mapping must not inherit whichever set was
 *  last opened in another tab. */
export interface MappingTarget {
  conceptId: number
  conceptName: string
  vocabularyId: string
  domainId: string
  conceptCode: string
  conceptClassId?: string
  standardConcept?: string
  conceptSetId?: string
}

export interface MappingSource {
  concept_id: number
  concept_name: string
  concept_code?: string
  vocabulary_id?: string
  domain_id?: string
  concept_class_id?: string
  category?: string
  subcategory?: string
  record_count: number
}

export function targetFromResolvedConcept(rc: ResolvedConcept, conceptSet: Pick<ConceptSet, 'id'> | null): MappingTarget {
  return {
    conceptId: rc.conceptId,
    conceptName: rc.conceptName,
    vocabularyId: rc.vocabularyId,
    domainId: rc.domainId,
    conceptCode: rc.conceptCode,
    conceptClassId: rc.conceptClassId,
    standardConcept: rc.standardConcept ?? undefined,
    conceptSetId: conceptSet?.id,
  }
}

export interface NewMappingInput {
  id: string
  projectId: string
  source: MappingSource
  target: MappingTarget
  equivalence: MappingEquivalence
  comment?: string
  commentId?: string
  author: string
  authorDetails?: AuthorDetails
  now: string
}

export function buildNewMapping({
  id, projectId, source, target, equivalence, comment, commentId, author, authorDetails, now,
}: NewMappingInput): ConceptMapping {
  return {
    id,
    projectId,
    sourceConceptId: source.concept_id,
    sourceConceptName: source.concept_name,
    sourceVocabularyId: source.vocabulary_id ?? '',
    sourceDomainId: source.domain_id ?? '',
    sourceConceptCode: source.concept_code ?? '',
    sourceFrequency: source.record_count,
    sourceCategoryId: source.category,
    sourceSubcategoryId: source.subcategory,
    sourceConceptClassId: source.concept_class_id,
    targetConceptId: target.conceptId,
    targetConceptName: target.conceptName,
    targetVocabularyId: target.vocabularyId,
    targetDomainId: target.domainId,
    targetConceptCode: target.conceptCode,
    targetConceptClassId: target.conceptClassId,
    targetStandardConcept: target.standardConcept,
    conceptSetId: target.conceptSetId,
    mappingType: 'maps_to',
    equivalence,
    status: 'unchecked',
    comments: comment ? [{
      id: commentId ?? crypto.randomUUID(),
      authorId: author,
      authorDetails,
      text: comment,
      createdAt: now,
    }] : undefined,
    mappedBy: author,
    mappedByDetails: authorDetails,
    mappedOn: now,
    createdAt: now,
    updatedAt: now,
  }
}
