import { describe, expect, it } from 'vitest'
import type { ConceptSet, DataDictionary } from '@/types'
import { buildDictionaryLinks, clonedDictionaryFiles, readDictionaryLinks, unlinkedConceptSets } from './dictionary-links'

const dict = (over: Partial<DataDictionary>): DataDictionary => ({
  id: 'd', workspaceId: 'ws1', name: 'Core', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', ...over,
})

describe('buildDictionaryLinks', () => {
  it('points at the linked dictionaries only, named by slug, sorted', () => {
    const links = buildDictionaryLinks([
      dict({ id: 'b', name: 'Zeta', sourceRepo: 'https://x/zeta' }),
      dict({ id: 'local', name: 'Mine' }),
      dict({ id: 'a', name: 'Alpha', sourceRepo: ' https://x/alpha ', branch: 'dev' }),
    ])
    expect(links.map((l) => [l.entityId, l.git])).toEqual([
      ['alpha', { url: 'https://x/alpha', branch: 'dev' }],
      ['zeta', { url: 'https://x/zeta', branch: 'main' }],
    ])
  })

  it('suffixes a shared name in repo order, whatever the stored order', () => {
    const a = dict({ id: '1', name: 'Core', sourceRepo: 'https://x/b' })
    const b = dict({ id: '2', name: 'Core', sourceRepo: 'https://x/a' })
    const names = (ds: DataDictionary[]) => buildDictionaryLinks(ds).map((l) => [l.entityId, l.git.url])
    expect(names([a, b])).toEqual([['core', 'https://x/a'], ['core-2', 'https://x/b']])
    expect(names([b, a])).toEqual(names([a, b]))
  })
})

describe('unlinkedConceptSets', () => {
  it('keeps the sets of no linked dictionary', () => {
    const sets = [{ id: 's1', dictionaryId: 'linked' }, { id: 's2', dictionaryId: 'local' }, { id: 's3' }] as ConceptSet[]
    const dictionaries = [dict({ id: 'linked', sourceRepo: 'https://x/r' }), dict({ id: 'local' })]
    expect(unlinkedConceptSets(sets, dictionaries).map((s) => s.id)).toEqual(['s2', 's3'])
  })
})

describe('reading back', () => {
  it('drops entries with no entityId or repo, defaults the branch', () => {
    expect(readDictionaryLinks([{ entityId: 'core', name: 'Core', git: { url: 'https://x/r' } }, { name: 'x' }, null]))
      .toEqual([{ entityId: 'core', name: 'Core', git: { url: 'https://x/r', branch: 'main' } }])
    expect(readDictionaryLinks({})).toEqual([])
  })

  it('finds a dictionary\'s clone as repo-root paths, dictionary files only', () => {
    expect(clonedDictionaryFiles({
      'data-dictionaries/core/concept_sets/1.json': '{}',
      'data-dictionaries/core/units/recommended_units.json': '[]',
      'data-dictionaries/core/app/package.json': '{}',
      'data-dictionaries/other/concept_sets/2.json': '{}',
    }, 'core')).toEqual({ 'concept_sets/1.json': '{}', 'units/recommended_units.json': '[]' })
  })
})
