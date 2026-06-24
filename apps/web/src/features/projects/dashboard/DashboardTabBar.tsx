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
import { Plus, Pencil, Trash2, Layers, FolderPlus } from 'lucide-react'
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
  /** When set, this bar renders the sub-tabs of the given parent (one level deep). */
  parentTabId?: string | null
}

function SortableTab({
  tab,
  isActive,
  canClose,
  editMode,
  hasChildren,
  subBar,
  onActivate,
  onClose,
  onStartRename,
  onAddSubTab,
}: {
  tab: DashboardTab
  isActive: boolean
  canClose: boolean
  editMode: boolean
  /** Root tab that contains sub-tabs — shows a container indicator. */
  hasChildren?: boolean
  /** Rendered inside a sub-tab bar (smaller, muted styling). */
  subBar?: boolean
  onActivate: () => void
  onClose: () => void
  onStartRename: () => void
  /** Only provided for root tabs — adds a sub-tab to this tab. */
  onAddSubTab?: () => void
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
            'group flex cursor-pointer items-center gap-1.5 border-b-2 font-medium transition-colors whitespace-nowrap select-none',
            subBar ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs',
            isActive
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30',
            isDragging && 'cursor-grabbing'
          )}
        >
          <span>{tab.name}</span>
          {hasChildren && (
            <Layers size={11} className="text-muted-foreground/70 shrink-0" />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onStartRename}>
          <Pencil size={14} />
          {t('common.rename')}
        </ContextMenuItem>
        {onAddSubTab && (
          <ContextMenuItem onClick={onAddSubTab}>
            <FolderPlus size={14} />
            {t('dashboard.add_sub_tab')}
          </ContextMenuItem>
        )}
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
  subBar,
  siblingNames,
  onFinish,
}: {
  tab: DashboardTab
  isActive: boolean
  subBar?: boolean
  /** Names of the other tabs at this level (lowercased) — for dup detection. */
  siblingNames: Set<string>
  onFinish: (newName: string | null) => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState(tab.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    })
  }, [])

  const trimmed = value.trim()
  const isDuplicate = trimmed.length > 0 && siblingNames.has(trimmed.toLowerCase())

  const commit = useCallback(() => {
    const next = value.trim()
    if (!next || next === tab.name || siblingNames.has(next.toLowerCase())) {
      onFinish(null)
    } else {
      onFinish(next)
    }
  }, [value, tab.name, siblingNames, onFinish])

  return (
    <div
      className={cn(
        'flex items-center border-b-2',
        subBar ? 'px-2.5 py-1' : 'px-3 py-1.5',
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
        className={cn(
          'h-auto w-24 bg-transparent px-0 py-0 font-medium outline-none',
          subBar ? 'text-[11px]' : 'text-xs',
          isDuplicate && 'text-destructive',
        )}
        title={isDuplicate ? t('dashboard.tab_name_exists') : undefined}
      />
    </div>
  )
}

export function DashboardTabBar({ dashboardId, editMode, parentTabId }: DashboardTabBarProps) {
  const { t } = useTranslation()
  const {
    tabs: allTabs,
    activeTabId,
    activeSubTabId,
    addTab,
    addSubTab,
    removeTab,
    renameTab,
    reorderTabs,
    setActiveTab,
    setActiveSubTab,
  } = useDashboardStore()

  const isSubBar = parentTabId != null

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [confirmDeleteTabId, setConfirmDeleteTabId] = useState<string | null>(null)
  const confirmDeleteTab = confirmDeleteTabId ? allTabs.find(t => t.id === confirmDeleteTabId) : null

  // Tabs shown at this level: a parent's children for the sub-bar, else the dashboard's root tabs.
  const tabs = allTabs
    .filter((t) => isSubBar ? t.parentTabId === parentTabId : (t.dashboardId === dashboardId && !t.parentTabId))
    .sort((a, b) => a.displayOrder - b.displayOrder)

  // Root tabs that contain sub-tabs (for the container indicator). Empty for the sub-bar.
  const containerIds = new Set(
    isSubBar ? [] : allTabs.filter((t) => t.parentTabId).map((t) => t.parentTabId as string),
  )

  const currentActiveId = isSubBar
    ? (activeSubTabId[parentTabId] ?? tabs[0]?.id)
    : (activeTabId[dashboardId] ?? tabs[0]?.id)

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
    reorderTabs(dashboardId, reordered.map((t) => t.id))
  }

  const handleConfirmDelete = () => {
    if (confirmDeleteTabId) {
      removeTab(confirmDeleteTabId)
      setConfirmDeleteTabId(null)
    }
  }

  const handleRenameFinish = useCallback((tabId: string, newName: string | null) => {
    if (newName) {
      const exists = tabs.some(
        (t) => t.id !== tabId && t.name.toLowerCase() === newName.toLowerCase(),
      )
      if (!exists) renameTab(tabId, newName)
    }
    setRenamingTabId(null)
  }, [renameTab, tabs])

  const activate = (tabId: string) =>
    isSubBar ? setActiveSubTab(parentTabId, tabId) : setActiveTab(dashboardId, tabId)

  return (
    <>
      <div className={cn('flex items-center overflow-hidden', isSubBar && 'bg-muted/30')}>
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
                    subBar={isSubBar}
                    siblingNames={new Set(
                      tabs.filter((tt) => tt.id !== tab.id).map((tt) => tt.name.toLowerCase()),
                    )}
                    onFinish={(name) => handleRenameFinish(tab.id, name)}
                  />
                ) : (
                  <SortableTab
                    key={tab.id}
                    tab={tab}
                    isActive={tab.id === currentActiveId}
                    canClose={isSubBar ? true : tabs.length > 1}
                    editMode={editMode}
                    hasChildren={containerIds.has(tab.id)}
                    subBar={isSubBar}
                    onActivate={() => activate(tab.id)}
                    onClose={() => setConfirmDeleteTabId(tab.id)}
                    onStartRename={() => setRenamingTabId(tab.id)}
                    onAddSubTab={!isSubBar ? () => addSubTab(tab.id) : undefined}
                  />
                )
              )}
            </SortableContext>
          </DndContext>
        </div>
        {editMode && (
          <button
            onClick={() => isSubBar ? addSubTab(parentTabId) : addTab(dashboardId)}
            className={cn(
              'flex items-center gap-1 border-b-2 border-transparent text-muted-foreground hover:text-foreground transition-colors',
              isSubBar ? 'px-2 py-1' : 'px-2 py-1.5',
            )}
            title={isSubBar ? t('dashboard.add_sub_tab') : t('dashboard.add_tab')}
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
