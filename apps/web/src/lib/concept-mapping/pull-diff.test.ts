import { describe, it, expect } from 'vitest'
import { buildPullDiff } from './pull-diff'
import { buildPullFiles, type PullFile } from '@/lib/pull-plan'
import type { MappingProjectMerge } from './merge'
import type { ConceptMapping } from '@/types'

const emptyMerge = (): MappingProjectMerge => ({
  mappings: [],
  metadata: { cleanUpdates: [], conflicts: [] },
  sourceConcepts: { changed: false, localCount: 0, remoteCount: 0 },
})

const file = (path: string, keys: string[], wholeFile = false): PullFile => {
  const [built] = buildPullFiles('mapping-projects', [
    { path, items: keys.map((k) => ({ key: k, label: k, state: 'update' as const })), wholeFile },
  ])
  return built
}

const mapping = (over: Partial<ConceptMapping> = {}): ConceptMapping => ({
  id: 'local-id',
  projectId: 'p',
  sourceVocabularyId: 'LOCAL',
  sourceConceptCode: 'VC',
  sourceConceptName: 'Volume courant',
  targetConceptId: 3000905,
  targetConceptName: 'Tidal volume',
  targetVocabularyId: 'LOINC',
  targetConceptCode: '20112-9',
  status: 'unchecked',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
} as ConceptMapping)

describe('project.json diff — only what can actually be imported', () => {
  it('shows a clean update as mine → theirs', () => {
    const merge = emptyMerge()
    merge.metadata.cleanUpdates = [{ field: 'name', value: 'New name' }]
    const diff = buildPullDiff(file('project.json', ['name']), merge, undefined)
    expect(diff.newContent).toContain('New name')
    expect(diff.language).toBe('json')
  })

  it('shows both sides of a conflicted field', () => {
    const merge = emptyMerge()
    merge.metadata.conflicts = [{ field: 'description', base: 'b', remote: 'theirs', local: 'mine' }]
    const diff = buildPullDiff(file('project.json', ['description']), merge, undefined)
    expect(diff.oldContent).toContain('mine')
    expect(diff.newContent).toContain('theirs')
  })

  it('never renders a field the row does not carry', () => {
    // The whole point of P2: a raw file diff would parade uid/createdAt/ownerId,
    // which are different between any two instances and never imported.
    const merge = emptyMerge()
    merge.metadata.cleanUpdates = [{ field: 'name', value: 'New name' }]
    const diff = buildPullDiff(file('project.json', ['name']), merge, undefined)
    for (const forbidden of ['uid', 'createdAt', 'ownerId', 'gitRemoteConfig']) {
      expect(diff.newContent).not.toContain(forbidden)
    }
  })

  it('renders a README as markdown text, not an escaped JSON blob', () => {
    const merge = emptyMerge()
    merge.metadata.cleanUpdates = [{ field: 'readme', value: { en: '# Title\nBody' } }]
    const diff = buildPullDiff(file('README.md', ['readme']), merge, undefined)
    expect(diff.language).toBe('markdown')
    expect(diff.newContent).toContain('# Title')
    expect(diff.newContent).not.toContain('\\n')
  })

  it('labels each language of a multilingual README so a FR-only change is visible', () => {
    const merge = emptyMerge()
    merge.metadata.cleanUpdates = [{ field: 'readme', value: { en: 'Hello', fr: 'Bonjour' } }]
    const diff = buildPullDiff(file('README.md', ['readme']), merge, undefined)
    expect(diff.newContent).toContain('Hello')
    expect(diff.newContent).toContain('Bonjour')
    expect(diff.newContent).toContain('fr')
  })
})

describe('mappings.json diff', () => {
  it('keys each side by source vocabulary and code, not by local id', () => {
    const merge = emptyMerge()
    merge.mappings = [{
      key: 'k',
      type: 'update',
      remote: mapping({ id: 'remote-id', targetConceptName: 'Tidal volume (remote)' }),
      local: mapping({ id: 'local-id' }),
      base: null,
    }]
    const diff = buildPullDiff(file('mappings.json', ['k']), merge, undefined)
    expect(diff.newContent).toContain('LOCAL|VC')
    // Ids are regenerated on import, so showing them would be pure noise.
    expect(diff.newContent).not.toContain('remote-id')
    expect(diff.oldContent).not.toContain('local-id')
  })

  it('marks an addition "(absent)" on my side, not null', () => {
    // `null` reads as "the value is null"; on an addition the whole left column
    // would be nulls, when what it means is "I don't have this mapping".
    const merge = emptyMerge()
    merge.mappings = [{ key: 'k', type: 'add', remote: mapping(), local: null, base: null }]
    const diff = buildPullDiff(file('mappings.json', ['k']), merge, undefined)
    expect(diff.oldContent).toContain('(absent)')
    expect(diff.newContent).toContain('Tidal volume')
  })

  it('keys the projection by source AND target, so one source can have several', () => {
    // Keyed on the source alone, two mappings of the same concept collided and the
    // diff showed fewer changes than the pull would apply.
    const merge = emptyMerge()
    merge.mappings = [
      { key: 'k1', type: 'add', remote: mapping({ targetConceptCode: '20112-9' }), local: null, base: null },
      { key: 'k2', type: 'add', remote: mapping({ targetConceptCode: '99999-9' }), local: null, base: null },
    ]
    const diff = buildPullDiff(file('mappings.json', ['k1', 'k2']), merge, undefined)
    expect(Object.keys(JSON.parse(diff.newContent))).toHaveLength(2)
  })
})

describe('source-concepts.csv diff', () => {
  it('renders the row tally rather than pretending to a row-by-row diff', () => {
    const diff = buildPullDiff(file('source-concepts.csv', ['added']), emptyMerge(), {
      keyed: true, added: 2, removed: 5, modified: 13, unchanged: 100,
      localTotal: 118, remoteTotal: 115, changes: [], changesTruncated: false,
    })
    expect(diff.newContent).toContain('"added": 2')
    expect(diff.newContent).toContain('"removed": 5')
    expect(diff.oldContent).toContain('118')
  })

  it('says so plainly when the file cannot be compared', () => {
    const diff = buildPullDiff(file('source-concepts.csv', [], true), emptyMerge(), {
      keyed: false, added: 0, removed: 0, modified: 0, unchanged: 0,
      localTotal: 0, remoteTotal: 0, changes: [], changesTruncated: false,
    })
    expect(diff.notice).toBe('whole_file')
  })

  it('treats a missing diff as uncomparable rather than as "no changes"', () => {
    const diff = buildPullDiff(file('source-concepts.csv', [], true), emptyMerge(), undefined)
    expect(diff.notice).toBe('whole_file')
  })
})
