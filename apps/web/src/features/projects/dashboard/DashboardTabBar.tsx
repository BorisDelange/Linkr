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
import { Plus, Pencil, Trash2, Layers, FolderPlus, ChevronRight, CornerLeftUp, Home } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DashboardTab } from '@/types'
import { useDashboardStore, getChildTabs, getTabPath } from '@/stores/dashboard-store'
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
  hasChildren,
  onActivate,
  onClose,
  onStartRename,
  onAddSubTab,
}: {
  tab: DashboardTab
  isActive: boolean
  canClose: boolean
  editMode: boolean
  /** Tab that contains sub-tabs — shows a container indicator and drills in on click. */
  hasChildren?: boolean
  onActivate: () => void
  onClose: () => void
  onStartRename: () => void
  onAddSubTab: () => void
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
        <ContextMenuItem onClick={onAddSubTab}>
          <FolderPlus size={14} />
          {t('dashboard.add_sub_tab')}
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
  siblingNames,
  onFinish,
}: {
  tab: DashboardTab
  isActive: boolean
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
        className={cn(
          'h-auto w-24 bg-transparent px-0 py-0 text-xs font-medium outline-none',
          isDuplicate && 'text-destructive',
        )}
        title={isDuplicate ? t('dashboard.tab_name_exists') : undefined}
      />
    </div>
  )
}

