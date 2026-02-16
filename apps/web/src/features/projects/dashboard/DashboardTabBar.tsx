import { useState, useRef } from 'react'
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
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { X, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDashboardStore, type DashboardTab } from '@/stores/dashboard-store'
import { Input } from '@/components/ui/input'

interface DashboardTabBarProps {
  projectUid: string
}

function SortableTab({
  tab,
  isActive,
  canClose,
  onActivate,
  onClose,
  onRename,
}: {
  tab: DashboardTab
  isActive: boolean
  canClose: boolean
  onActivate: () => void
  onClose: () => void
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(tab.name)
  const inputRef = useRef<HTMLInputElement>(null)

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  }

  const handleDoubleClick = () => {
    setEditName(tab.name)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const handleFinishRename = () => {
    setEditing(false)
    if (editName.trim() && editName.trim() !== tab.name) {
      onRename(editName.trim())
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onActivate}
      onDoubleClick={handleDoubleClick}
      className={cn(
        'group flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap select-none',
        isActive
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30',
        isDragging && 'cursor-grabbing'
      )}
    >
      {editing ? (
        <Input
          ref={inputRef}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleFinishRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleFinishRename()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="h-5 w-24 px-1 text-xs"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span>{tab.name}</span>
      )}
      {canClose && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className={cn(
            'rounded p-0.5 transition-opacity',
            isActive
              ? 'opacity-60 hover:opacity-100 hover:bg-accent'
              : 'opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-accent'
          )}
        >
          <X size={10} />
        </button>
      )}
    </div>
  )
}

export function DashboardTabBar({ projectUid }: DashboardTabBarProps) {
  const { t } = useTranslation()
  const {
    tabs: allTabs,
    activeTabId,
    addTab,
    removeTab,
    renameTab,
    reorderTabs,
    setActiveTab,
  } = useDashboardStore()

  const tabs = allTabs
    .filter((t) => t.projectUid === projectUid)
    .sort((a, b) => a.displayOrder - b.displayOrder)
  const currentActiveId = activeTabId[projectUid] ?? tabs[0]?.id

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = tabs.findIndex((t) => t.id === active.id)
    const newIndex = tabs.findIndex((t) => t.id === over.id)
    const reordered = arrayMove(tabs, oldIndex, newIndex)
    reorderTabs(
      projectUid,
      reordered.map((t) => t.id)
    )
  }

  return (
    <div className="flex items-center overflow-hidden">
      <div className="flex items-center overflow-x-auto scrollbar-hide">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={tabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                isActive={tab.id === currentActiveId}
                canClose={tabs.length > 1}
                onActivate={() => setActiveTab(projectUid, tab.id)}
                onClose={() => removeTab(tab.id)}
                onRename={(name) => renameTab(tab.id, name)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <button
        onClick={() => addTab(projectUid)}
        className="flex items-center gap-1 border-b-2 border-transparent px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        title={t('dashboard.add_tab')}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}
