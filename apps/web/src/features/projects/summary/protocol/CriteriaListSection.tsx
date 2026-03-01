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
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus, X, GripVertical } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { ProtocolCriterion } from '@/types'

interface CriteriaListSectionProps {
  title: string
  criteria: ProtocolCriterion[]
  onChange: (criteria: ProtocolCriterion[]) => void
  editing: boolean
}

export function CriteriaListSection({ title, criteria, onChange, editing }: CriteriaListSectionProps) {
  const { t } = useTranslation()
  const [newText, setNewText] = useState('')
  const sorted = [...criteria].sort((a, b) => a.order - b.order)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = sorted.findIndex((c) => c.id === active.id)
    const newIndex = sorted.findIndex((c) => c.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove(sorted, oldIndex, newIndex).map((c, i) => ({ ...c, order: i }))
    onChange(reordered)
  }

  const handleAdd = () => {
    if (!newText.trim()) return
    const item: ProtocolCriterion = {
      id: `cr-${Date.now()}`,
      text: newText.trim(),
      order: criteria.length,
    }
    onChange([...criteria, item])
    setNewText('')
  }

  const handleRemove = (id: string) => {
    onChange(criteria.filter((c) => c.id !== id).map((c, i) => ({ ...c, order: i })))
  }

  const handleUpdate = (id: string, text: string) => {
    onChange(criteria.map((c) => c.id === id ? { ...c, text } : c))
  }

  if (!editing) {
    if (sorted.length === 0) return null
    return (
      <div className="mb-3">
        <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
        <ol className="ml-4 list-decimal space-y-0.5 text-sm">
          {sorted.map((c) => <li key={c.id}>{c.text}</li>)}
        </ol>
      </div>
    )
  }

  return (
    <div className="mb-3">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</div>
      {sorted.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={handleDragEnd}>
          <SortableContext items={sorted.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1">
              {sorted.map((c) => (
                <SortableCriterionItem key={c.id} criterion={c} onUpdate={handleUpdate} onRemove={handleRemove} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <Input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder={t('protocol.criterion_placeholder')}
          className="h-7 text-xs"
        />
        <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={handleAdd} disabled={!newText.trim()}>
          <Plus size={12} />
        </Button>
      </div>
    </div>
  )
}

function SortableCriterionItem({
  criterion,
  onUpdate,
  onRemove,
}: {
  criterion: ProtocolCriterion
  onUpdate: (id: string, text: string) => void
  onRemove: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: criterion.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="group flex items-center gap-1">
      <button {...attributes} {...listeners} className="shrink-0 cursor-grab text-muted-foreground/40 opacity-0 group-hover:opacity-100 active:cursor-grabbing">
        <GripVertical size={14} />
      </button>
      <Input
        value={criterion.text}
        onChange={(e) => onUpdate(criterion.id, e.target.value)}
        className="h-7 text-xs"
      />
      <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" onClick={() => onRemove(criterion.id)}>
        <X size={12} />
      </Button>
    </div>
  )
}
