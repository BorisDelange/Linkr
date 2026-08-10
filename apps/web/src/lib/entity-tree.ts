/**
 * The versioned form of a file tree: SQL collections, ETL pipelines and a
 * project's IDE scripts (`scripts/_tree.json`).
 *
 * `_tree.json` describes the tree by PATH, not by id: a node's identity in the
 * repo is where it sits (`sofa/sofa-duckdb.sql`), which is exactly what git
 * already versions. Carrying the local `id`/`parentId`/owner FK too meant a
 * second, instance-local identity in the file — and every import re-minted it,
 * churning the diff on each round-trip. Same reasoning as the dataset column
 * ids (`col_<slug>`) and the dashboard/tab/widget content keys.
 *
 * Local ids are derived back from the path at import:
 * `deterministicId(<owner id>, path)`. Same repo into the same owner → same ids
 * (idempotent re-import), while the owner id in the hash keeps two clones of one
 * repo distinct. Renaming a folder therefore re-mints its subtree's ids, which is
 * harmless for these three: nothing outside the tree references a script file's
 * id (`parentId` is internal). That's exactly why `datasets/_tree.json` is NOT
 * modelled here — widgets and filters point at dataset and column ids, so those
 * keep a name-derived key instead.
 */
import { deterministicId } from '@/lib/deterministic-id'

/** The instance-local foreign key a tree's nodes carry back to their owner. */
export type TreeFkKey = 'collectionId' | 'pipelineId' | 'projectUid'

/** A node as stored locally: identity by id, hierarchy by parentId. */
export interface TreeNode {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  content?: string
}

/** A node as versioned: identity and hierarchy both carried by `path`. */
export interface PathNode {
  path: string
  type: 'file' | 'folder'
}

/**
 * Whether a name is reserved at this position in a versioned tree.
 *
 * An entity's export writes README.md (plus README.<lang>.md), LICENSE.md and an
 * attachments/ folder at the root of its folder, from fields on the entity itself.
 * A user node of the same name at the tree root would collide there, so the name
 * is refused — inside a subfolder it is harmless.
 *
 * The license spellings go WIDER than the one the export writes. `LICENSE.md` was
 * the only one refused, so `LICENSE` (no extension — the canonical name GitHub and
 * GitLab render), the British `LICENCE`, and `LICENSE.txt` were all accepted as
 * ordinary files. They are not destroyed on import the way a `LICENSE.md` clash
 * would be, which is worse in a quiet way: the file sits in the repo looking like
 * the entity's licence while the real one lives on the entity and overwrites
 * nothing. Reserving them sends the user to the licence field instead.
 */
const RESERVED_LICENSE_NAMES = new Set([
  'license',
  'license.md',
  'license.txt',
  'licence',
  'licence.md',
  'licence.txt',
  'copying',
])

export function isReservedTreeName(name: string, parentId: string | null): boolean {
  if (parentId !== null) return false
  const n = name.trim().toLowerCase()
  return (
    n === 'attachments'
    || RESERVED_LICENSE_NAMES.has(n)
    || /^readme(\.[a-z-]+)?\.md$/.test(n)
  )
}

/** Full path of a stored node, walking parentId up to the root. */
export function treeNodePath(node: TreeNode, byId: Map<string, TreeNode>): string {
  const parts: string[] = [node.name]
  const seen = new Set<string>([node.id])
  let current = node
  while (current.parentId) {
    const parent = byId.get(current.parentId)
    // Stop on a dangling or cyclic parent rather than looping forever — a
    // malformed tree must still yield a usable (if shallower) path.
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    parts.unshift(parent.name)
    current = parent
  }
  return parts.join('/')
}

/**
 * Rewrite stored nodes into their versioned form: `path` replaces
 * `id`/`parentId`/`name`, and the instance-local FK (`collectionId`/`pipelineId`)
 * and `content` are dropped — content lives in the real file next to the tree.
 * Sorted by path so the array order (hence the bytes) never depends on the
 * DB's insertion order, which `list_files` doesn't constrain.
 */
