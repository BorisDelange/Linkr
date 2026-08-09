import { describe, expect, it } from 'vitest'
import { buildStcmCsv, csvField, STCM_COLUMNS } from './stcm-export'
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

describe('csvField', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('Heart Rate')).toBe('Heart Rate')
  })

  it('quotes a value containing a comma', () => {
    // Concept names routinely contain them.
    expect(csvField('Sodium [Moles/volume] in Serum, Plasma'))
      .toBe('"Sodium [Moles/volume] in Serum, Plasma"')
  })

  it('doubles an embedded quote', () => {
    expect(csvField('a "b" c')).toBe('"a ""b"" c"')
  })

  it('quotes a value containing a newline', () => {
    expect(csvField('a\nb')).toBe('"a\nb"')
  })

  it('renders undefined as empty', () => {
    expect(csvField(undefined)).toBe('')
  })
})

describe('buildStcmCsv', () => {
  it('writes a header in OMOP column order', () => {
    const { csv } = buildStcmCsv([m({ id: 'a' })])
    expect(rows(csv)[0]).toBe(STCM_COLUMNS.join(','))
  })

  it('writes one row per mapping', () => {
    const { csv, rowCount } = buildStcmCsv([m({ id: 'a' }), m({ id: 'b', sourceConceptCode: '2' })])
    expect(rows(csv)).toHaveLength(3)
    expect(rowCount).toBe(2)
  })

  it('carries the assigned source concept id, not 0', () => {
    const { csv } = buildStcmCsv([m({ id: 'a', sourceConceptId: 2_000_000_042 })])
    expect(rows(csv)[1]).toContain('2000000042')
  })

  it('reports ids that still need persisting', () => {
    const { idsToPersist } = buildStcmCsv([m({ id: 'a' })])
    expect(idsToPersist.get('a')).toBeGreaterThan(2_000_000_000)
  })

  it('allocates over the whole project, not the exported subset', () => {
    const hidden = m({ id: 'b', sourceConceptCode: '999', sourceConceptId: 2_000_000_500 })
    const { idsToPersist } = buildStcmCsv([m({ id: 'a' })], [m({ id: 'a' }), hidden])
    expect(idsToPersist.get('a')).toBeGreaterThan(2_000_000_500)
  })

  it('escapes a concept name containing a comma', () => {
    const { csv } = buildStcmCsv([m({ id: 'a', sourceConceptName: 'Sodium, serum' })])
    expect(rows(csv)[1]).toContain('"Sodium, serum"')
    // Still nine fields once the quoted one is accounted for.
    expect(rows(csv)[1].split('","').length).toBeGreaterThan(0)
  })

  it('leaves invalid_reason empty so DuckDB reads it as NULL', () => {
    const { csv } = buildStcmCsv([m({ id: 'a' })])
    expect(rows(csv)[1].endsWith(',')).toBe(true)
    expect(rows(csv)[1]).not.toContain('NULL')
  })

  it('ends with a newline', () => {
    expect(buildStcmCsv([m({ id: 'a' })]).csv.endsWith('\n')).toBe(true)
  })

  it('produces a header-only file for an empty project', () => {
    const { csv, rowCount } = buildStcmCsv([])
    expect(rows(csv)).toHaveLength(1)
    expect(rowCount).toBe(0)
  })
})
