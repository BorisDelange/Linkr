import { describe, it, expect } from 'vitest'
import {
  fromPathTree, isReservedTreeName, readPathTree, rederiveTreeIds, reservedTreeNameReason,
  storablePathNode, toPathTree, treeNodePath,
} from './entity-tree'

/** A stored SQL-collection tree: sofa/ { sofa.sql }, top.sql. */
const NODES = [
  { id: 'f-folder', collectionId: 'col-1', name: 'sofa', type: 'folder' as const, parentId: null, order: 1, createdAt: 'T0' },
  { id: 'f-nested', collectionId: 'col-1', name: 'sofa.sql', type: 'file' as const, parentId: 'f-folder', content: 'select 1', order: 2, createdAt: 'T0' },
  { id: 'f-top', collectionId: 'col-1', name: 'top.sql', type: 'file' as const, parentId: null, content: 'select 2', order: 0, createdAt: 'T0' },
]

describe('treeNodePath', () => {
  it('walks parentId up to the root', () => {
    const byId = new Map(NODES.map((n) => [n.id, n]))
    expect(treeNodePath(NODES[1], byId)).toBe('sofa/sofa.sql')
    expect(treeNodePath(NODES[2], byId)).toBe('top.sql')
  })

  it('stops on a dangling or cyclic parent instead of looping forever', () => {
    const orphan = { id: 'x', name: 'x.sql', type: 'file' as const, parentId: 'gone' }
    expect(treeNodePath(orphan, new Map([[orphan.id, orphan]]))).toBe('x.sql')
    const a = { id: 'a', name: 'a', type: 'folder' as const, parentId: 'b' }
    const b = { id: 'b', name: 'b', type: 'folder' as const, parentId: 'a' }
    const cyclic = new Map([[a.id, a], [b.id, b]])
    expect(treeNodePath(a, cyclic)).toBe('b/a')
  })
})

describe('toPathTree', () => {
  it('replaces id/parentId/name/fk/content with a path, sorted by path', () => {
    const out = toPathTree(NODES, 'collectionId')
    expect(out).toEqual([
      { path: 'sofa', type: 'folder', order: 1, createdAt: 'T0' },
      { path: 'sofa/sofa.sql', type: 'file', order: 2, createdAt: 'T0' },
      { path: 'top.sql', type: 'file', order: 0, createdAt: 'T0' },
    ])
  })

  it('sorts by path so the bytes do not depend on the row order', () => {
    const shuffled = [NODES[2], NODES[1], NODES[0]]
    expect(toPathTree(shuffled, 'collectionId')).toEqual(toPathTree(NODES, 'collectionId'))
  })

  it('orders astral filenames by UTF-16 code unit (the server twin must match)', () => {
    // JS `<`/`>` compares UTF-16 code units, Python compares code points, and they
    // diverge above the BMP — so the server sorts on .encode('utf-16-be'). Pinned on
    // both sides: see test_workspace_export_pointer.py.
    const nodes = [
      { id: 'a', collectionId: 'c', name: '�.sql', type: 'file' as const, parentId: null },
      { id: 'b', collectionId: 'c', name: '\u{1F600}.sql', type: 'file' as const, parentId: null },
      { id: 'c', collectionId: 'c', name: 'a.sql', type: 'file' as const, parentId: null },
    ]
    expect(toPathTree(nodes, 'collectionId').map((n) => n.path)).toEqual([
      'a.sql', '\u{1F600}.sql', '�.sql',
    ])
  })
})

describe('fromPathTree', () => {
  const TREE = toPathTree(NODES, 'collectionId') as unknown as Parameters<typeof fromPathTree>[0]

  it('rebuilds names, parent links and the owning FK from paths', () => {
    const out = fromPathTree<Record<string, unknown>>(TREE, 'target', 'collectionId')
    expect(out.map((n) => n.name)).toEqual(['sofa', 'top.sql', 'sofa.sql'])
    const folder = out.find((n) => n.name === 'sofa')!
    const nested = out.find((n) => n.path === 'sofa/sofa.sql')!
    expect(nested.parentId).toBe(folder.id)
    expect(folder.parentId).toBeNull()
    expect(out.every((n) => n.collectionId === 'target')).toBe(true)
  })

  it('emits parents before their children', () => {
    const out = fromPathTree<Record<string, unknown>>(TREE, 'target', 'collectionId')
    const idx = (p: string) => out.findIndex((n) => n.path === p)
    expect(idx('sofa')).toBeLessThan(idx('sofa/sofa.sql'))
  })

  it('is deterministic per owner and disjoint across owners', () => {
    const a = fromPathTree<Record<string, unknown>>(TREE, 'owner-a', 'collectionId')
    const again = fromPathTree<Record<string, unknown>>(TREE, 'owner-a', 'collectionId')
    const b = fromPathTree<Record<string, unknown>>(TREE, 'owner-b', 'collectionId')
    expect(again.map((n) => n.id)).toEqual(a.map((n) => n.id))
    const ids = new Set(a.map((n) => n.id))
    expect(b.every((n) => !ids.has(n.id as string))).toBe(true)
  })

  it('synthesizes a folder implied by a path but absent from the tree', () => {
    // A hand-authored repo: a .sql dropped into a new subfolder, no folder entry.
    const out = fromPathTree<Record<string, unknown>>(
      [{ path: 'new/dir/query.sql', type: 'file' }],
      'target',
      'collectionId',
    )
    expect(out.map((n) => n.path)).toEqual(['new', 'new/dir', 'new/dir/query.sql'])
    expect(out[0].type).toBe('folder')
    expect(out[2].parentId).toBe(out[1].id)
  })

  it('skips entries with no usable path', () => {
    const out = fromPathTree<Record<string, unknown>>(
      [{ path: '', type: 'file' }, { path: 'ok.sql', type: 'file' }] as never,
      'target',
      'collectionId',
    )
    expect(out.map((n) => n.path)).toEqual(['ok.sql'])
  })
})

