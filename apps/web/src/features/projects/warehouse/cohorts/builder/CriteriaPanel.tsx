import { useCallback } from 'react'
import { arrayMove } from '@dnd-kit/sortable'
import { CriteriaGroupNodeComponent } from './CriteriaGroupNodeComponent'
import type {
  CriteriaGroupNode,
  CriteriaTreeNode,
  CriterionNode,
  SchemaMapping,
} from '@/types'

interface CriteriaPanelProps {
  criteriaTree: CriteriaGroupNode
  onChange: (tree: CriteriaGroupNode) => void
  eventTableLabels: string[]
  genderValues?: SchemaMapping['genderValues']
}

// --- Immutable tree helpers ---

/**
 * Add a child node to the group identified by `parentId`.
 * Returns a new tree (immutable).
 */
function addNode(tree: CriteriaGroupNode, parentId: string, node: CriteriaTreeNode): CriteriaGroupNode {
  if (tree.id === parentId) {
    return { ...tree, children: [...tree.children, node] }
  }
  return {
    ...tree,
    children: tree.children.map((child) =>
      child.kind === 'group' ? addNode(child, parentId, node) : child,
    ),
  }
}

/**
 * Remove a node by id from anywhere in the tree.
 * Returns a new tree (immutable).
 */
function removeNode(tree: CriteriaGroupNode, nodeId: string): CriteriaGroupNode {
  return {
    ...tree,
    children: tree.children
      .filter((child) => child.id !== nodeId)
      .map((child) =>
        child.kind === 'group' ? removeNode(child, nodeId) : child,
      ),
  }
}

/**
 * Update a node's properties by id.
 * Handles both criterion nodes and group nodes.
 * Returns a new tree (immutable).
 */
function updateNode(
  tree: CriteriaGroupNode,
  nodeId: string,
  changes: Partial<CriteriaTreeNode>,
): CriteriaGroupNode {
  if (tree.id === nodeId) {
    return { ...tree, ...changes } as CriteriaGroupNode
  }
  return {
    ...tree,
    children: tree.children.map((child) => {
      if (child.id === nodeId) {
        return { ...child, ...changes } as CriteriaTreeNode
      }
      if (child.kind === 'group') {
        return updateNode(child, nodeId, changes)
      }
      return child
    }),
  }
}

/**
 * Move a child within a group from `fromIndex` to `toIndex`.
 * Returns a new tree (immutable).
 */
function moveNode(
  tree: CriteriaGroupNode,
  groupId: string,
  fromIndex: number,
  toIndex: number,
): CriteriaGroupNode {
  if (tree.id === groupId) {
    return { ...tree, children: arrayMove(tree.children, fromIndex, toIndex) }
  }
  return {
    ...tree,
    children: tree.children.map((child) =>
      child.kind === 'group' ? moveNode(child, groupId, fromIndex, toIndex) : child,
    ),
  }
}

export function CriteriaPanel({
  criteriaTree,
  onChange,
  eventTableLabels,
  genderValues,
}: CriteriaPanelProps) {
  const handleAddNode = useCallback(
    (parentId: string, node: CriteriaTreeNode) => {
      onChange(addNode(criteriaTree, parentId, node))
    },
    [criteriaTree, onChange],
  )

  const handleRemoveNode = useCallback(
    (nodeId: string) => {
      onChange(removeNode(criteriaTree, nodeId))
    },
    [criteriaTree, onChange],
  )

  const handleUpdateNode = useCallback(
    (nodeId: string, changes: Partial<CriteriaTreeNode>) => {
      onChange(updateNode(criteriaTree, nodeId, changes))
    },
    [criteriaTree, onChange],
  )

  const handleUpdateGroup = useCallback(
    (nodeId: string, changes: Partial<CriteriaGroupNode>) => {
      onChange(updateNode(criteriaTree, nodeId, changes) as CriteriaGroupNode)
    },
    [criteriaTree, onChange],
  )

  const handleMoveNode = useCallback(
    (groupId: string, fromIdx: number, toIdx: number) => {
      onChange(moveNode(criteriaTree, groupId, fromIdx, toIdx))
    },
    [criteriaTree, onChange],
  )

  return (
    <div className="space-y-2">
      <CriteriaGroupNodeComponent
        node={criteriaTree}
        depth={0}
        onUpdate={handleUpdateGroup}
        onRemove={handleRemoveNode}
        onAddNode={handleAddNode}
        onRemoveNode={handleRemoveNode}
        onUpdateNode={handleUpdateNode}
        onMoveNode={handleMoveNode}
        eventTableLabels={eventTableLabels}
        genderValues={genderValues}
      />
    </div>
  )
}
