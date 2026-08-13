import { describe, expect, it } from 'vitest'
import {
  assignSourceConceptIds,
  SOURCE_CONCEPT_ID_BASE,
  sourceConceptKey,
} from './source-concept-ids'
import type { ConceptMapping } from '@/types'

function m(over: Partial<ConceptMapping> & { id: string }): ConceptMapping {
  return {
    projectId: 'p1',
    sourceConceptId: 0,
    sourceConceptName: 'Heart Rate',
    sourceVocabularyId: 'mimic_chartevents',
    sourceDomainId: 'Measurement',
    sourceConceptCode: '220045',
    targetConceptId: 3027018,
    targetConceptName: '',
    targetVocabularyId: 'LOINC',
    targetDomainId: 'Measurement',
    targetConceptCode: '',
    mappingType: 'maps_to',
    equivalence: 'skos:exactMatch',
    status: 'approved',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('sourceConceptKey', () => {
  it('identifies a source concept by vocabulary and code, not by mapping row', () => {
    expect(sourceConceptKey(m({ id: 'a' }))).toBe(sourceConceptKey(m({ id: 'b' })))
  })

  it('separates the same code in different vocabularies', () => {
    expect(sourceConceptKey(m({ id: 'a', sourceVocabularyId: 'v1' })))
      .not.toBe(sourceConceptKey(m({ id: 'b', sourceVocabularyId: 'v2' })))
  })
})

describe('assignSourceConceptIds', () => {
  it('allocates above the OMOP local-concept threshold', () => {
    const { byKey } = assignSourceConceptIds([m({ id: 'a' })])
    expect([...byKey.values()][0]).toBeGreaterThanOrEqual(SOURCE_CONCEPT_ID_BASE)
  })

  it('reuses an id that is already stored', () => {
    const stored = 2_000_000_042
    const { byKey, toPersist } = assignSourceConceptIds([m({ id: 'a', sourceConceptId: stored })])
    expect([...byKey.values()]).toEqual([stored])
    // Nothing to write: the stored value is already the agreed one.
    expect(toPersist.size).toBe(0)
  })

  it('never reallocates an existing id when new mappings appear', () => {
    // The bug this replaces: ROW_NUMBER() renumbered everything, so adding one
    // mapping shifted the ids of all the others.
    const kept = 2_000_000_005
    const { byKey } = assignSourceConceptIds([
      m({ id: 'a', sourceConceptId: kept, sourceConceptCode: '999' }),
      m({ id: 'b', sourceConceptCode: '111' }),
    ])
    expect(byKey.get('mimic_chartevents\u0000999')).toBe(kept)
  })

  it('allocates above the highest id in use, so a new id cannot collide', () => {
    const { byKey } = assignSourceConceptIds([
      m({ id: 'a', sourceConceptId: 2_000_000_500, sourceConceptCode: 'A' }),
      m({ id: 'b', sourceConceptCode: 'B' }),
    ])
    expect(byKey.get('mimic_chartevents\u0000B')).toBeGreaterThan(2_000_000_500)
  })

  it('gives two mappings of the same source code one shared id', () => {
    // N:1 — the same source concept mapped to two different targets.
    const { byKey, toPersist } = assignSourceConceptIds([
      m({ id: 'a', targetConceptId: 1 }),
      m({ id: 'b', targetConceptId: 2 }),
    ])
    expect(byKey.size).toBe(1)
    expect(toPersist.get('a')).toBe(toPersist.get('b'))
  })

  it('reports the ids that still have to be persisted', () => {
    const { toPersist } = assignSourceConceptIds([
      m({ id: 'a', sourceConceptId: 2_000_000_001, sourceConceptCode: 'A' }),
      m({ id: 'b', sourceConceptCode: 'B' }),
    ])
    expect([...toPersist.keys()]).toEqual(['b'])
  })

  it('treats 0 as never assigned — it is the field default', () => {
    const { toPersist } = assignSourceConceptIds([m({ id: 'a', sourceConceptId: 0 })])
    expect(toPersist.get('a')).toBeGreaterThanOrEqual(SOURCE_CONCEPT_ID_BASE)
  })

  it('ignores a stored value below the threshold rather than trusting it', () => {
    // A target concept id (e.g. 3027018) in that field is not a local source id.
    const { byKey } = assignSourceConceptIds([m({ id: 'a', sourceConceptId: 3_027_018 })])
    expect([...byKey.values()][0]).toBeGreaterThanOrEqual(SOURCE_CONCEPT_ID_BASE)
  })

  it('is deterministic: the same input yields the same ids', () => {
    const input = () => [
      m({ id: 'a', sourceConceptCode: '10' }),
      m({ id: 'b', sourceConceptCode: '2' }),
      m({ id: 'c', sourceVocabularyId: 'other', sourceConceptCode: '1' }),
    ]
    const first = assignSourceConceptIds(input()).byKey
    const second = assignSourceConceptIds(input()).byKey
    expect([...second.entries()]).toEqual([...first.entries()])
  })

  it('does not depend on the order the mappings arrive in', () => {
    const a = m({ id: 'a', sourceConceptCode: '10' })
    const b = m({ id: 'b', sourceConceptCode: '2' })
    const forward = assignSourceConceptIds([a, b]).byKey
    const backward = assignSourceConceptIds([b, a]).byKey
    expect([...backward.entries()].sort()).toEqual([...forward.entries()].sort())
  })

  it('reconciles rows of one source concept that disagree, on the lowest id', () => {
    // Possible after merging two branches that each allocated independently.
    const { byKey, toPersist } = assignSourceConceptIds([
      m({ id: 'a', sourceConceptId: 2_000_000_009 }),
      m({ id: 'b', sourceConceptId: 2_000_000_004 }),
    ])
    expect([...byKey.values()]).toEqual([2_000_000_004])
    expect(toPersist.get('a')).toBe(2_000_000_004)
  })

  it('handles an empty project', () => {
    const { byKey, toPersist } = assignSourceConceptIds([])
    expect(byKey.size).toBe(0)
    expect(toPersist.size).toBe(0)
  })
})
