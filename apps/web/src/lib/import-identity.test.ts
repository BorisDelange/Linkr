import { describe, expect, it } from 'vitest'

import {
  type ImportTarget,
  entityKey,
  findLineageMatch,
  resolveByLineage,
  resolveChildId,
  resolveSlugLanding,
  resolveWorkspaceId,
} from '@/lib/import-identity'

/** Deterministic ids, so a test can tell a minted key from a reused one. */
function counter(prefix = 'minted') {
  let n = 0
  return () => `${prefix}-${++n}`
}

const WS = 'ws-1'

describe('resolveByLineage', () => {
  it('overwrites the row it wrote last time, matched on lineage', () => {
    // The whole point of the lineage switch: a re-export/re-import of the same
    // published entity must land on the same row rather than pile up copies.
    const rows: ImportTarget[] = [{ id: 'local-abc', lineageId: 'lin-1', workspaceId: WS }]
    const r = resolveByLineage(rows, { id: 'whatever', lineageId: 'lin-1' }, WS, false, counter())
    expect(r).toEqual({ id: 'local-abc', replaces: 'local-abc' })
  })

  it('ignores the candidate id entirely when matching', () => {
    // Exports no longer carry `id`; matching on it would never hit and every
    // round trip would duplicate. The stored id and the candidate id differ here
    // on purpose — lineage is the only thing that may decide.
    const rows: ImportTarget[] = [{ id: 'local-abc', lineageId: 'lin-1', workspaceId: WS }]
    const r = resolveByLineage(rows, { id: 'local-abc', lineageId: 'lin-other' }, WS, false, counter())
    expect(r).toEqual({ id: 'minted-1', replaces: null })
  })

  it('mints for a candidate with no lineage rather than guessing', () => {
    const rows: ImportTarget[] = [{ id: 'local-abc', lineageId: 'lin-1', workspaceId: WS }]
    const r = resolveByLineage(rows, { id: 'local-abc' }, WS, false, counter())
    expect(r).toEqual({ id: 'minted-1', replaces: null })
  })

  it('never matches a row in another workspace', () => {
    // Overwriting across this boundary would silently move another workspace's
    // entity into this one.
    const rows: ImportTarget[] = [{ id: 'local-abc', lineageId: 'lin-1', workspaceId: 'ws-other' }]
    const r = resolveByLineage(rows, { lineageId: 'lin-1' }, WS, false, counter())
    expect(r).toEqual({ id: 'minted-1', replaces: null })
  })

  it('always mints on a duplicate, even with a lineage match available', () => {
    const rows: ImportTarget[] = [{ id: 'local-abc', lineageId: 'lin-1', workspaceId: WS }]
    const r = resolveByLineage(rows, { lineageId: 'lin-1' }, WS, true, counter())
    expect(r).toEqual({ id: 'minted-1', replaces: null })
  })

  it('reports replaces so the caller clears the old row, not a fresh insert', () => {
    // Callers branch on `replaces` to delete children before re-creating. A null
    // here on a real overwrite would orphan them.
    const rows: ImportTarget[] = [{ id: 'local-abc', lineageId: 'lin-1', workspaceId: WS }]
    const r = resolveByLineage(rows, { lineageId: 'lin-1' }, WS, false, counter())
    expect(r.replaces).toBe('local-abc')
    expect(r.replaces).toBe(r.id)
  })

  it('mints a distinct id per call when nothing matches', () => {
    const mint = counter()
    const a = resolveByLineage([], { lineageId: 'lin-1' }, WS, false, mint)
    const b = resolveByLineage([], { lineageId: 'lin-2' }, WS, false, mint)
    expect(a.id).not.toBe(b.id)
  })

  it('is not confused by a row whose lineage is undefined', () => {
    // `undefined === undefined` would make a lineage-less row match a
    // lineage-less candidate; the candidate check must short-circuit first.
    const rows: ImportTarget[] = [{ id: 'local-abc', workspaceId: WS }]
    const r = resolveByLineage(rows, {}, WS, false, counter())
    expect(r).toEqual({ id: 'minted-1', replaces: null })
  })
})

describe('findLineageMatch', () => {
  it('finds the row a re-import would overwrite, so the caller can prompt first', () => {
    const rows: ImportTarget[] = [{ id: 'local-abc', lineageId: 'lin-1', workspaceId: WS }]
    expect(findLineageMatch(rows, { lineageId: 'lin-1' }, WS)?.id).toBe('local-abc')
  })

  it('agrees with resolveByLineage — a match here is the row that gets replaced', () => {
    // The prompt and the write must not disagree: offering "overwrite" and then
    // landing on a different row (or a fresh one) is the bug this pair prevents.
    const rows: ImportTarget[] = [{ id: 'local-abc', lineageId: 'lin-1', workspaceId: WS }]
    const candidate = { lineageId: 'lin-1' }
    expect(findLineageMatch(rows, candidate, WS)?.id)
      .toBe(resolveByLineage(rows, candidate, WS, false, counter()).replaces)
  })

  it('ignores the candidate id, like the resolver', () => {
    // Exports carry no `id`; a match must never hinge on one.
    const rows: ImportTarget[] = [{ id: 'local-abc', lineageId: 'lin-1', workspaceId: WS }]
    expect(findLineageMatch(rows, { id: 'local-abc', lineageId: 'lin-other' }, WS)).toBeUndefined()
  })

  it('never matches across workspaces', () => {
    const rows: ImportTarget[] = [{ id: 'local-abc', lineageId: 'lin-1', workspaceId: 'ws-other' }]
    expect(findLineageMatch(rows, { lineageId: 'lin-1' }, WS)).toBeUndefined()
  })

  it('is not confused by a row whose lineage is undefined', () => {
    const rows: ImportTarget[] = [{ id: 'local-abc', workspaceId: WS }]
    expect(findLineageMatch(rows, {}, WS)).toBeUndefined()
  })
})

