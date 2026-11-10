import type { DqGroupNode } from '@/lib/dq-groups'
import type { FoldNode } from './use-fold-state'

/** Drag payloads: the ids of the checks dragged, or the key of a category. */
export const DRAG_CHECKS = 'application/x-linkr-dq-checks'
export const DRAG_GROUP = 'application/x-linkr-dq-group'

/** The fold key of a category (`''`: "Other checks") within a tree's `scope`. */
export const groupFoldKey = (scope: string, key: string) => `${scope}g:${key}`

/** The tree's categories level by level, top first, for `FoldLevelButton`. */
export function foldLevels<C>(roots: DqGroupNode<C>[], scope: string, parent?: string): FoldNode[][] {
  if (!roots.length) return []
  const here = roots.map((n) => ({ key: groupFoldKey(scope, n.key), ...(parent ? { parent } : {}) }))
  const below = roots.map((n) => foldLevels(n.children, scope, groupFoldKey(scope, n.key)))
  const depth = Math.max(0, ...below.map((l) => l.length))
  return [here, ...Array.from({ length: depth }, (_, i) => below.flatMap((l) => l[i] ?? []))]
}