describe('readPathTree', () => {
  it('passes a path-keyed tree through unchanged', () => {
    const tree = [{ path: 'a.sql', type: 'file' as const }]
    expect(readPathTree(tree)).toEqual(tree)
  })

  it('rebuilds paths from a legacy id/parentId tree', () => {
    expect(readPathTree(NODES.map(({ content: _c, ...n }) => n))).toEqual([
      { collectionId: 'col-1', path: 'sofa', type: 'folder', order: 1, createdAt: 'T0' },
      { collectionId: 'col-1', path: 'sofa/sofa.sql', type: 'file', order: 2, createdAt: 'T0' },
      { collectionId: 'col-1', path: 'top.sql', type: 'file', order: 0, createdAt: 'T0' },
    ])
  })

  it('keeps inline content from the oldest files.json layout', () => {
    // That layout carried content INLINE with no raw .sql entry in the ZIP, so
    // dropping it here imported every script empty.
    const tree = readPathTree(NODES)
    expect(tree.find((n) => n.path === 'sofa/sofa.sql')).toMatchObject({ content: 'select 1' })
    expect(tree.find((n) => n.path === 'top.sql')).toMatchObject({ content: 'select 2' })
  })

  it('returns [] for a missing or non-array tree', () => {
    expect(readPathTree(undefined)).toEqual([])
    expect(readPathTree({ nope: true })).toEqual([])
  })
})

describe('rederiveTreeIds', () => {
  it('re-namespaces ids to a new owner while preserving the tree and content', () => {
    const built = fromPathTree<Record<string, unknown>>(
      toPathTree(NODES, 'collectionId') as never, 'owner-a', 'collectionId',
    ).map((n) => {
      const node = storablePathNode(n)
      if (node.name === 'sofa.sql') node.content = 'select 1'
      return node
    }) as never as Parameters<typeof rederiveTreeIds>[0]

    const moved = rederiveTreeIds(built, 'owner-a', 'owner-b', 'collectionId')
    const expected = fromPathTree<Record<string, unknown>>(
      toPathTree(NODES, 'collectionId') as never, 'owner-b', 'collectionId',
    )
    expect(moved.map((n) => n.id).sort()).toEqual(expected.map((n) => n.id).sort())
    const nested = moved.find((n) => n.name === 'sofa.sql')!
    const folder = moved.find((n) => n.name === 'sofa')!
    expect(nested.parentId).toBe(folder.id)
    expect(nested.content).toBe('select 1')
  })

  it('is a no-op when the owner is unchanged', () => {
    const nodes = [{ id: 'a', name: 'a.sql', type: 'file' as const, parentId: null }]
    expect(rederiveTreeIds(nodes, 'same', 'same', 'collectionId')).toBe(nodes)
  })
})

describe('isReservedTreeName', () => {
  it('reserves the names the export writes at the entity root', () => {
    for (const name of ['README.md', 'readme.md', 'README.fr.md', 'LICENSE.md', 'license.md', 'attachments']) {
      expect(isReservedTreeName(name, null)).toBe(true)
    }
  })

  it('reserves the licence spellings a user actually types, not just LICENSE.md', () => {
    // Only `LICENSE.md` was refused, so these were accepted as ordinary files.
    // `LICENSE` with no extension is the canonical name GitHub and GitLab render,
    // so a file of that name reads as the entity's licence while the real one lives
    // on the entity — quietly wrong rather than loudly broken.
    for (const name of [
      'LICENSE', 'LICENCE', 'licence.md', 'LICENSE.txt', 'licence.txt', 'COPYING', 'copying',
    ]) {
      expect(isReservedTreeName(name, null), name).toBe(true)
    }
  })

  it('allows them inside a folder, where nothing is emitted', () => {
    for (const name of ['README.md', 'LICENSE.md', 'LICENSE', 'LICENCE.md', 'attachments']) {
      expect(isReservedTreeName(name, 'folder-id'), name).toBe(false)
    }
  })

  it('explains attachments as a folder, everything else as a file', () => {
    // ETL pipelines cannot create folders at all, so a message naming
    // "attachments/" there would describe something the user cannot do. Keyed off
    // the typed name rather than the caller's context.
    expect(reservedTreeNameReason('attachments')).toBe('files.name_reserved_attachments')
    expect(reservedTreeNameReason('  Attachments  ')).toBe('files.name_reserved_attachments')
    for (const name of ['README.md', 'LICENSE', 'LICENCE.md', 'COPYING']) {
      expect(reservedTreeNameReason(name), name).toBe('files.name_reserved')
    }
  })

  it('does not over-reach onto names that merely start with the word', () => {
    for (const name of [
      'licenses.md', 'license-notes.md', 'LICENSE.sql', 'copying-guide.md', 'my-LICENSE',
    ]) {
      expect(isReservedTreeName(name, null), name).toBe(false)
    }
  })

  it('leaves ordinary names alone', () => {
    for (const name of ['notes.md', 'readme_notes.md', 'my-README.md', 'licenses.md', 'attachment']) {
      expect(isReservedTreeName(name, null)).toBe(false)
    }
  })

  it('ignores surrounding whitespace', () => {
    expect(isReservedTreeName('  README.md  ', null)).toBe(true)
  })
})
