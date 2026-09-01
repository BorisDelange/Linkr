import { describe, expect, it } from 'vitest'

import {
  type ImportTarget,
  buildPointer,
  entityKey,
  findLineageMatch,
  resolveByLineage,
  resolveChildId,
  resolvePointer,
  resolveProjectPointers,
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

describe('buildPointer', () => {
  const rows = [
    { id: 'local-1', entityId: 'mimic-iv', lineageId: 'lin-1', workspaceId: WS, name: { en: 'MIMIC-IV' } },
  ]

  it('carries the identity that survives, not the local key', () => {
    expect(buildPointer(rows, 'local-1')).toEqual({
      lineageId: 'lin-1', entityId: 'mimic-iv', label: { en: 'MIMIC-IV' },
    })
  })

  it('yields nothing for a reference that points at nothing', () => {
    expect(buildPointer(rows, undefined)).toBeUndefined()
    expect(buildPointer(rows, '')).toBeUndefined()
    // A database deleted since it was picked: better no pointer than a wrong one.
    expect(buildPointer(rows, 'local-gone')).toBeUndefined()
  })

  it('yields nothing for a row with no portable identity at all', () => {
    expect(buildPointer([{ id: 'local-2', workspaceId: WS }], 'local-2')).toBeUndefined()
  })
})

describe('resolvePointer', () => {
  const rows = [
    { id: 'local-1', entityId: 'mimic-iv', lineageId: 'lin-1', workspaceId: WS },
    { id: 'local-2', entityId: 'eicu', lineageId: 'lin-2', workspaceId: WS },
  ]

  // The bug this exists for: a mapping project's dataSourceId is a UUID from the
  // exporting instance, so a re-import left every database-source project blank.
  it('finds the database the export was written against, by lineage', () => {
    expect(resolvePointer(rows, { lineageId: 'lin-2' }, WS)?.id).toBe('local-2')
  })

  it('prefers lineage over the slug when both are present', () => {
    // The slug says one row, the lineage another — lineage is the real identity.
    expect(resolvePointer(rows, { lineageId: 'lin-1', entityId: 'eicu' }, WS)?.id).toBe('local-1')
  })

  it('falls back to the slug for a row exported before lineage existed', () => {
    expect(resolvePointer(rows, { entityId: 'eicu' }, WS)?.id).toBe('local-2')
  })

  it('refuses an ambiguous slug rather than picking one', () => {
    // A slug is unique within a workspace, but nothing stops two rows sharing one
    // in a malformed store; guessing would silently wire up the wrong database.
    const dupes = [
      { id: 'a', entityId: 'mimic-iv', workspaceId: WS },
      { id: 'b', entityId: 'mimic-iv', workspaceId: WS },
    ]
    expect(resolvePointer(dupes, { entityId: 'mimic-iv' }, WS)).toBeUndefined()
  })

  it('never reaches into another workspace', () => {
    // The boundary every other import rule enforces: matching across it would
    // point this workspace's project at a database it may not even be allowed to read.
    expect(resolvePointer(rows, { lineageId: 'lin-1' }, 'ws-other')).toBeUndefined()
    expect(resolvePointer(rows, { entityId: 'mimic-iv' }, 'ws-other')).toBeUndefined()
  })

  it('yields nothing when the target is not installed here', () => {
    // A normal outcome, not an error: the caller leaves the project sourceless
    // and the user picks a database, rather than keeping a dangling id.
    expect(resolvePointer(rows, { lineageId: 'lin-absent' }, WS)).toBeUndefined()
    expect(resolvePointer(rows, undefined, WS)).toBeUndefined()
    expect(resolvePointer(rows, {}, WS)).toBeUndefined()
  })
})

describe('resolveProjectPointers', () => {
  const rows = [
    { id: 'local-1', entityId: 'mimic-iv-demo', lineageId: 'lin-1', workspaceId: WS },
    { id: 'local-2', entityId: 'mimic-iv-demo-omop', lineageId: 'lin-2', workspaceId: WS },
  ]

  // The bug this exists for: an entity.json accumulated the same pointer three
  // times, each import resolved all three to one database, and writing the
  // manifest's own list back out handed the repeats to the next export.
  it('keeps one entry per database, however often it is pointed at', () => {
    const { ids, refs } = resolveProjectPointers(rows, [
      { lineageId: 'lin-1' },
      { lineageId: 'lin-2' },
      { lineageId: 'lin-1' },
      { lineageId: 'lin-1' },
    ], WS)
    expect(ids).toEqual(['local-1', 'local-2'])
    expect(refs).toEqual([{ lineageId: 'lin-1' }, { lineageId: 'lin-2' }])
  })

  it('deduplicates on the resolved database, not on the pointer', () => {
    // A lineage and a slug are different pointers naming the same row; keeping
    // both would list that database twice.
    const { ids } = resolveProjectPointers(rows, [
      { lineageId: 'lin-1' },
      { entityId: 'mimic-iv-demo' },
    ], WS)
    expect(ids).toEqual(['local-1'])
  })

  it('drops a pointer to a database this instance does not have', () => {
    // What the project stores has to match what its Databases page shows: an
    // unresolvable pointer is a link the page never displayed.
    const { ids, refs } = resolveProjectPointers(rows, [
      { lineageId: 'lin-absent' },
      { lineageId: 'lin-2' },
    ], WS)
    expect(ids).toEqual(['local-2'])
    expect(refs).toEqual([{ lineageId: 'lin-2' }])
  })

  it('keeps ids and pointers index-aligned', () => {
    // The invariant linkDataSource/unlinkDataSource maintain: refs[i] is the
    // portable pointer for ids[i], so unlinking one never shifts another's.
    const { ids, refs } = resolveProjectPointers(rows, [
      { lineageId: 'lin-2' },
      { lineageId: 'lin-absent' },
      { lineageId: 'lin-1' },
    ], WS)
    expect(ids).toEqual(['local-2', 'local-1'])
    expect(refs).toEqual([{ lineageId: 'lin-2' }, { lineageId: 'lin-1' }])
    expect(refs).toHaveLength(ids.length)
  })

  it('returns nothing for a project with no pointers', () => {
    expect(resolveProjectPointers(rows, undefined, WS)).toEqual({ ids: [], refs: [] })
    expect(resolveProjectPointers(rows, [], WS)).toEqual({ ids: [], refs: [] })
  })

  it('never reaches into another workspace', () => {
    expect(resolveProjectPointers(rows, [{ lineageId: 'lin-1' }], 'ws-other'))
      .toEqual({ ids: [], refs: [] })
  })
})
