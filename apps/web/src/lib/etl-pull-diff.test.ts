import { describe, it, expect } from 'vitest'
import { buildEtlPullDiff } from './etl-pull-diff'
import { ETL_SETTINGS_FILE } from './etl-pull-plan-builder'
import type { PreparedEtlPull } from './etl-pull'
import type { PullFile } from './pull-plan'

const file = (path: string): PullFile => ({
  path, category: 'scripts', order: 1, items: [], wholeFile: true,
})

const prepared = (over: Partial<PreparedEtlPull> = {}): PreparedEtlPull => ({
  plan: { groups: { docs: [], scripts: [], mappings: [], other: [] }, settingsChanged: false },
  nodes: [],
  remotePipeline: null,
  remoteDocs: {} as never,
  localByPath: new Map(),
  localPipeline: undefined,
  clonedOid: 'oid-1',
  branch: 'main',
  ...over,
})

describe('buildEtlPullDiff', () => {
  it('shows local content on the left and the incoming content on the right', () => {
    const diff = buildEtlPullDiff(file('a.sql'), prepared({
      nodes: [{ type: 'file', path: 'a.sql', content: 'SELECT 2' } as never],
      localByPath: new Map([['a.sql', { content: 'SELECT 1' } as never]]),
    }))
    expect(diff.oldContent).toBe('SELECT 1')
    expect(diff.newContent).toBe('SELECT 2')
    expect(diff.language).toBe('sql')
  })

  it('leaves the local side empty for a file we do not have yet (an add)', () => {
    const diff = buildEtlPullDiff(file('new.sql'), prepared({
      nodes: [{ type: 'file', path: 'new.sql', content: 'SELECT 1' } as never],
    }))
    expect(diff.oldContent).toBe('')
    expect(diff.newContent).toBe('SELECT 1')
  })

  it('diffs only the settings a pull may actually write', () => {
    // updatedAt and friends differ on every fetch; showing them would make the
    // settings row look changed when nothing pullable moved.
    const diff = buildEtlPullDiff({ ...file(ETL_SETTINGS_FILE), category: 'general' }, prepared({
      localPipeline: { name: { en: 'mine' }, updatedAt: 'x' } as never,
      remotePipeline: { name: { en: 'theirs' }, updatedAt: 'y' } as never,
    }))
    expect(diff.oldContent).toContain('mine')
    expect(diff.newContent).toContain('theirs')
    expect(diff.oldContent).not.toContain('updatedAt')
  })

  it('degrades to a blank diff rather than throwing when neither side has the file', () => {
    const diff = buildEtlPullDiff(file('ghost.sql'), prepared())
    expect(diff.oldContent).toBe('')
    expect(diff.newContent).toBe('')
  })
})
