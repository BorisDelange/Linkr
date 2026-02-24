import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { arrayMove } from '@dnd-kit/sortable'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CriteriaGroupNodeComponent } from './CriteriaGroupNodeComponent'
import { CriterionCard } from './CriterionCard'
import { AddCriterionMenu } from './AddCriterionMenu'
import { OperatorSeparator } from './OperatorSeparator'
import type {
  CriteriaGroupNode,
  CriteriaTreeNode,
  CriterionNode,
  CriteriaType,
  CriteriaConfig,
  SchemaMapping,
} from '@/types'

interface CriteriaPanelProps {
  criteriaTree: CriteriaGroupNode
  onChange: (tree: CriteriaGroupNode) => void
  eventTableLabels: string[]
  genderValues?: SchemaMapping['genderValues']
  visitDateRange?: { minDate: string; maxDate: string }
  dataSourceId?: string
  schemaMapping?: SchemaMapping
}

// --- Immutable tree helpers ---

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
  visitDateRange,
  dataSourceId,
  schemaMapping,
}: CriteriaPanelProps) {
  const { t } = useTranslation()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

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

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const fromIdx = criteriaTree.children.findIndex((c) => c.id === active.id)
    const toIdx = criteriaTree.children.findIndex((c) => c.id === over.id)
    if (fromIdx === -1 || toIdx === -1) return
    handleMoveNode(criteriaTree.id, fromIdx, toIdx)
  }

  const handleToggleOperator = (nodeId: string) => {
    const node = criteriaTree.children.find((c) => c.id === nodeId)
    if (!node) return
    handleUpdateNode(nodeId, {
      operator: node.operator === 'AND' ? 'OR' : 'AND',
    })
  }

  const handleAddCriterion = (type: CriteriaType) => {
    let config = getDefaultConfig(type)
    if (type === 'period' && visitDateRange) {
      config = { startDate: visitDateRange.minDate, endDate: visitDateRange.maxDate }
    }
    const newNode: CriterionNode = {
      kind: 'criterion',
      id: crypto.randomUUID(),
      type,
      config,
      operator: 'AND',
      exclude: false,
      enabled: true,
    }
    handleAddNode(criteriaTree.id, newNode)
  }

  const handleAddGroup = () => {
    const newGroup: CriteriaGroupNode = {
      kind: 'group',
      id: crypto.randomUUID(),
      operator: 'AND',
      children: [],
      exclude: false,
      enabled: true,
    }
    handleAddNode(criteriaTree.id, newGroup)
  }

  return (
    <div className="p-3 space-y-0">
      {criteriaTree.children.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={criteriaTree.children.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {criteriaTree.children.map((child, index) => (
              <div key={child.id}>
                {index > 0 && (
                  <OperatorSeparator
                    operator={child.operator}
                    onToggle={() => handleToggleOperator(child.id)}
                  />
                )}
                {child.kind === 'criterion' ? (
                  <CriterionCard
                    node={child}
                    onUpdate={handleUpdateNode as (id: string, changes: Partial<CriterionNode>) => void}
                    onRemove={handleRemoveNode}
                    eventTableLabels={eventTableLabels}
                    genderValues={genderValues}
                    visitDateRange={visitDateRange}
                    dataSourceId={dataSourceId}
                    schemaMapping={schemaMapping}
                  />
                ) : (
                  <CriteriaGroupNodeComponent
                    node={child}
                    depth={1}
                    onUpdate={handleUpdateGroup}
                    onRemove={handleRemoveNode}
                    onAddNode={handleAddNode}
                    onRemoveNode={handleRemoveNode}
                    onUpdateNode={handleUpdateNode}
                    onMoveNode={handleMoveNode}
                    eventTableLabels={eventTableLabels}
                    genderValues={genderValues}
                    visitDateRange={visitDateRange}
                    dataSourceId={dataSourceId}
                    schemaMapping={schemaMapping}
                  />
                )}
              </div>
            ))}
          </SortableContext>
        </DndContext>
      ) : (
        <p className="py-8 text-center text-xs text-muted-foreground">
          {t('cohorts.group_empty')}
        </p>
      )}

      <div className="pt-2">
        <AddCriterionMenu
          onAddCriterion={handleAddCriterion}
          onAddGroup={handleAddGroup}
        />
      </div>
    </div>
  )
}

function getDefaultConfig(type: CriteriaType): CriteriaConfig {
  switch (type) {
    case 'age':
      return { ageReference: 'admission', min: undefined, max: undefined }
    case 'sex':
      return { values: [] }
    case 'death':
      return { isDead: true }
    case 'period':
      return { startDate: undefined, endDate: undefined }
    case 'duration':
      return { durationLevel: 'visit', minDays: undefined, maxDays: undefined }
    case 'care_site':
      return { careSiteLevel: 'visit_detail', values: [] }
    case 'concept':
      return { eventTableLabel: '', conceptIds: [], conceptNames: {} }
  }
}
