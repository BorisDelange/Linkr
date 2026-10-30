import { describe, expect, it } from 'vitest'
import { itemIdFor, type PullDecision } from '@/lib/pull-plan'
import { buildThreeWayPlan, overridesFor, prepareThreeWay, type ThreeWayFile } from './three-way'

const labels = { file: 'File', field: (k: string) => k, element: (k: string) => k, merged: 'merged' }
const prep = (...files: ThreeWayFile[]) => prepareThreeWay({ branch: 'main', remoteHead: 'r', files })
const j = (v: unknown) => JSON.stringify(v, null, 2)
const decide = (pairs: [string, string, PullDecision][]) => new Map(pairs.map(([p, k, d]) => [itemIdFor(p, k), d]))

describe('3-way pull: items by file kind', () => {
  it('a manifest gives one item per field, never the version stamp', () => {
    const [p] = prep({
      path: 'entity.json',
      base: j({ name: 'A', description: 'd', appVersion: '2.4.4' }),
      local: j({ name: 'A', description: 'mine', appVersion: '2.4.5' }),
      remote: j({ name: 'B', description: 'd', appVersion: '2.4.6' }),
    })
    const plan = buildThreeWayPlan('projects', { branch: 'main', remoteHead: 'r', files: [] }, [p], labels)
    expect(plan.files[0].items.map((i) => [i.key, i.state])).toEqual([['field:name', 'update']])
    // Taking the name keeps the local description and the local stamp.
    expect(JSON.parse((overridesFor([p], decide([['entity.json', 'field:name', 'accept']]))['entity.json'] as { text: string }).text))
      .toEqual({ name: 'B', description: 'mine', appVersion: '2.4.5' })
  })

  it('a keyed array gives one item per element, a both-sides edit being a conflict', () => {
    const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }]
    const [p] = prep({
      path: 'wiki/_tree.json',
      base: j(base),
      local: j([{ id: 'a', v: 2 }, { id: 'b', v: 1 }]),
      remote: j([{ id: 'a', v: 3 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }]),
    })
    const plan = buildThreeWayPlan('workspaces', { branch: 'main', remoteHead: 'r', files: [] }, [p], labels)
    expect(plan.files[0].items.map((i) => [i.key, i.state])).toEqual([['el:a', 'conflict'], ['el:c', 'add']])
    const text = (overridesFor([p], decide([['wiki/_tree.json', 'el:c', 'accept'], ['wiki/_tree.json', 'el:a', 'decline']]))['wiki/_tree.json'] as { text: string }).text
    expect(JSON.parse(text)).toEqual([{ id: 'a', v: 2 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }])
  })

  it('code merges by line: edits in different places are one update, the merge taken whole', () => {
    const [p] = prep({ path: 'scripts/a.sql', base: 'a\nb\nc\n', local: 'A\nb\nc\n', remote: 'a\nb\nC\n' })
    expect(p.merge.kind === 'text' && p.merge.state).toBe('update')
    expect(overridesFor([p], decide([['scripts/a.sql', 'file', 'accept']]))).toEqual({ 'scripts/a.sql': { text: 'A\nb\nC\n' } })
  })

  it('markdown conflicts per paragraph; accepting takes the remote paragraph and keeps the merged rest', () => {
    const [p] = prep({
      path: 'README.md',
      base: 'T\n\nx\n\nm\n\ny\n', local: 'T\n\nmine\n\nm\n\ny2\n', remote: 'T\n\ntheirs\n\nm\n\ny\n',
    })
    expect(p.merge.kind === 'text' && p.merge.state).toBe('conflict')
    expect(overridesFor([p], decide([['README.md', 'file', 'accept']]))).toEqual({ 'README.md': { text: 'T\n\ntheirs\n\nm\n\ny2\n' } })
  })

  it('a binary file is whole: added, taken from the remote, or deleted', () => {
    const files = prep(
      { path: 'logo.png', binary: true, baseOid: null, localOid: null, remoteOid: 'r1' },
      { path: 'old.png', binary: true, baseOid: 'o', localOid: 'o', remoteOid: null },
      { path: 'same.png', binary: true, baseOid: 'o', localOid: 'n', remoteOid: 'n' },
    )
    expect(files.map((f) => [f.file.path, f.merge.kind === 'whole' && f.merge.state])).toEqual([['logo.png', 'add'], ['old.png', 'delete']])
    expect(overridesFor(files, decide([['logo.png', 'file', 'accept'], ['old.png', 'file', 'accept']])))
      .toEqual({ 'logo.png': { remote: true }, 'old.png': { delete: true } })
  })

  it('a local-only change and a change made identically on both sides offer nothing', () => {
    expect(prep(
      { path: 'a.md', base: 'x\n', local: 'y\n', remote: 'x\n' },
      { path: 'b.md', base: 'x\n', local: 'z\n', remote: 'z\n' },
    )).toEqual([])
  })

  it('declining everything changes no file', () => {
    const files = prep({ path: 'a.md', base: 'x\n', local: 'x\n', remote: 'y\n' })
    expect(overridesFor(files, decide([['a.md', 'file', 'decline']]))).toEqual({})
  })
})
