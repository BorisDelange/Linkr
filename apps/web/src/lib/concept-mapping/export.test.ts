import { describe, it, expect } from 'vitest'
import { exportToJson } from './export'
import type { ConceptMapping, MappingProject } from '@/types'

const project = {
  id: 'proj1',
  name: { en: 'Test project' },
  description: { en: '' },
} as unknown as MappingProject

function makeMapping(): ConceptMapping {
  return {
    id: 'm1',
    projectId: 'proj1',
    sourceConceptId: 1,
    sourceConceptName: 'Volume courant',
    sourceVocabularyId: 'LOCAL',
    sourceDomainId: 'Measurement',
    sourceConceptCode: 'VC',
    targetConceptId: 3000905,
    targetConceptName: 'Tidal volume',
    targetVocabularyId: 'LOINC',
    targetDomainId: 'Measurement',
    targetConceptCode: '20112-9',
    equivalence: 'skos:exactMatch',
    status: 'unchecked',
    mappedBy: 'Boris Delange',
    mappedByDetails: {
      firstName: 'Boris',
      lastName: 'Delange',
      affiliation: 'CHU Rennes',
      profession: 'Physician',
      orcid: '0009-0002-6055-6935',
    },
    reviewedBy: 'Jane Roe',
    reviewedByDetails: { firstName: 'Jane', lastName: 'Roe', orcid: '0000-0001-0000-0000' },
    comments: [
      { id: 'c1', authorId: 'Boris Delange', authorDetails: { firstName: 'Boris', lastName: 'Delange' }, text: 'ok', createdAt: '2026-01-01T00:00:00Z' },
    ],
    reviews: [
      { id: 'r1', reviewerId: 'Jane Roe', reviewerDetails: { orcid: '0000-0001-0000-0000' }, status: 'approved', createdAt: '2026-01-02T00:00:00Z' },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('exportToJson — author details round-trip', () => {
  it('preserves structured author details through serialize → parse', () => {
    const json = exportToJson([makeMapping()], project)
    const parsed = JSON.parse(json)
    const m = parsed.mappings[0]

    expect(m.mappedBy).toBe('Boris Delange')
    expect(m.mappedByDetails).toEqual({
      firstName: 'Boris',
      lastName: 'Delange',
      affiliation: 'CHU Rennes',
      profession: 'Physician',
      orcid: '0009-0002-6055-6935',
    })
    expect(m.reviewedByDetails.orcid).toBe('0000-0001-0000-0000')
    expect(m.comments[0].authorDetails).toEqual({ firstName: 'Boris', lastName: 'Delange' })
    expect(m.reviews[0].reviewerDetails).toEqual({ orcid: '0000-0001-0000-0000' })
  })

  it('keeps working for legacy mappings that only have the name string', () => {
    const legacy = makeMapping()
    delete legacy.mappedByDetails
    delete legacy.reviewedByDetails
    legacy.comments = undefined
    legacy.reviews = undefined
    const parsed = JSON.parse(exportToJson([legacy], project))
    const m = parsed.mappings[0]
    expect(m.mappedBy).toBe('Boris Delange')
    expect(m.mappedByDetails).toBeUndefined()
  })
})
