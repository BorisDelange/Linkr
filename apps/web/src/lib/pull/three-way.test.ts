import { describe, expect, it } from 'vitest'
import { itemIdFor, type PullDecision } from '@/lib/pull-plan'
import { APP_VERSION } from '@/lib/version'
import { buildThreeWayPlan, overridesFor, PullAppTooOldError, prepareThreeWay, type ThreeWayFile } from './three-way'

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

  it('a conflict settled by hand writes the text as the user left it', () => {
    const [p] = prep({ path: 'README.md', base: 'x\n', local: 'mine\n', remote: 'theirs\n' })
    const edits = new Map([['README.md', 'mine and theirs\n']])
    expect(overridesFor([p], decide([['README.md', 'file', 'accept']]), edits)).toEqual({ 'README.md': { text: 'mine and theirs\n' } })
  })

  it('a binary file is whole: added, taken from the remote, or deleted', () => {
    const files = prep(
      { path: 'logo.png', binary: true, baseOid: null, localOid: null, remoteOid: 'r1' },
      { path: 'old.png', binary: true, baseOid: 'o', localOid: 'o', remoteOid: null },
      { path: 'same.png', binary: true, baseOid: 'o', localOid: 'n', remoteOid: 'n' },
    )
    expect(files.map((f) => [f.file.path, f.merge.kind === 'whole' && f.merge.state])).toEqual([['logo.png', 'add'], ['old.png', 'delete']])
    expect(overridesFor(files, decide([['logo.png', 'file', 'accept'], ['old.png', 'file', 'accept']])))
      .toEqual({ 'logo.png': { remote: true, localOid: null }, 'old.png': { delete: true, localOid: 'o' } })
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

  it('a whole JSON file deleted on the remote is one delete per field, and taking them all deletes it', () => {
    const doc = j({ name: 'D', tabs: [] })
    const [p] = prep({ path: 'dashboards/d.json', base: doc, local: doc, remote: null })
    expect(p.merge.kind === 'fields' && p.merge.fields.map((f) => [f.key, f.state])).toEqual([['name', 'delete'], ['tabs', 'delete']])
    const all = decide([['dashboards/d.json', 'field:name', 'accept'], ['dashboards/d.json', 'field:tabs', 'accept']])
    expect(overridesFor([p], all)).toEqual({ 'dashboards/d.json': { delete: true } })
  })

  it('a keyed array whose names repeat is merged by line, not by element', () => {
    const [p] = prep({
      path: 'checks.json',
      base: j([{ name: 'x', v: 1 }, { name: 'x', v: 2 }]),
      local: j([{ name: 'x', v: 1 }, { name: 'x', v: 2 }]),
      remote: j([{ name: 'x', v: 1 }, { name: 'x', v: 3 }]),
    })
    expect(p.merge.kind).toBe('text')
    expect(p.merge.kind === 'text' && p.merge.unit).toBe('lines')
  })
})

describe('3-way pull: LFS, versions and the local basis', () => {
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n'

  it('a file in LFS is whole, and taking it asks the server for the content, never writes the pointer', () => {
    const [p] = prep({ path: 'data/big.csv', base: pointer, local: 'a,b\n', remote: pointer.replace('abc', 'def'), baseOid: 's1', localOid: 's1', remoteOid: 's2' })
    expect(p.merge.kind).toBe('whole')
    expect(overridesFor([p], decide([['data/big.csv', 'file', 'accept']]))).toEqual({ 'data/big.csv': { remote: true, localOid: 's1' } })
  })

  it('every override carries the local id its decision was computed on', () => {
    const [p] = prep({ path: 'a.md', base: 'x\n', local: 'x\n', remote: 'y\n', localOid: 'l1' })
    expect(overridesFor([p], decide([['a.md', 'file', 'accept']]))).toEqual({ 'a.md': { text: 'y\n', localOid: 'l1' } })
    const [absent] = prep({ path: 'b.md', base: null, local: null, remote: 'new\n', localOid: null })
    expect(overridesFor([absent], decide([['b.md', 'file', 'accept']]))['b.md'].localOid).toBeNull()
  })

  it('refuses a remote whose manifest needs a newer Linkr', () => {
    const remote = j({ name: 'B', minAppVersion: '999.0.0' })
    expect(() => prep({ path: 'projects/p/entity.json', base: j({ name: 'A' }), local: j({ name: 'A' }), remote }))
      .toThrow(PullAppTooOldError)
  })

  it('stamps the merged manifest with the higher minAppVersion of the two sides', () => {
    const [p] = prep({
      path: 'entity.json',
      base: j({ name: 'A', minAppVersion: '1.0.0' }),
      local: j({ name: 'A', minAppVersion: '1.0.0' }),
      remote: j({ name: 'B', minAppVersion: APP_VERSION }),
    })
    const text = (overridesFor([p], decide([['entity.json', 'field:name', 'accept']]))['entity.json'] as { text: string }).text
    expect(JSON.parse(text)).toEqual({ name: 'B', minAppVersion: APP_VERSION })
  })
})
