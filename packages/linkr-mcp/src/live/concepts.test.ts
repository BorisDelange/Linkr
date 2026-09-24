import { describe, expect, it } from 'vitest'
import type { ConceptSet } from '@/types'
import { describeConceptSet, editItems, toListItems } from './concepts'

describe('toListItems', () => {
  it('coerces ids, drops duplicates and reports bad ids together', () => {
    const { items, errors } = toListItems([
      { concept_id: '3027018', name: 'Heart rate', vocabulary: 'LOINC', code: '8867-4' },
      { concept_id: 3027018 },
      { concept_id: 'abc' },
      { concept_id: 1.5 },
    ])
    expect(items).toEqual([{ conceptId: 3027018, conceptName: 'Heart rate', vocabularyId: 'LOINC', conceptCode: '8867-4' }])
    expect(errors).toHaveLength(2)
  })
})

describe('editItems', () => {
  it('removes by id, then adds what is not already there', () => {
    const current = [{ conceptId: 1 }, { conceptId: 2 }]
    expect(editItems(current, [{ conceptId: 2 }, { conceptId: 3 }], [1])).toEqual([{ conceptId: 2 }, { conceptId: 3 }])
  })
})

describe('describeConceptSet', () => {
  const set = {
    id: 's1', workspaceId: 'w', name: 'Lactate', description: '', category: 'Labs',
    expression: { items: [{
      concept: { conceptId: 3047181, conceptName: 'Lactate', vocabularyId: 'LOINC', domainId: 'Measurement', conceptClassId: 'Lab Test', standardConcept: 'S', conceptCode: '2524-7' },
      isExcluded: false, includeDescendants: true, includeMapped: false,
    }] },
    resolvedConceptIds: [3047181, 3014111],
  } as unknown as ConceptSet

  it('lists the expression with its flags and the resolved ids', () => {
    const text = describeConceptSet(set)
    expect(text).toContain('3047181 Lactate [LOINC 2524-7] +descendants')
    expect(text).toContain('Resolved: 2 concept id(s)')
    expect(describeConceptSet({ ...set, resolvedConceptIds: null })).toContain('Not resolved yet')
  })
})
