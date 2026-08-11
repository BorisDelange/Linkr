import { describe, expect, it } from 'vitest'
import {
  buildCcrCsvs,
  conceptClassOf,
  stcmFromCcr,
  CONCEPT_COLUMNS,
  CONCEPT_RELATIONSHIP_COLUMNS,
} from './ccr-export'
import { buildStcmCsv } from './stcm-export'
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

const rows = (csv: string) => csv.trimEnd().split('\n')
const field = (line: string, col: string) => line.split(',')[CONCEPT_COLUMNS.indexOf(col as never)]

describe('conceptClassOf', () => {
  it('prefers the source dictionary class when it states one', () => {
    expect(conceptClassOf(m({ id: 'a', sourceConceptClassId: 'Lab Test' }))).toBe('Lab Test')
  })

  it('falls back to the target class', () => {
    expect(conceptClassOf(m({ id: 'a', targetConceptClassId: 'Clinical Finding' })))
      .toBe('Clinical Finding')
  })

  it('echoes the domain when neither class is known', () => {
    expect(conceptClassOf(m({ id: 'a', sourceDomainId: 'Drug' }))).toBe('Drug')
    expect(conceptClassOf(m({ id: 'a', sourceDomainId: 'Procedure' }))).toBe('Procedure')
  })

  it('falls back to Observation for an unknown domain', () => {
    expect(conceptClassOf(m({ id: 'a', sourceDomainId: 'Nonsense' }))).toBe('Observation')
  })

  it('never returns the old hard-coded Clinical Observation by default', () => {
    // It was wrong for drugs, procedures and measurements alike.
    expect(conceptClassOf(m({ id: 'a', sourceDomainId: 'Drug' }))).not.toBe('Clinical Observation')
  })
})

describe('buildCcrCsvs — concept.csv', () => {
  it('writes a header in OMOP DDL order', () => {
    const { conceptCsv } = buildCcrCsvs([m({ id: 'a' })])
    expect(rows(conceptCsv)[0]).toBe(CONCEPT_COLUMNS.join(','))
  })

  it('writes one row per distinct source concept, not per mapping', () => {
    // N:1 — the same source code mapped to two targets is ONE concept.
    const { conceptCsv, conceptRowCount } = buildCcrCsvs([
      m({ id: 'a', targetConceptId: 1 }),
      m({ id: 'b', targetConceptId: 2 }),
    ])
    expect(rows(conceptCsv)).toHaveLength(2)
    expect(conceptRowCount).toBe(1)
  })

  it('gives the source concept a 2-billion id', () => {
    const { conceptCsv } = buildCcrCsvs([m({ id: 'a' })])
    expect(Number(field(rows(conceptCsv)[1], 'concept_id'))).toBeGreaterThan(2_000_000_000)
  })

  it('reuses a stored id rather than allocating a new one', () => {
    const { conceptCsv } = buildCcrCsvs([m({ id: 'a', sourceConceptId: 2_000_000_042 })])
    expect(field(rows(conceptCsv)[1], 'concept_id')).toBe('2000000042')
  })

  it('leaves standard_concept empty so the concept is non-standard', () => {
    const { conceptCsv } = buildCcrCsvs([m({ id: 'a' })])
    expect(field(rows(conceptCsv)[1], 'standard_concept')).toBe('')
    expect(rows(conceptCsv)[1]).not.toContain('NULL')
  })

  it('keeps unmapped source concepts — they are what STCM derives its 0-rows from', () => {
    const { conceptCsv, conceptRowCount } = buildCcrCsvs([m({ id: 'a', targetConceptId: 0 })])
    expect(conceptRowCount).toBe(1)
    expect(rows(conceptCsv)[1]).toContain('220045')
  })

  it('falls back to Observation when a mapping has no domain', () => {
    const { conceptCsv } = buildCcrCsvs([m({ id: 'a', sourceDomainId: '' })])
    expect(field(rows(conceptCsv)[1], 'domain_id')).toBe('Observation')
  })

  it('escapes a concept name containing a comma', () => {
    const { conceptCsv } = buildCcrCsvs([m({ id: 'a', sourceConceptName: 'Sodium, serum' })])
    expect(rows(conceptCsv)[1]).toContain('"Sodium, serum"')
  })

  it('produces a header-only file for an empty project', () => {
    const { conceptCsv, conceptRowCount } = buildCcrCsvs([])
    expect(rows(conceptCsv)).toHaveLength(1)
    expect(conceptRowCount).toBe(0)
  })
})

