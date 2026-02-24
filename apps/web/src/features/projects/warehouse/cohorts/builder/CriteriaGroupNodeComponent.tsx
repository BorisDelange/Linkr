import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Power, X, Pencil, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
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

interface CriteriaGroupNodeComponentProps {
  node: CriteriaGroupNode
  depth: number
  onUpdate: (id: string, changes: Partial<CriteriaGroupNode>) => void
  onRemove: (id: string) => void
  onAddNode: (parentId: string, node: CriteriaTreeNode) => void
  onRemoveNode: (id: string) => void
  onUpdateNode: (id: string, changes: Partial<CriteriaTreeNode>) => void
  onMoveNode: (groupId: string, fromIdx: number, toIdx: number) => void
  eventTableLabels: string[]
  genderValues?: SchemaMapping['genderValues']
  visitDateRange?: { minDate: string; maxDate: string }
  dataSourceId?: string
  schemaMapping?: SchemaMapping
}

export function CriteriaGroupNodeComponent({
  node,
  depth,
  onUpdate,
  onRemove,
  onAddNode,
  onRemoveNode,
  onUpdateNode,
  onMoveNode,
  eventTableLabels,
  genderValues,
  visitDateRange,
  dataSourceId,
  schemaMapping,
}: CriteriaGroupNodeComponentProps) {
  const { t } = useTranslation()
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState(node.label ?? '')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const fromIdx = node.children.findIndex((c) => c.id === active.id)
    const toIdx = node.children.findIndex((c) => c.id === over.id)
    if (fromIdx === -1 || toIdx === -1) return
    onMoveNode(node.id, fromIdx, toIdx)
  }

  const handleLabelSave = () => {
    onUpdate(node.id, { label: labelDraft.trim() || undefined })
    setEditingLabel(false)
  }

  const handleToggleChildOperator = (childId: string) => {
    const child = node.children.find((c) => c.id === childId)
    if (!child) return
    onUpdateNode(childId, {
      operator: child.operator === 'AND' ? 'OR' : 'AND',
    })
  }

  const handleAddCriterion = (type: CriteriaType) => {
    let config = getDefaultConfigForType(type)
    if (type === 'period' && visitDateRange) {
      config = { startDate: visitDateRange.minDate, endDate: visitDateRange.maxDate }
    }
    const newNode: CriteriaTreeNode = {
      kind: 'criterion',
      id: crypto.randomUUID(),
      type,
      config,
      operator: 'AND',
      exclude: false,
      enabled: true,
    }
    onAddNode(node.id, newNode)
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
    onAddNode(node.id, newGroup)
  }

  // Sortable wrapper for this group node
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.id })

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
  }

  return (
    <div ref={setSortableRef} style={sortableStyle}>
      <div
        className={cn(
          'rounded-lg border bg-muted/20',
          isDragging && 'opacity-50',
          !node.enabled && 'opacity-50',
        )}
      >
        {/* Header bar */}
        <div className="flex items-center gap-1.5 px-2.5 py-1.5">
          {/* Drag handle */}
          <button
            type="button"
            className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={14} />
          </button>

          {/* Group label (editable inline) */}
          <div className="flex-1 min-w-0 flex items-center gap-1">
            {editingLabel ? (
              <div className="flex items-center gap-1 flex-1">
                <Input
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleLabelSave()
                    if (e.key === 'Escape') setEditingLabel(false)
                  }}
                  placeholder={t('cohorts.group_label_placeholder')}
                  className="h-6 text-xs flex-1"
                  autoFocus
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={handleLabelSave}
                >
                  <Check size={10} />
                </Button>
              </div>
            ) : (
              <>
                <span className="text-xs text-muted-foreground truncate">
                  {node.label || t('cohorts.group_default_label')}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0"
                  onClick={() => {
                    setLabelDraft(node.label ?? '')
                    setEditingLabel(true)
                  }}
                >
                  <Pencil size={10} />
                </Button>
              </>
            )}
          </div>

          {/* Exclude toggle (NOT) */}
          <div className="flex items-center gap-1">
            <Switch
              id={`not-group-${node.id}`}
              checked={node.exclude}
              onCheckedChange={(checked) => onUpdate(node.id, { exclude: checked })}
              className="scale-75"
            />
            <label
              htmlFor={`not-group-${node.id}`}
              className="text-[10px] font-medium text-muted-foreground cursor-pointer select-none"
            >
              NOT
            </label>
          </div>

          {/* Enable toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => onUpdate(node.id, { enabled: !node.enabled })}
            title={node.enabled ? t('cohorts.disable') : t('cohorts.enable')}
          >
            <Power size={12} className={node.enabled ? 'text-foreground' : 'text-muted-foreground'} />
          </Button>

          {/* Remove */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => onRemove(node.id)}
            title={t('common.remove')}
          >
            <X size={12} />
          </Button>
        </div>

        {/* Children area */}
        <div className="ml-3 border-l-2 border-muted-foreground/20 pl-3 pb-2.5 pr-2.5 space-y-0">
          {node.children.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={node.children.map((c) => c.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-0 pt-2">
                  {node.children.map((child, index) => (
                    <div key={child.id}>
                      {/* Operator separator between children */}
                      {index > 0 && (
                        <OperatorSeparator
                          operator={child.operator}
                          onToggle={() => handleToggleChildOperator(child.id)}
                        />
                      )}
                      {child.kind === 'criterion' ? (
                        <CriterionCard
                          node={child}
                          onUpdate={onUpdateNode as (id: string, changes: Partial<CriterionNode>) => void}
                          onRemove={onRemoveNode}
                          eventTableLabels={eventTableLabels}
                          genderValues={genderValues}
                          visitDateRange={visitDateRange}
                          dataSourceId={dataSourceId}
                          schemaMapping={schemaMapping}
                        />
                      ) : (
                        <CriteriaGroupNodeComponent
                          node={child}
                          depth={depth + 1}
                          onUpdate={onUpdate}
                          onRemove={onRemoveNode}
                          onAddNode={onAddNode}
                          onRemoveNode={onRemoveNode}
                          onUpdateNode={onUpdateNode}
                          onMoveNode={onMoveNode}
                          eventTableLabels={eventTableLabels}
                          genderValues={genderValues}
                          visitDateRange={visitDateRange}
                          dataSourceId={dataSourceId}
                          schemaMapping={schemaMapping}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <p className="py-3 text-center text-xs text-muted-foreground">
              {t('cohorts.group_empty')}
            </p>
          )}

          {/* Add button */}
          <div className="pt-2">
            <AddCriterionMenu
              onAddCriterion={handleAddCriterion}
              onAddGroup={handleAddGroup}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Helpers ---

function getDefaultConfigForType(type: CriteriaType): CriteriaConfig {
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
