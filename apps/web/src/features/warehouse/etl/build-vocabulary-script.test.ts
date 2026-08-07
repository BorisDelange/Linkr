import { describe, expect, it } from 'vitest'
import { buildVocabularyScript, buildCustomVocabularyScript } from './build-vocabulary-script'
import type { ConceptMapping } from '@/types'

const MAPPING: ConceptMapping = {
  id: 'm1',
  projectId: 'p1',
  sourceConceptId: 1,
  sourceConceptName: 'Sodium',
  sourceVocabularyId: 'mimiciv_labs',
  sourceDomainId: 'Measurement',
  sourceConceptCode: '50983',
  targetConceptId: 3019550,
  targetConceptName: 'Sodium [Moles/volume] in Serum or Plasma',
  targetVocabularyId: 'LOINC',
  targetDomainId: 'Measurement',
  targetConceptCode: '2951-2',
  mappingType: 'maps_to',
  equivalence: 'skos:exactMatch',
  status: 'approved',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** OMOP tables the script writes to — all live on the pipeline target. */
const TARGET_TABLES = [
  'concept', 'concept_relationship', 'concept_ancestor', 'concept_synonym',
  'concept_class', 'source_to_concept_map', 'vocabulary', 'domain', 'relationship',
]

describe('buildVocabularyScript', () => {
  const sql = buildVocabularyScript([MAPPING])

  it('reads the ATHENA reference through the vocab role', () => {
    expect(sql).toContain('FROM vocab.concept ')
    expect(sql).toContain('FROM vocab.concept_relationship ')
    expect(sql).not.toMatch(/\bds_[0-9a-f_]{8}/i)
  })

  it('qualifies every write with target.', () => {
    for (const table of TARGET_TABLES) {
      expect(sql).not.toMatch(new RegExp(`DELETE FROM ${table}\\b`))
      expect(sql).not.toMatch(new RegExp(`INSERT INTO ${table}\\b`))
    }
    expect(sql).toContain('DELETE FROM target.concept;')
    expect(sql).toContain('INSERT INTO target.concept_ancestor')
    expect(sql).toContain('UPDATE target.source_to_concept_map')
  })

  it('qualifies target tables read in subqueries too', () => {
    // An unqualified read here would resolve via search_path, i.e. silently
    // depend on which database the Run dropdown happens to point at.
    expect(sql).not.toMatch(/FROM concept\b(?!_)/)
    expect(sql).not.toMatch(/FROM source_to_concept_map\b/)
    expect(sql).toContain('FROM target.source_to_concept_map')
  })

  it('leaves column names containing a table name alone', () => {
    expect(sql).toContain('concept_id')
    expect(sql).toContain('vocabulary_id')
  })
})

describe('buildCustomVocabularyScript', () => {
  const sql = buildCustomVocabularyScript([
    { n: 'Foo', ci: 1, sv: 'mimiciv_drug', sd: 'Drug', cc: 'X1', ti: 42, tv: 'RxNorm' },
  ])

  it('qualifies its writes with target. as well', () => {
    expect(sql).not.toMatch(/INSERT INTO concept\b/)
    expect(sql).not.toMatch(/UPDATE source_to_concept_map\b/)
    expect(sql).toContain('INSERT INTO target.source_to_concept_map')
    expect(sql).toContain('UPDATE target.source_to_concept_map')
  })

  it('is a no-op script when there are no rows', () => {
    expect(buildCustomVocabularyScript([])).toContain('No custom mappings')
  })
})