describe('buildCcrCsvs — concept_relationship.csv', () => {
  it('writes a header in OMOP DDL order', () => {
    const { conceptRelationshipCsv } = buildCcrCsvs([m({ id: 'a' })])
    expect(rows(conceptRelationshipCsv)[0]).toBe(CONCEPT_RELATIONSHIP_COLUMNS.join(','))
  })

  it('writes Maps to and Mapped from for a mapped concept', () => {
    const { conceptRelationshipCsv, relationshipRowCount } = buildCcrCsvs([m({ id: 'a' })])
    const body = rows(conceptRelationshipCsv).slice(1)
    expect(relationshipRowCount).toBe(2)
    expect(body[0]).toContain('Maps to')
    expect(body[1]).toContain('Mapped from')
  })

  it('points Maps to from the 2B source at the standard target', () => {
    const { conceptRelationshipCsv } = buildCcrCsvs([m({ id: 'a', targetConceptId: 3027018 })])
    const [from, to] = rows(conceptRelationshipCsv)[1].split(',')
    expect(Number(from)).toBeGreaterThan(2_000_000_000)
    expect(to).toBe('3027018')
  })

  it('reverses the pair for Mapped from', () => {
    const { conceptRelationshipCsv } = buildCcrCsvs([m({ id: 'a', targetConceptId: 3027018 })])
    const [from, to] = rows(conceptRelationshipCsv)[2].split(',')
    expect(from).toBe('3027018')
    expect(Number(to)).toBeGreaterThan(2_000_000_000)
  })

  it('emits no relationship for an unmapped concept', () => {
    const { conceptRelationshipCsv, relationshipRowCount } = buildCcrCsvs([
      m({ id: 'a', targetConceptId: 0 }),
    ])
    expect(relationshipRowCount).toBe(0)
    expect(rows(conceptRelationshipCsv)).toHaveLength(1)
  })

  it('emits a pair per target for an N:1 mapping', () => {
    const { relationshipRowCount } = buildCcrCsvs([
      m({ id: 'a', targetConceptId: 1 }),
      m({ id: 'b', targetConceptId: 2 }),
    ])
    expect(relationshipRowCount).toBe(4)
  })

  it('shares one source id across the targets of an N:1 mapping', () => {
    const { conceptRelationshipCsv } = buildCcrCsvs([
      m({ id: 'a', targetConceptId: 1 }),
      m({ id: 'b', targetConceptId: 2 }),
    ])
    const body = rows(conceptRelationshipCsv).slice(1)
    // Rows 0 and 2 are the two 'Maps to'; their source must be the same concept.
    expect(body[0].split(',')[0]).toBe(body[2].split(',')[0])
  })
})

describe('id allocation', () => {
  it('reports ids that still need persisting', () => {
    const { idsToPersist } = buildCcrCsvs([m({ id: 'a' })])
    expect(idsToPersist.get('a')).toBeGreaterThan(2_000_000_000)
  })

  it('allocates over the whole project, not the exported subset', () => {
    const hidden = m({ id: 'b', sourceConceptCode: '999', sourceConceptId: 2_000_000_500 })
    const { idsToPersist } = buildCcrCsvs([m({ id: 'a' })], [m({ id: 'a' }), hidden])
    expect(idsToPersist.get('a')).toBeGreaterThan(2_000_000_500)
  })

  it('is stable across a re-run once ids are stored', () => {
    const first = buildCcrCsvs([m({ id: 'a' }), m({ id: 'b', sourceConceptCode: '2' })])
    const stored = [
      m({ id: 'a', sourceConceptId: first.idsToPersist.get('a')! }),
      m({ id: 'b', sourceConceptCode: '2', sourceConceptId: first.idsToPersist.get('b')! }),
    ]
    // Adding a mapping must not renumber the existing ones — data already loaded
    // with the old ids would otherwise point at the wrong concept.
    const second = buildCcrCsvs([...stored, m({ id: 'c', sourceConceptCode: '3' })])
    expect(rows(second.conceptCsv)[1]).toBe(rows(first.conceptCsv)[1])
    expect(rows(second.conceptCsv)[2]).toBe(rows(first.conceptCsv)[2])
  })
})

describe('stcmFromCcr — the projection that keeps STCM available', () => {
  // The point of the whole migration: C/CR is canonical, STCM is derived. These
  // hold the derivation byte-identical to the generator it replaces, so no user's
  // source_to_concept_map.csv changes when the pipeline is inverted.
  const cases: [string, ConceptMapping[]][] = [
    ['a plain mapping', [m({ id: 'a' })]],
    ['an unmapped concept', [m({ id: 'a', targetConceptId: 0 })]],
    ['an N:1 mapping', [m({ id: 'a', targetConceptId: 1 }), m({ id: 'b', targetConceptId: 2 })]],
    ['a name containing a comma', [m({ id: 'a', sourceConceptName: 'Sodium, serum' })]],
    ['a missing domain', [m({ id: 'a', sourceDomainId: '' })]],
    ['a stored 2B id', [m({ id: 'a', sourceConceptId: 2_000_000_042 })]],
    ['an empty project', []],
    ['several distinct concepts', [
      m({ id: 'a' }),
      m({ id: 'b', sourceConceptCode: '2', sourceConceptName: 'SpO2' }),
      m({ id: 'c', sourceConceptCode: '3', targetConceptId: 0 }),
    ]],
  ]

  for (const [label, input] of cases) {
    it(`reproduces buildStcmCsv for ${label}`, () => {
      expect(stcmFromCcr(input).csv).toBe(buildStcmCsv(input).csv)
    })
  }

  it('reproduces buildStcmCsv when the subset differs from the project', () => {
    const hidden = m({ id: 'b', sourceConceptCode: '999', sourceConceptId: 2_000_000_500 })
    const subset = [m({ id: 'a' })]
    const all = [m({ id: 'a' }), hidden]
    expect(stcmFromCcr(subset, all).csv).toBe(buildStcmCsv(subset, all).csv)
  })

  it('keeps a target_concept_id = 0 row for every unmapped code', () => {
    // Deriving from concept_relationship instead would drop these, and the ETL's
    // clinical tables JOIN source_to_concept_map unconditionally.
    const { csv, rowCount } = stcmFromCcr([m({ id: 'a', targetConceptId: 0 })])
    expect(rowCount).toBe(1)
    expect(rows(csv)[1].split(',')[4]).toBe('0')
  })

  it('agrees with buildCcrCsvs on the source concept id', () => {
    const input = [m({ id: 'a' })]
    const stcmId = rows(stcmFromCcr(input).csv)[1].split(',')[1]
    const conceptId = field(rows(buildCcrCsvs(input).conceptCsv)[1], 'concept_id')
    expect(stcmId).toBe(conceptId)
  })
})
