import { describe, it, expect } from 'vitest'
import { buildMappingProjectPullPlan } from './pull-plan-builder'
import { sourceConceptsChanged, type PreparedPull } from './pull'
import type { SourceConceptsDiff } from '@/lib/api/git'

const diff = (over: Partial<SourceConceptsDiff> = {}): SourceConceptsDiff => ({
  keyed: true, added: 0, removed: 0, modified: 0, unchanged: 0,
  localTotal: 0, remoteTotal: 0, changes: [], changesTruncated: false,
  ...over,
})

const prepared = (over: Partial<PreparedPull> = {}): PreparedPull => ({
  merge: {
    mappings: [],
    metadata: { cleanUpdates: [], conflicts: [] },
    sourceConcepts: { changed: false, localCount: 0, remoteCount: 0 },
  },
  remoteHead: 'abc',
  localMappings: [],
  localProject: undefined,
  sourceConceptsDiff: undefined,
  remoteRegistry: { ranges: null, entries: null },
  ...over,
})

const paths = (p: ReturnType<typeof buildMappingProjectPullPlan>) => p.files.map((f) => f.path)

describe('sourceConceptsChanged — what counts as "there is something to pull"', () => {
  it('trusts the ROW diff, which compares local to remote', () => {
    expect(sourceConceptsChanged(diff({ added: 2 }), false)).toBe(true)
    expect(sourceConceptsChanged(diff({ removed: 5 }), false)).toBe(true)
    expect(sourceConceptsChanged(diff({ modified: 1 }), false)).toBe(true)
  })

  it('surfaces a drift the oid test alone hid: remote unmoved, local differs', () => {
    // The regression this fixes. The oid test asks "did the remote move since our
    // anchor?" — false here — so source-concepts.csv never appeared in the pull,
    // even though the local list no longer matched it.
    expect(sourceConceptsChanged(diff({ added: 2, removed: 5 }), false)).toBe(true)
  })

  it('reports nothing to pull when the rows agree, even if the blob moved', () => {
    // A re-export can change the bytes (column order, quoting) without changing a
    // single concept; offering that as a pull would be noise.
    expect(sourceConceptsChanged(diff(), true)).toBe(false)
  })

  it('falls back to the oid test when the CSV could not be keyed', () => {
    expect(sourceConceptsChanged(diff({ keyed: false }), true)).toBe(true)
    expect(sourceConceptsChanged(diff({ keyed: false }), false)).toBe(false)
  })

  it('falls back to the oid test when the server sent no diff at all', () => {
    expect(sourceConceptsChanged(undefined, true)).toBe(true)
    expect(sourceConceptsChanged(undefined, false)).toBe(false)
  })
})

describe('source-concepts row', () => {
  it('appears with its counts when rows moved', () => {
    const plan = buildMappingProjectPullPlan(prepared({
      merge: {
        mappings: [],
        metadata: { cleanUpdates: [], conflicts: [] },
        sourceConcepts: { changed: true, localCount: 118, remoteCount: 115 },
      },
      sourceConceptsDiff: diff({ added: 2, removed: 5, modified: 13, localTotal: 118, remoteTotal: 115 }),
    }), 'main')

    const row = plan.files.find((f) => f.path === 'source-concepts.csv')
    expect(row).toBeDefined()
    expect(row!.items.map((i) => [i.key, i.detail])).toEqual([
      ['added', '2'], ['removed', '5'], ['modified', '13'],
    ])
    // Reviewable row by row, but decided as one block — the CSV is written whole.
    expect(row!.pickable).toBe(true)
  })

  it('falls back to a whole-file row when the CSV could not be keyed', () => {
    const plan = buildMappingProjectPullPlan(prepared({
      merge: {
        mappings: [],
        metadata: { cleanUpdates: [], conflicts: [] },
        sourceConcepts: { changed: true, localCount: 0, remoteCount: 0 },
      },
      sourceConceptsDiff: diff({ keyed: false }),
    }), 'main')

    const row = plan.files.find((f) => f.path === 'source-concepts.csv')!
    expect(row.wholeFile).toBe(true)
    expect(row.items).toEqual([])
  })

  it('is absent when the source list did not change', () => {
    const plan = buildMappingProjectPullPlan(prepared(), 'main')
    expect(paths(plan)).not.toContain('source-concepts.csv')
  })

  it('omits a change type with a zero count', () => {
    const plan = buildMappingProjectPullPlan(prepared({
      merge: {
        mappings: [],
        metadata: { cleanUpdates: [], conflicts: [] },
        sourceConcepts: { changed: true, localCount: 1, remoteCount: 2 },
      },
      sourceConceptsDiff: diff({ added: 1 }),
    }), 'main')
    const row = plan.files.find((f) => f.path === 'source-concepts.csv')!
    expect(row.items.map((i) => i.key)).toEqual(['added'])
  })
})

describe('metadata rows', () => {
  it('lists a field under entity.json', () => {
    const plan = buildMappingProjectPullPlan(prepared({
      merge: {
        mappings: [],
        metadata: { cleanUpdates: [{ field: 'name', value: 'New' }], conflicts: [] },
        sourceConcepts: { changed: false, localCount: 0, remoteCount: 0 },
      },
    }), 'main')
    const row = plan.files.find((f) => f.path === 'entity.json')!
    expect(row.items.map((i) => i.key)).toEqual(['name'])
    // No picker: a handful of fields is decided on the row itself.
    expect(row.pickable).toBeFalsy()
  })

  it('routes readme and license to their OWN files, where their diff is readable', () => {
    const plan = buildMappingProjectPullPlan(prepared({
      merge: {
        mappings: [],
        metadata: {
          cleanUpdates: [{ field: 'readme', value: { en: 'hi' } }],
          conflicts: [{ field: 'license', base: null, remote: { id: 'MIT' }, local: { id: 'CC' } }],
        },
        sourceConcepts: { changed: false, localCount: 0, remoteCount: 0 },
      },
    }), 'main')
    expect(paths(plan).sort()).toEqual(['LICENSE.md', 'README.md'])
  })

  it('marks a field changed on both sides as a conflict', () => {
    const plan = buildMappingProjectPullPlan(prepared({
      merge: {
        mappings: [],
        metadata: { cleanUpdates: [], conflicts: [{ field: 'name', base: 'a', remote: 'b', local: 'c' }] },
        sourceConcepts: { changed: false, localCount: 0, remoteCount: 0 },
      },
    }), 'main')
    expect(plan.files[0].items[0].state).toBe('conflict')
  })
})

describe('the registry is never listed', () => {
  it('leaves source-concept-ids out of the plan — its merge has no wrong answer', () => {
    const plan = buildMappingProjectPullPlan(prepared({
      remoteRegistry: { ranges: '[]', entries: '{}' },
    }), 'main')
    expect(paths(plan).some((p) => p.startsWith('source-concept-ids/'))).toBe(false)
  })
})

describe('file ordering', () => {
  it('follows the push list\'s category order, not the path alphabet', () => {
    const plan = buildMappingProjectPullPlan(prepared({
      merge: {
        mappings: [{ key: 'k', type: 'add', remote: null, local: null, base: null }],
        metadata: { cleanUpdates: [{ field: 'name', value: 'x' }], conflicts: [] },
        sourceConcepts: { changed: true, localCount: 0, remoteCount: 1 },
      },
      sourceConceptsDiff: diff({ added: 1 }),
    }), 'main')
    expect(paths(plan)).toEqual(['entity.json', 'mappings.json', 'source-concepts.csv'])
  })
})