describe('resolveWorkspaceId', () => {
  it('updates the existing workspace in place on a lineage match', () => {
    const rows: ImportTarget[] = [{ id: 'ws-stored', lineageId: 'lin-ws' }]
    const r = resolveWorkspaceId(rows, { id: 'ws-minted', lineageId: 'lin-ws' }, false, counter())
    expect(r).toEqual({ id: 'ws-stored', replaces: 'ws-stored' })
  })

  it('uses the parsed id when no stored workspace shares the lineage', () => {
    // parseWorkspaceZip mints this when the manifest carries none, so it is
    // always a usable key.
    const r = resolveWorkspaceId([], { id: 'ws-minted', lineageId: 'lin-ws' }, false, counter())
    expect(r).toEqual({ id: 'ws-minted', replaces: null })
  })

  it('mints a fresh workspace on a duplicate', () => {
    const rows: ImportTarget[] = [{ id: 'ws-stored', lineageId: 'lin-ws' }]
    const r = resolveWorkspaceId(rows, { id: 'ws-minted', lineageId: 'lin-ws' }, true, counter())
    expect(r).toEqual({ id: 'minted-1', replaces: null })
  })

  it('does not match a stored workspace that has no lineage', () => {
    const rows: ImportTarget[] = [{ id: 'ws-stored' }]
    const r = resolveWorkspaceId(rows, { id: 'ws-minted' }, false, counter())
    expect(r).toEqual({ id: 'ws-minted', replaces: null })
  })
})

describe('resolveChildId', () => {
  it('keeps the id so a git round trip overwrites in place', () => {
    const id = resolveChildId({ workspaceId: WS }, 'child-1', WS, false, counter())
    expect(id).toBe('child-1')
  })

  it('keeps the id when nothing is stored under it yet', () => {
    const id = resolveChildId(undefined, 'child-1', WS, false, counter())
    expect(id).toBe('child-1')
  })

  it('mints when the id belongs to another workspace, avoiding a silent clobber', () => {
    // Without this the delete-then-create would drag that workspace's child here.
    const id = resolveChildId({ workspaceId: 'ws-other' }, 'child-1', WS, false, counter())
    expect(id).toBe('minted-1')
  })

  it('always mints on a duplicate', () => {
    const id = resolveChildId({ workspaceId: WS }, 'child-1', WS, true, counter())
    expect(id).toBe('minted-1')
  })
})

describe('resolveSlugLanding', () => {
  it('takes the slug when nothing holds it', () => {
    expect(resolveSlugLanding('mimic-iv-demo', null, WS, counter())).toBe('mimic-iv-demo')
  })

  it('reuses the row this workspace already has under that slug', () => {
    // A re-import updates in place rather than piling up a second copy.
    const id = resolveSlugLanding('mimic-iv-demo', { workspaceId: WS }, WS, counter())
    expect(id).toBe('mimic-iv-demo')
  })

  it('mints when another workspace holds the slug', () => {
    // entityId is unique only WITHIN a workspace: two workspaces may each publish
    // a `mimic-iv-demo`, and taking the key would overwrite the other one's.
    const id = resolveSlugLanding('mimic-iv-demo', { workspaceId: 'ws-2' }, WS, counter())
    expect(id).toBe('minted-1')
  })

  it('mints when the holder belongs to no workspace at all', () => {
    const id = resolveSlugLanding('mimic-iv-demo', { workspaceId: undefined }, WS, counter())
    expect(id).toBe('minted-1')
  })
})

describe('entityKey', () => {
  // The case that was silently dropping entities: a published repo carries a slug
  // and a lineage, never a primary key.
  it('falls back to the slug when the export carries no primary key', () => {
    expect(entityKey({ entityId: 'icu-demo' }, 'projects-folder')).toBe('icu-demo')
  })

  it('falls back to the folder when the tree has neither', () => {
    expect(entityKey({}, 'icu-demo')).toBe('icu-demo')
    expect(entityKey(null, 'icu-demo')).toBe('icu-demo')
    expect(entityKey(undefined, 'icu-demo')).toBe('icu-demo')
  })

  // A hand-written tree (the old seed) did carry one; keeping it first means this
  // changes nothing for those.
  it('prefers a primary key when the tree still has one', () => {
    expect(entityKey({ uid: 'uid-1', entityId: 'slug' }, 'folder')).toBe('uid-1')
    expect(entityKey({ id: 'id-1', entityId: 'slug' }, 'folder')).toBe('id-1')
  })

  it('is stable — the same tree always yields the same key', () => {
    const meta = { entityId: 'icu-demo' }
    expect(entityKey(meta, 'f')).toBe(entityKey(meta, 'f'))
  })
})