export function toPathTree<T extends TreeNode>(
  nodes: T[],
  fkKey: TreeFkKey,
): Record<string, unknown>[] {
  const byId = new Map<string, TreeNode>(nodes.map((n) => [n.id, n]))
  return nodes
    .map((node) => {
      const {
        id: _id,
        parentId: _parentId,
        name: _name,
        content: _content,
        [fkKey]: _fk,
        ...rest
      } = node as T & Record<string, unknown>
      return { path: treeNodePath(node, byId), ...rest }
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The parent directory of a path, or '' at the root. */
function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** The last segment of a path. */
function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/**
 * Rebuild storable nodes from a versioned `_tree.json`, deriving each id from
 * (`ownerId`, path). `ownerId` is the LOCAL collection/pipeline id, so the same
 * repo cloned twice on one instance yields two distinct id sets.
 *
 * Parents are emitted before their children, so an insert loop can rely on the
 * array order when a storage backend requires the parent row to exist first.
 * A folder implied by a file's path but missing from the tree is synthesized,
 * so a hand-authored repo (a `.sql` dropped into a new subfolder, with no
 * `_tree.json` entry for it) imports correctly.
 *
 * Each record keeps its `path` so a caller can fetch the file's content from the
 * ZIP/repo afterwards; strip it before persisting (`storablePathNode`).
 */
// `object`, not `Record<string, unknown>`: a named interface has no index
// signature, so it cannot satisfy the Record constraint. The bodies index through
// an explicit cast anyway.
export function fromPathTree<T extends object>(
  tree: PathNode[],
  ownerId: string,
  fkKey: TreeFkKey,
): T[] {
  const idFor = (path: string) => deterministicId(ownerId, path)
  const byPath = new Map<string, PathNode & Record<string, unknown>>()
  for (const node of tree) {
    if (typeof node?.path !== 'string' || !node.path) continue
    byPath.set(node.path, node as PathNode & Record<string, unknown>)
  }
  // Synthesize the folders a path implies but the tree omits.
  for (const path of [...byPath.keys()]) {
    for (let dir = dirname(path); dir; dir = dirname(dir)) {
      if (!byPath.has(dir)) byPath.set(dir, { path: dir, type: 'folder' })
    }
  }
  // Shallower paths first so a parent always precedes its children.
  const ordered = [...byPath.values()].sort((a, b) => {
    const depth = a.path.split('/').length - b.path.split('/').length
    return depth !== 0 ? depth : a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
  return ordered.map((node) => {
    const parentDir = dirname(node.path)
    return {
      ...node,
      id: idFor(node.path),
      name: basename(node.path),
      parentId: parentDir ? idFor(parentDir) : null,
      [fkKey]: ownerId,
    } as unknown as T
  })
}

/** Drop the transport-only `path` before persisting a node built by fromPathTree. */
export function storablePathNode<T extends object>(record: T): T {
  const { path: _path, ...rest } = record as T & Record<string, unknown>
  return rest as unknown as T
}

/**
 * Re-derive ids for nodes already built under `fromOwnerId` so they belong to
 * `toOwnerId` instead — used when an import re-mints the parent collection /
 * pipeline id (a duplicate, or a cross-workspace id collision) after the tree
 * was parsed. Paths are recovered from the node hierarchy, so the result is
 * identical to having parsed with the target id from the start.
 */
export function rederiveTreeIds<T extends TreeNode>(
  nodes: T[],
  fromOwnerId: string,
  toOwnerId: string,
  fkKey: TreeFkKey,
): T[] {
  if (fromOwnerId === toOwnerId) return nodes
  const byId = new Map<string, TreeNode>(nodes.map((n) => [n.id, n]))
  const contentByPath = new Map<string, string | undefined>()
  const paths = nodes.map((n) => {
    const path = treeNodePath(n, byId)
    contentByPath.set(path, n.content)
    return { ...(n as Record<string, unknown>), path, type: n.type } as unknown as PathNode
  })
  return fromPathTree<T & { path: string }>(paths, toOwnerId, fkKey).map((rec) => {
    const content = contentByPath.get(rec.path)
    const node = storablePathNode(rec) as T
    if (content !== undefined) (node as Record<string, unknown>).content = content
    return node
  })
}

/**
 * Read a `_tree.json` array in either form. A legacy export carries
 * `id`/`name`/`parentId` and no `path`; rebuild the path from the hierarchy so
 * repos pushed before the format change still import. Nodes are returned in the
 * input order; `fromPathTree` re-sorts them anyway.
 */
export function readPathTree(raw: unknown): PathNode[] {
  if (!Array.isArray(raw)) return []
  const nodes = raw.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
  if (nodes.every((n) => typeof n.path === 'string')) return nodes as unknown as PathNode[]
  const legacy = nodes as unknown as TreeNode[]
  const byId = new Map<string, TreeNode>(legacy.map((n) => [n.id, n]))
  return legacy
    .filter((n) => typeof n?.name === 'string')
    .map((n) => {
      // Keep `content`: the oldest layout (collection.json + files.json) carried it
      // INLINE with no raw file in the ZIP, so dropping it here imports every script
      // empty. reconstructTreeFiles only overwrites it when a raw entry exists.
      const { id: _id, parentId: _p, name: _n, ...rest } = n as TreeNode & Record<string, unknown>
      return { ...rest, path: treeNodePath(n, byId), type: n.type } as PathNode
    })
}
