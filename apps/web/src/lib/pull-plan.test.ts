import { describe, it, expect } from 'vitest'
import {
  buildPullFiles,
  conflictCount,
  isCompletePull,
  isFullyReviewed,
  itemId,
  pendingCount,
  planIsEmpty,
  planTotals,
  pullChangeType,
  wholeFileId,
  type PullDecision,
  type PullFile,
  type PullItem,
  type PullPlan,
} from './pull-plan'

const item = (key: string, state: PullItem['state'] = 'update'): PullItem => ({ key, label: key, state })

const plan = (files: PullFile[]): PullPlan => ({
  scope: 'mapping-projects',
  branch: 'main',
  remoteHead: 'abc123',
  files,
})

const file = (path: string, items: PullItem[], wholeFile = false): PullFile => {
  const [built] = buildPullFiles('mapping-projects', [{ path, items, wholeFile }])
  return built
}

describe('buildPullFiles', () => {
  it('resolves each path to the SAME category the push list uses', () => {
    const files = buildPullFiles('mapping-projects', [
      { path: 'mappings.json', items: [item('a')] },
      { path: 'project.json', items: [item('name')] },
    ])
    expect(files.map((f) => f.category)).toEqual(['general', 'mappings'])
  })

  it('sorts by category order, not by path', () => {
    const files = buildPullFiles('mapping-projects', [
      { path: 'source-concepts.csv', items: [item('a')] },
      { path: 'project.json', items: [item('b')] },
      { path: 'mappings.json', items: [item('c')] },
    ])
    expect(files.map((f) => f.path)).toEqual(['project.json', 'mappings.json', 'source-concepts.csv'])
  })

  it('drops files with nothing to pull', () => {
    const files = buildPullFiles('mapping-projects', [
      { path: 'mappings.json', items: [] },
      { path: 'project.json', items: [item('name')] },
    ])
    expect(files.map((f) => f.path)).toEqual(['project.json'])
  })

  it('keeps an empty file when it is a whole-file row', () => {
    // An unkeyable source CSV has no listable items but is still pullable.
    const files = buildPullFiles('mapping-projects', [
      { path: 'source-concepts.csv', items: [], wholeFile: true },
    ])
    expect(files).toHaveLength(1)
  })
})

describe('pullChangeType', () => {
  it('is "added" only when every item is an addition', () => {
    expect(pullChangeType(file('mappings.json', [item('a', 'add'), item('b', 'add')]))).toBe('added')
  })

  it('is "deleted" only when every item is a removal', () => {
    expect(pullChangeType(file('mappings.json', [item('a', 'delete')]))).toBe('deleted')
  })

  it('is "modified" for a mixed file', () => {
    expect(pullChangeType(file('mappings.json', [item('a', 'add'), item('b', 'delete')]))).toBe('modified')
  })
})

describe('counters', () => {
  it('counts conflicts separately — they never resolve implicitly', () => {
    const f = file('mappings.json', [item('a'), item('b', 'conflict'), item('c', 'conflict')])
    expect(conflictCount(f)).toBe(2)
  })

  it('counts items still awaiting a decision', () => {
    const f = file('mappings.json', [item('a'), item('b')])
    const decisions = new Map<string, PullDecision>([[itemId(f, f.items[0]), 'accept']])
    expect(pendingCount(f, decisions)).toBe(1)
  })

  it('totals items by state across the whole plan', () => {
    const p = plan([
      file('mappings.json', [item('a', 'add'), item('b', 'conflict')]),
      file('project.json', [item('name', 'update')]),
    ])
    expect(planTotals(p)).toEqual({ add: 1, update: 1, delete: 0, conflict: 1 })
  })

  it('reports an empty plan when nothing came in', () => {
    expect(planIsEmpty(plan([]))).toBe(true)
    expect(planIsEmpty(plan([file('mappings.json', [item('a')])]))).toBe(false)
  })
})

