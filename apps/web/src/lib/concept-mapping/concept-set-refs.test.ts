import { describe, it, expect } from 'vitest'
import type { ConceptSet } from '@/types'
import { resolveConceptSetRefs, toConceptSetRefs } from './concept-set-refs'

const set = (id: string, over: Partial<ConceptSet> = {}): ConceptSet => ({
  id,
  workspaceId: 'ws',
  name: `Set ${id}`,
  description: '',
  expression: { items: [] },
  resolvedConceptIds: null,
  createdAt: '',
  updatedAt: '',
  ...over,
})

const INDICATE = 'https://github.com/indicate-eu/data-dictionary'

describe('toConceptSetRefs', () => {
  it('names each set by uniqueId + repo, or by name when it has none, sorted', () => {
    const sets = [
      set('a', { uniqueId: 'u-2', sourceRepo: INDICATE }),
      set('b', { name: 'Local sepsis' }),
      set('c', { uniqueId: 'u-1' }),
    ]
    expect(toConceptSetRefs(['a', 'b', 'c'], sets)).toEqual([
      { name: 'Local sepsis' },
      { uniqueId: 'u-1' },
      { uniqueId: 'u-2', sourceRepo: INDICATE },
    ])
  })

  it('drops ids whose set is gone, and repeats', () => {
    expect(toConceptSetRefs(['x', 'a', 'a'], [set('a', { uniqueId: 'u' })])).toEqual([{ uniqueId: 'u' }])
  })
})

describe('resolveConceptSetRefs', () => {
  it('matches on uniqueId, preferring the set from the same repo', () => {
    const sets = [
      set('fork', { uniqueId: 'u', sourceRepo: 'https://github.com/sfar/data-dictionary' }),
      set('origin', { uniqueId: 'u', sourceRepo: INDICATE }),
    ]
    expect(resolveConceptSetRefs([{ uniqueId: 'u', sourceRepo: INDICATE }], sets)).toEqual({ ids: ['origin'], missing: [] })
    expect(resolveConceptSetRefs([{ uniqueId: 'u' }], sets).ids).toEqual(['fork'])
  })

  // A name is a weak identity: it resolves only when it is unambiguous.
  it('matches a named ref only when exactly one set has that name', () => {
    const sets = [set('a', { name: 'Dup' }), set('b', { name: 'Dup' }), set('c', { name: 'Solo' })]
    expect(resolveConceptSetRefs([{ name: 'Dup' }, { name: 'Solo' }], sets)).toEqual({
      ids: ['c'],
      missing: [{ name: 'Dup' }],
    })
  })

  it('lists what the workspace does not have', () => {
    expect(resolveConceptSetRefs([{ uniqueId: 'nope', sourceRepo: INDICATE }], []).missing).toEqual([
      { uniqueId: 'nope', sourceRepo: INDICATE },
    ])
    expect(resolveConceptSetRefs(undefined, [])).toEqual({ ids: [], missing: [] })
  })
})
