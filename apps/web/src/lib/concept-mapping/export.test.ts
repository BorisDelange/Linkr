import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { exportToJson, buildMappingProjectFolder, restoreFileSourceDataFromCsv } from './export'
import type { Storage } from '@/lib/storage'
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

describe('buildMappingProjectFolder — portable project.json', () => {
  it('strips instance-specific fields (gitRemoteConfig, ownerId, timestamps)', async () => {
    const linked = {
      ...project,
      gitRemoteConfig: { url: 'https://gitlab.com/x/y', branch: 'main' },
      ownerId: 'user-42',
      workspaceId: 'ws-1',
      dataSourceId: 'ds-local-uuid',
      vocabularyDataSourceId: 'vocab-local-uuid',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    } as unknown as MappingProject
    const storage = {
      conceptMappings: { getByProject: async () => [] },
    } as unknown as Storage

    const zip = new JSZip()
    await buildMappingProjectFolder(zip, '', linked, storage)
    const parsed = JSON.parse(await zip.file('project.json')!.async('string'))

    // Portable metadata only — instance fields are the caller's to re-add (workspace export).
    expect(parsed.gitRemoteConfig).toBeUndefined()
    expect(parsed.ownerId).toBeUndefined()
    expect(parsed.workspaceId).toBeUndefined()
    expect(parsed.createdAt).toBeUndefined()
    // Local data-source UUIDs are not portable: vocabulary id dropped, source id blanked.
    expect(parsed.vocabularyDataSourceId).toBeUndefined()
    expect(parsed.dataSourceId).toBe('')
    // Genuine content survives.
    expect(parsed.id).toBe('proj1')
  })

  it('strips volatile fields from mappings.json and sorts by a stable key', async () => {
    const m2 = { ...makeMapping(), sourceConceptId: 2, sourceConceptCode: 'AA', id: 'm2' }
    const m1 = makeMapping() // sourceConceptCode 'VC'
    const storage = {
      conceptMappings: { getByProject: async () => [m1, m2] },
    } as unknown as Storage

    const zip = new JSZip()
    await buildMappingProjectFolder(zip, '', project, storage)
    const parsed = JSON.parse(await zip.file('mappings.json')!.async('string')) as Record<string, unknown>[]

    // Sorted by sourceConceptCode → 'AA' before 'VC'.
    expect(parsed.map((m) => m.sourceConceptCode)).toEqual(['AA', 'VC'])
    // Instance bookkeeping is gone…
    for (const m of parsed) {
      expect(m.id).toBeUndefined()
      expect(m.projectId).toBeUndefined()
      expect(m.createdAt).toBeUndefined()
      expect(m.updatedAt).toBeUndefined()
    }
    // …but content + human provenance + nested comment/review ids survive.
    expect(parsed[1].targetConceptCode).toBe('20112-9')
    expect(parsed[1].mappedBy).toBe('Boris Delange')
    expect((parsed[1].comments as Record<string, unknown>[])[0].id).toBe('c1')
    expect((parsed[1].reviews as Record<string, unknown>[])[0].createdAt).toBe('2026-01-02T00:00:00Z')
  })

  it('sorts many-to-many rows deterministically by full merge identity (source+target)', async () => {
    // One source concept mapped to two targets — the pair shares sourceConceptCode
    // AND sourceConceptId, so a source-only sort would leave them tied and their
    // order would follow DB iteration. Feeding both input orders must yield the
    // same on-disk order (no spurious git diff across instances/reindex).
    const base = makeMapping()
    const targetA = { ...base, id: 'a', targetConceptId: 1000, targetConceptCode: 'AAA' }
    const targetB = { ...base, id: 'b', targetConceptId: 2000, targetConceptCode: 'BBB' }

    const serialize = async (order: ConceptMapping[]) => {
      const storage = { conceptMappings: { getByProject: async () => order } } as unknown as Storage
      const zip = new JSZip()
      await buildMappingProjectFolder(zip, '', project, storage)
      const parsed = JSON.parse(await zip.file('mappings.json')!.async('string')) as Record<string, unknown>[]
      return parsed.map((m) => m.targetConceptCode)
    }

    const forward = await serialize([targetA, targetB])
    const reversed = await serialize([targetB, targetA])
    expect(forward).toEqual(['AAA', 'BBB'])
    expect(reversed).toEqual(forward)
  })
})

describe('restoreFileSourceDataFromCsv — LFS pointer guard', () => {
  const base = () => ({
    sourceType: 'file',
    fileSourceData: { fileName: 'source-concepts.csv', columnMapping: {}, columns: [], rows: [] },
  }) as unknown as MappingProject

  it('ignores an unresolved Git LFS pointer instead of importing a 3-line stub', () => {
    const p = base()
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 25427900\n'
    restoreFileSourceDataFromCsv(p, pointer)
    expect(p.fileSourceData!.rawFileBuffer).toBeUndefined()
  })

  it('restores real CSV content', () => {
    const p = base()
    restoreFileSourceDataFromCsv(p, 'terminology_code,concept_code\nADICAP,0000')
    expect(p.fileSourceData!.rawFileBuffer?.byteLength).toBeGreaterThan(0)
    expect(p.fileSourceData!.columns).toEqual(['terminology_code', 'concept_code'])
  })
})
