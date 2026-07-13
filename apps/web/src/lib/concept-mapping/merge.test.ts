import { describe, it, expect } from 'vitest'
import { mappingKey, mappingsEqual, mergeMappings, mergeMetadata } from './merge'
import type { ConceptMapping, MappingProject } from '@/types'

// A minimal mapping factory — only the fields the merge looks at matter.
function m(over: Partial<ConceptMapping> = {}): ConceptMapping {
  return {
    id: crypto.randomUUID(), // deliberately random — must NOT be the merge key
    projectId: 'p',
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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as ConceptMapping
}

describe('mappingKey — stable across instances', () => {
  it('ignores the id (regenerated on import) and keys by source+target', () => {
    const a = m({ id: 'aaa' })
    const b = m({ id: 'bbb' }) // different id, same source+target
    expect(mappingKey(a)).toBe(mappingKey(b))
  })

  it('distinguishes a different target for the same source (multi-target)', () => {
    const a = m({ targetConceptId: 1, targetConceptCode: 'X' })
    const b = m({ targetConceptId: 2, targetConceptCode: 'Y' })
    expect(mappingKey(a)).not.toBe(mappingKey(b))
  })
})

describe('mappingsEqual — compares content, not id/timestamps', () => {
  it('is true when only id and timestamps differ', () => {
    expect(mappingsEqual(m({ id: 'a', updatedAt: 't1' }), m({ id: 'b', updatedAt: 't2' }))).toBe(true)
  })
  it('is false when status changed', () => {
    expect(mappingsEqual(m({ status: 'unchecked' }), m({ status: 'approved' }))).toBe(false)
  })
  it('treats absent vs empty optional fields as equal', () => {
    expect(mappingsEqual(m({ reviewComment: undefined }), m({ reviewComment: '' }))).toBe(true)
  })
})

describe('mergeMappings — 3-way classification', () => {
  it('adds a mapping present only in REMOTE', () => {
    const base: ConceptMapping[] = []
    const local: ConceptMapping[] = []
    const remote = [m({ sourceConceptCode: 'NEW' })]
    const changes = mergeMappings(base, remote, local)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('add')
  })

  it('applies a clean remote update (changed remotely, untouched locally)', () => {
    const base = [m({ status: 'unchecked' })]
    const local = [m({ status: 'unchecked' })]
    const remote = [m({ status: 'approved' })]
    const changes = mergeMappings(base, remote, local)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('update')
    expect(changes[0].remote?.status).toBe('approved')
  })

  it('proposes a delete when REMOTE removed a mapping we did not touch', () => {
    const base = [m()]
    const local = [m()]
    const remote: ConceptMapping[] = []
    const changes = mergeMappings(base, remote, local)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('delete')
    expect(changes[0].remote).toBeNull()
  })

  it('ignores a mapping only I changed (remote unchanged) — nothing to pull', () => {
    const base = [m({ status: 'unchecked' })]
    const remote = [m({ status: 'unchecked' })]
    const local = [m({ status: 'approved' })]
    expect(mergeMappings(base, remote, local)).toHaveLength(0)
  })

  it('ignores a mapping both sides changed identically', () => {
    const base = [m({ status: 'unchecked' })]
    const remote = [m({ status: 'approved' })]
    const local = [m({ status: 'approved' })]
    expect(mergeMappings(base, remote, local)).toHaveLength(0)
  })

  it('flags a conflict when both sides changed the same key differently', () => {
    const base = [m({ status: 'unchecked' })]
    const remote = [m({ status: 'approved' })]
    const local = [m({ status: 'rejected' })]
    const changes = mergeMappings(base, remote, local)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('conflict')
    expect(changes[0].remote?.status).toBe('approved')
    expect(changes[0].local?.status).toBe('rejected')
  })

  it('flags a delete-vs-edit conflict (removed remotely, edited locally)', () => {
    const base = [m({ status: 'unchecked' })]
    const remote: ConceptMapping[] = [] // removed remotely
    const local = [m({ status: 'approved' })] // edited locally
    const changes = mergeMappings(base, remote, local)
    expect(changes).toHaveLength(1)
    expect(changes[0].type).toBe('conflict')
    expect(changes[0].remote).toBeNull()
    expect(changes[0].local?.status).toBe('approved')
  })

  it('re-targeting a source reads as delete(old) + add(new) under source+target key', () => {
    const base = [m({ targetConceptId: 1, targetConceptCode: 'OLD' })]
    const local = [m({ targetConceptId: 1, targetConceptCode: 'OLD' })]
    const remote = [m({ targetConceptId: 2, targetConceptCode: 'NEW' })]
    const changes = mergeMappings(base, remote, local)
    const types = changes.map((c) => c.type).sort()
    expect(types).toEqual(['add', 'delete'])
  })
})

describe('mergeMetadata — per-field 3-way', () => {
  const base = { name: { en: 'Project' }, description: { en: 'desc' } } as Partial<MappingProject>

  it('applies a clean remote field change', () => {
    const remote = { name: { en: 'Renamed' }, description: { en: 'desc' } } as Partial<MappingProject>
    const local = { name: { en: 'Project' }, description: { en: 'desc' } } as Partial<MappingProject>
    const res = mergeMetadata(base, remote, local)
    expect(res.conflicts).toHaveLength(0)
    expect(res.cleanUpdates).toHaveLength(1)
    expect(res.cleanUpdates[0].field).toBe('name')
  })

  it('flags a per-field conflict when both changed the same field', () => {
    const remote = { name: { en: 'Theirs' }, description: { en: 'desc' } } as Partial<MappingProject>
    const local = { name: { en: 'Mine' }, description: { en: 'desc' } } as Partial<MappingProject>
    const res = mergeMetadata(base, remote, local)
    expect(res.cleanUpdates).toHaveLength(0)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0].field).toBe('name')
    expect(res.conflicts[0].remote).toEqual({ en: 'Theirs' })
    expect(res.conflicts[0].local).toEqual({ en: 'Mine' })
  })

  it('does nothing when only I changed a field', () => {
    const remote = { name: { en: 'Project' }, description: { en: 'desc' } } as Partial<MappingProject>
    const local = { name: { en: 'Mine' }, description: { en: 'desc' } } as Partial<MappingProject>
    const res = mergeMetadata(base, remote, local)
    expect(res.cleanUpdates).toHaveLength(0)
    expect(res.conflicts).toHaveLength(0)
  })
})