describe('itemId', () => {
  it('disambiguates the same key appearing in two files', () => {
    const a = file('mappings.json', [item('name')])
    const b = file('project.json', [item('name')])
    expect(itemId(a, a.items[0])).not.toBe(itemId(b, b.items[0]))
  })
})

describe('isFullyReviewed — the finalize gate', () => {
  it('is false while any item is untouched', () => {
    const f = file('mappings.json', [item('a'), item('b')])
    const decisions = new Map<string, PullDecision>([[itemId(f, f.items[0]), 'accept']])
    expect(isFullyReviewed(plan([f]), decisions)).toBe(false)
  })

  it('is true once every item has a verdict — declining counts as deciding', () => {
    const f = file('mappings.json', [item('a'), item('b')])
    const decisions = new Map<string, PullDecision>([
      [itemId(f, f.items[0]), 'accept'],
      [itemId(f, f.items[1]), 'decline'],
    ])
    expect(isFullyReviewed(plan([f]), decisions)).toBe(true)
  })

  it('treats a whole-file row as a single decision keyed on its path', () => {
    const f = file('source-concepts.csv', [], true)
    expect(isFullyReviewed(plan([f]), new Map())).toBe(false)
    expect(isFullyReviewed(plan([f]), new Map([[wholeFileId(f), 'decline' as const]]))).toBe(true)
  })
})

describe('conflicts always have somewhere to be resolved', () => {
  // Bulk-accept is refused on a file holding conflicts, so if such a file offered
  // no per-item route either, it would be a dead end: nothing to click, and the
  // pull could never finalize. Every conflicted file must therefore be pickable
  // (a table) or expanded inline (items listed under the row).
  const routeExists = (f: PullFile) => f.pickable === true || (!f.wholeFile && f.items.length > 0)

  it('a pickable file routes conflicts to its table', () => {
    const [f] = buildPullFiles('mapping-projects', [
      { path: 'mappings.json', items: [item('a', 'conflict')], pickable: true },
    ])
    expect(routeExists(f)).toBe(true)
  })

  it('a non-pickable file lists its items, so a conflict is still decidable', () => {
    const [f] = buildPullFiles('mapping-projects', [
      { path: 'project.json', items: [item('name', 'conflict')] },
    ])
    expect(f.pickable).toBeFalsy()
    expect(routeExists(f)).toBe(true)
  })

  it('a whole-file row can never carry conflicts (nothing could resolve them)', () => {
    const [f] = buildPullFiles('mapping-projects', [
      { path: 'source-concepts.csv', items: [], wholeFile: true },
    ])
    expect(conflictCount(f)).toBe(0)
  })
})

describe('isCompletePull — which cursor may advance', () => {
  it('is true only when EVERYTHING was accepted', () => {
    const f = file('mappings.json', [item('a'), item('b')])
    const all = new Map<string, PullDecision>(f.items.map((i) => [itemId(f, i), 'accept']))
    expect(isCompletePull(plan([f]), all)).toBe(true)
  })

  it('is false when one item was declined, even though the plan is fully reviewed', () => {
    // This is the whole point of the split: decided, so the push unblocks, but we
    // do NOT hold the commit's content, so the 3-way base must stay put.
    const f = file('mappings.json', [item('a'), item('b')])
    const decisions = new Map<string, PullDecision>([
      [itemId(f, f.items[0]), 'accept'],
      [itemId(f, f.items[1]), 'decline'],
    ])
    expect(isFullyReviewed(plan([f]), decisions)).toBe(true)
    expect(isCompletePull(plan([f]), decisions)).toBe(false)
  })

  it('is false while items are merely undecided', () => {
    const f = file('mappings.json', [item('a')])
    expect(isCompletePull(plan([f]), new Map())).toBe(false)
  })

  it('requires an accepted whole-file row, not merely a decided one', () => {
    const f = file('source-concepts.csv', [], true)
    expect(isCompletePull(plan([f]), new Map([[wholeFileId(f), 'decline' as const]]))).toBe(false)
    expect(isCompletePull(plan([f]), new Map([[wholeFileId(f), 'accept' as const]]))).toBe(true)
  })
})
