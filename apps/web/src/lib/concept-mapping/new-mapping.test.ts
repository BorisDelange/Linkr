import { describe, expect, it } from 'vitest'
import { buildNewMapping, targetFromResolvedConcept, type MappingSource, type MappingTarget } from './new-mapping'
import type { ResolvedConcept } from '@/types'

const source: MappingSource = {
  concept_id: 2000000001, concept_name: 'Pain Location', concept_code: '224027',
  vocabulary_id: 'MIMIC', domain_id: 'Observation', record_count: 42,
}
const bodyWeight: ResolvedConcept = {
  conceptId: 3025315, conceptName: 'Body weight', vocabularyId: 'LOINC', domainId: 'Measurement',
  conceptClassId: 'Clinical Observation', conceptCode: '29463-7', standardConcept: 'S',
}
const searchPick: MappingTarget = {
  conceptId: 40758553, conceptName: 'Pain primary location - Reported', vocabularyId: 'LOINC',
  domainId: 'Observation', conceptCode: '38204-4', standardConcept: 'S',
}

const build = (target: MappingTarget) => buildNewMapping({
  id: 'm1', projectId: 'p1', source, target, equivalence: 'skos:exactMatch',
  author: 'Jane Doe', now: '2026-11-01T00:00:00.000Z',
})

describe('buildNewMapping concept set', () => {
  it('records the concept set a resolved concept was picked from', () => {
    const m = build(targetFromResolvedConcept(bodyWeight, { id: 'cs-body-weight' }))
    expect(m.conceptSetId).toBe('cs-body-weight')
    expect(m.targetConceptId).toBe(3025315)
    expect(m.targetStandardConcept).toBe('S')
  })

  it('records none for a Search pick, even after a concept set was opened', () => {
    targetFromResolvedConcept(bodyWeight, { id: 'cs-body-weight' })
    const m = build(searchPick)
    expect(m.conceptSetId).toBeUndefined()
  })

  it('records the set of the detail sheet an alignment was made from', () => {
    const m = build(targetFromResolvedConcept(bodyWeight, { id: 'cs-from-sheet' }))
    expect(m.conceptSetId).toBe('cs-from-sheet')
  })

  it('records none when no set is open', () => {
    expect(build(targetFromResolvedConcept(bodyWeight, null)).conceptSetId).toBeUndefined()
  })

  it('copies the source and attaches a comment only when given', () => {
    const m = build(searchPick)
    expect(m).toMatchObject({
      sourceConceptId: 2000000001, sourceConceptCode: '224027', sourceVocabularyId: 'MIMIC',
      sourceFrequency: 42, status: 'unchecked', mappingType: 'maps_to', mappedBy: 'Jane Doe',
    })
    expect(m.comments).toBeUndefined()
    const withComment = buildNewMapping({
      id: 'm2', projectId: 'p1', source, target: searchPick, equivalence: 'skos:closeMatch',
      comment: 'left side', commentId: 'c1', author: 'Jane Doe', now: '2026-11-01T00:00:00.000Z',
    })
    expect(withComment.comments).toEqual([{
      id: 'c1', authorId: 'Jane Doe', authorDetails: undefined, text: 'left side', createdAt: '2026-11-01T00:00:00.000Z',
    }])
  })
})
