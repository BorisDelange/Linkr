import { useState, useRef, useCallback, useEffect } from 'react'
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
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DashboardTab } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface DashboardTabBarProps {
  dashboardId: string
  editMode: boolean
}

function SortableTab({
  tab,
  isActive,
  canClose,
  editMode,
  onActivate,
  onClose,
  onStartRename,
}: {
  tab: DashboardTab
  isActive: boolean
  canClose: boolean
  editMode: boolean
  onActivate: () => void
  onClose: () => void
  onStartRename: () => void
}) {
  const { t } = useTranslation()

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id, disabled: !editMode })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...(editMode ? listeners : {})}
          onClick={onActivate}
          onDoubleClick={onStartRename}
          className={cn(
            'group flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap select-none',
            isActive
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30',
            isDragging && 'cursor-grabbing'
          )}
        >
          <span>{tab.name}</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onStartRename}>
          <Pencil size={14} />
          {t('common.rename')}
        </ContextMenuItem>
        {canClose && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onClose}>
              <Trash2 size={14} />
              {t('common.delete')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Inline rename input — rendered instead of SortableTab when editing. */
function TabRenameInput({
  tab,
  isActive,
  onFinish,
}: {
  tab: DashboardTab
  isActive: boolean
  onFinish: (newName: string | null) => void
}) {
  const [value, setValue] = useState(tab.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        const len = el.value.length
        el.setSelectionRange(len, len)
      }
    })
  }, [])

  const commit = useCallback(() => {
    const trimmed = value.trim()
    onFinish(trimmed && trimmed !== tab.name ? trimmed : null)
  }, [value, tab.name, onFinish])

  return (
    <div
      className={cn(
        'flex items-center border-b-2 px-3 py-1.5',
        isActive ? 'border-primary' : 'border-transparent',
      )}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') onFinish(null)
        }}
        className="h-auto w-24 bg-transparent px-0 py-0 text-xs font-medium outline-none"
      />
    </div>
  )
}

export function DashboardTabBar({ dashboardId, editMode }: DashboardTabBarProps) {
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

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [confirmDeleteTabId, setConfirmDeleteTabId] = useState<string | null>(null)
  const confirmDeleteTab = confirmDeleteTabId ? allTabs.find(t => t.id === confirmDeleteTabId) : null

  const tabs = allTabs
    .filter((t) => t.dashboardId === dashboardId)
    .sort((a, b) => a.displayOrder - b.displayOrder)
  const currentActiveId = activeTabId[dashboardId] ?? tabs[0]?.id

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
      dashboardId,
      reordered.map((t) => t.id)
    )
  }

  const handleConfirmDelete = () => {
    if (confirmDeleteTabId) {
      removeTab(confirmDeleteTabId)
      setConfirmDeleteTabId(null)
    }
  }

  const handleRenameFinish = useCallback((tabId: string, newName: string | null) => {
    if (newName) renameTab(tabId, newName)
    setRenamingTabId(null)
  }, [renameTab])

  return (
    <>
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
              {tabs.map((tab) =>
                renamingTabId === tab.id ? (
                  <TabRenameInput
                    key={tab.id}
                    tab={tab}
                    isActive={tab.id === currentActiveId}
                    onFinish={(name) => handleRenameFinish(tab.id, name)}
                  />
                ) : (
                  <SortableTab
                    key={tab.id}
                    tab={tab}
                    isActive={tab.id === currentActiveId}
                    canClose={tabs.length > 1}
                    editMode={editMode}
                    onActivate={() => setActiveTab(dashboardId, tab.id)}
                    onClose={() => setConfirmDeleteTabId(tab.id)}
                    onStartRename={() => setRenamingTabId(tab.id)}
                  />
                )
              )}
            </SortableContext>
          </DndContext>
        </div>
        {editMode && (
          <button
            onClick={() => addTab(dashboardId)}
            className="flex items-center gap-1 border-b-2 border-transparent px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            title={t('dashboard.add_tab')}
          >
            <Plus size={12} />
          </button>
        )}
      </div>

      <AlertDialog open={confirmDeleteTabId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteTabId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dashboard.delete_tab_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard.delete_tab_description', { name: confirmDeleteTab?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleConfirmDelete}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
