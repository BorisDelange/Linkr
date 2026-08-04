import { describe, it, expect } from 'vitest'
import {
  fromPathTree, readPathTree, rederiveTreeIds, storablePathNode, toPathTree, treeNodePath,
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
