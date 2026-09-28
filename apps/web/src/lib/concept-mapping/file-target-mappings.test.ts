import { describe, expect, it } from 'vitest'
import { alignedSourceRowsSql, alignedTargetIds, buildFileTargetMappings, parseTargetIds } from './file-target-mappings'

describe('parseTargetIds', () => {
  it('reads one or several ids, ignoring junk and repeats', () => {
    expect(parseTargetIds('3004249')).toEqual([3004249])
    expect(parseTargetIds(3004249)).toEqual([3004249])
    expect(parseTargetIds('1; 2,3 | 4 2')).toEqual([1, 2, 3, 4])
    expect(parseTargetIds('NA')).toEqual([])
    expect(parseTargetIds('0')).toEqual([])
    expect(parseTargetIds(null)).toEqual([])
  })

  it('reads plain integers only, not every notation Number() accepts', () => {
    for (const junk of ['1e3', '0x10', '1.5', '-4', '+4', 'Infinity', '12abc']) {
      expect(parseTargetIds(junk), junk).toEqual([])
    }
    expect(parseTargetIds('3004249.0')).toEqual([3004249])
  })
})

describe('alignedSourceRowsSql', () => {
  it('joins on vocabulary and code when the file has a terminology column', () => {
    expect(alignedSourceRowsSql({ terminologyColumn: 'v' })).toContain('s.vocabulary_id IS NOT DISTINCT FROM r.vocabulary_id')
    expect(alignedSourceRowsSql({})).not.toContain('vocabulary_id')
  })
})

describe('buildFileTargetMappings', () => {
  const rows = [
    { concept_id: 1, concept_name: 'Heart rate', concept_code: 'HR', vocabulary_id: 'LOCAL', aligned_target: '3027018' },
    { concept_id: 1, concept_name: 'Heart rate', concept_code: 'HR', vocabulary_id: 'LOCAL', aligned_target: '3027018;4239408' },
    { concept_id: 2, concept_name: 'Weight', concept_code: 'W', vocabulary_id: 'LOCAL', aligned_target: '3025315' },
  ]
  const targets = new Map([[3027018, {
    conceptId: 3027018, conceptName: 'Heart rate', vocabularyId: 'LOINC', domainId: 'Measurement', conceptCode: '8867-4', standardConcept: 'S',
  }]])
  let n = 0
  const build = (existing: Parameters<typeof buildFileTargetMappings>[3] = []) => buildFileTargetMappings(
    { id: 'p' }, rows, targets, existing, { name: 'alice' }, '2026-09-28T00:00:00Z', () => `m${n++}`,
  )

  it('lists every distinct target to look up', () => {
    expect(alignedTargetIds(rows)).toEqual([3027018, 4239408, 3025315])
  })

  it('creates one unchecked mapping per source and target, credited to the importer', () => {
    const out = build()
    expect(out.map((m) => [m.sourceConceptCode, m.targetConceptId])).toEqual([
      ['HR', 3027018], ['HR', 4239408], ['W', 3025315],
    ])
    expect(out[0]).toMatchObject({ status: 'unchecked', mappedBy: 'alice', targetConceptName: 'Heart rate', targetVocabularyId: 'LOINC' })
    expect(out[1].targetConceptName).toBe('')
  })

  it('skips alignments the project already has', () => {
    const out = build([{ sourceVocabularyId: 'LOCAL', sourceConceptCode: 'W', targetConceptId: 3025315 }])
    expect(out.map((m) => m.targetConceptId)).toEqual([3027018, 4239408])
  })
})