export function DashboardTabBar({ dashboardId, editMode }: DashboardTabBarProps) {
  const { t } = useTranslation()
  const {
    tabs: allTabs,
    widgets,
    activeTabId,
    addTab,
    addSubTab,
    removeTab,
    renameTab,
    reorderTabs,
    setActiveTab,
    enterTab,
  } = useDashboardStore()

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [confirmDeleteTabId, setConfirmDeleteTabId] = useState<string | null>(null)
  const confirmDeleteTab = confirmDeleteTabId ? allTabs.find(t => t.id === confirmDeleteTabId) : null
  // When sub-tabbing a tab that already holds widgets, ask what to do with them first.
  const [subTabWidgetsParentId, setSubTabWidgetsParentId] = useState<string | null>(null)

  // Add a sub-tab. If the tab has no sub-tabs yet but holds widgets, it's about to become a
  // container (which has no widgets of its own) — confirm whether to move or drop them.
  const requestAddSubTab = (parentId: string) => {
    const hasChildren = allTabs.some((tt) => tt.parentTabId === parentId)
    const ownWidgets = widgets.filter((w) => w.tabId === parentId)
    if (!hasChildren && ownWidgets.length > 0) {
      setSubTabWidgetsParentId(parentId)
    } else {
      addSubTab(parentId)
    }
  }
  const subTabWidgetCount = subTabWidgetsParentId
    ? widgets.filter((w) => w.tabId === subTabWidgetsParentId).length
    : 0

  const dashboardTabs = allTabs.filter((t) => t.dashboardId === dashboardId)
  const rootTabs = dashboardTabs
    .filter((t) => !t.parentTabId)
    .sort((a, b) => a.displayOrder - b.displayOrder)

  // The active tab (any level — may be a container) and its ancestor chain. The current
  // level is the active tab's siblings; ancestors render as a breadcrumb to the left.
  const activeId = activeTabId[dashboardId] ?? (rootTabs[0]?.id ?? null)
  const path = activeId ? getTabPath(dashboardTabs, activeId) : []
  const activeTab = path[path.length - 1] ?? null
  const parentOfLevel = activeTab?.parentTabId ?? null
  // Ancestors above the current level. All are clickable jump targets except the immediate
  // parent (the last one): it's shown for orientation but clicking it re-selects the same
  // level, so it stays inert — the "up one level" arrow handles going back to it.
  const ancestors = path.slice(0, -1)
  const clickableAncestors = ancestors.slice(0, -1)
  const immediateParent = ancestors[ancestors.length - 1] ?? null

  // Tabs shown on this single line: the active tab's siblings (or the roots).
  const tabs = (parentOfLevel
    ? getChildTabs(dashboardTabs, parentOfLevel)
    : rootTabs)

  // Tabs at this level that are themselves containers (show the Layers indicator).
  const containerIds = new Set(
    dashboardTabs.filter((t) => t.parentTabId).map((t) => t.parentTabId as string),
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = tabs.findIndex((t) => t.id === active.id)
    const newIndex = tabs.findIndex((t) => t.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
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

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {/* Breadcrumb shown once we're below the root level: an "up one level" arrow, a Home
            crumb back to the dashboard's root tabs, each clickable ancestor, then the immediate
            parent shown inert (for orientation — it names the level you're currently inside). */}
        {parentOfLevel && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => setActiveTab(dashboardId, parentOfLevel)}
              className="flex items-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t('dashboard.tab_up_one_level')}
            >
              <CornerLeftUp size={13} />
            </button>
            <button
              onClick={() => path[0] && setActiveTab(dashboardId, path[0].id)}
              className="flex items-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t('dashboard.tab_home')}
            >
              <Home size={13} />
            </button>
            {clickableAncestors.map((anc) => (
              <span key={anc.id} className="flex items-center gap-0.5">
                <ChevronRight size={12} className="shrink-0 text-muted-foreground/50" />
                <button
                  onClick={() => enterTab(dashboardId, anc.id)}
                  className="max-w-32 truncate rounded px-1 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  title={anc.name}
                >
                  {anc.name}
                </button>
              </span>
            ))}
            {immediateParent && (
              <span className="flex items-center gap-0.5">
                <ChevronRight size={12} className="shrink-0 text-muted-foreground/50" />
                <span className="max-w-32 truncate px-1 py-0.5 text-xs font-medium text-foreground" title={immediateParent.name}>
                  {immediateParent.name}
                </span>
              </span>
            )}
            <ChevronRight size={12} className="shrink-0 text-muted-foreground/50" />
          </div>
        )}

        {/* Current-level tabs. Thin bottom scrollbar with padding so it never hides labels. */}
        <div className="flex min-w-0 flex-1 items-end overflow-x-auto pb-0.5 [scrollbar-width:thin]">
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
                    isActive={tab.id === activeId}
                    siblingNames={new Set(
                      tabs.filter((tt) => tt.id !== tab.id).map((tt) => tt.name.toLowerCase()),
                    )}
                    onFinish={(name) => handleRenameFinish(tab.id, name)}
                  />
                ) : (
                  <SortableTab
                    key={tab.id}
                    tab={tab}
                    isActive={tab.id === activeId}
                    canClose={parentOfLevel ? true : tabs.length > 1}
                    editMode={editMode}
                    hasChildren={containerIds.has(tab.id)}
                    onActivate={() =>
                      containerIds.has(tab.id)
                        ? enterTab(dashboardId, tab.id)
                        : setActiveTab(dashboardId, tab.id)
                    }
                    onClose={() => setConfirmDeleteTabId(tab.id)}
                    onStartRename={() => setRenamingTabId(tab.id)}
                    onAddSubTab={() => requestAddSubTab(tab.id)}
                  />
                )
              )}
            </SortableContext>
          </DndContext>
          {editMode && (
            <button
              onClick={() => parentOfLevel ? addSubTab(parentOfLevel) : addTab(dashboardId)}
              className="flex shrink-0 items-center gap-1 border-b-2 border-transparent px-2 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
              title={parentOfLevel ? t('dashboard.add_sub_tab') : t('dashboard.add_tab')}
            >
              <Plus size={12} />
            </button>
          )}
        </div>
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

      {/* Sub-tabbing a tab that holds widgets: it becomes a container (no widgets of its own),
          so move the widgets into the new sub-tab or drop them. */}
      <AlertDialog open={subTabWidgetsParentId !== null} onOpenChange={(open) => { if (!open) setSubTabWidgetsParentId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dashboard.subtab_widgets_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard.subtab_widgets_description', { count: subTabWidgetCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (subTabWidgetsParentId) addSubTab(subTabWidgetsParentId, false)
                setSubTabWidgetsParentId(null)
              }}
            >
              {t('dashboard.subtab_widgets_delete')}
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                if (subTabWidgetsParentId) addSubTab(subTabWidgetsParentId, true)
                setSubTabWidgetsParentId(null)
              }}
            >
              {t('dashboard.subtab_widgets_move')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
