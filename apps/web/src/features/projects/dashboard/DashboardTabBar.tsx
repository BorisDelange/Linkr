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
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus, Pencil, Trash2, Layers, FolderPlus, ChevronRight, Home } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { DashboardTab } from '@/types'
import { useDashboardStore, getChildTabs, getTabPath } from '@/stores/dashboard-store'
import { useAppStore } from '@/stores/app-store'
import { localized } from '@/lib/localized'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DashboardItemEditDialog } from './DashboardItemEditDialog'
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
  label,
  description,
  onActivate,
  onClose,
  onEdit,
  onAddSubTab,
}: {
  tab: DashboardTab
  isActive: boolean
  canClose: boolean
  editMode: boolean
  /** Tab that contains sub-tabs — shows a container indicator and drills in on click. */
  hasChildren?: boolean
  /** Tab name resolved in the active language. */
  label: string
  /** Tab description resolved in the active language (empty when none) — shown as a hover tooltip. */
  description: string
  onActivate: () => void
  onClose: () => void
  onEdit: () => void
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

  const tabInner = (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...(editMode ? listeners : {})}
      onClick={onActivate}
      onDoubleClick={onEdit}
      className={cn(
        'group flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap select-none',
        isActive
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30',
        isDragging && 'cursor-grabbing'
      )}
    >
      <span>{label}</span>
      {hasChildren && (
        <Layers size={11} className="text-muted-foreground/70 shrink-0" />
      )}
    </div>
  )

  return (
    // Tooltip (hover description) wraps the context menu; both triggers use asChild and compose
    // their refs/handlers onto the single `tabInner` div. Keeping this structure always mounted
    // (only the TooltipContent is conditional) means adding a description at runtime doesn't remount
    // the node — which previously broke the just-edited tooltip. The 1s open delay (and "instant for
    // the next tab") comes from the single TooltipProvider wrapping the whole row.
    <Tooltip>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>{tabInner}</TooltipTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onEdit}>
            <Pencil size={14} />
            {t('common.edit')}
          </ContextMenuItem>
          <ContextMenuItem onClick={onAddSubTab}>
            <FolderPlus size={14} />
            {t('dashboard.add_sub_tab')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {canClose ? (
            <ContextMenuItem variant="destructive" onClick={onClose}>
              <Trash2 size={14} />
              {t('common.delete')}
            </ContextMenuItem>
          ) : (
            // Last root tab: a dashboard always keeps at least one tab, so the delete stays
            // visible but disabled with an explanation instead of silently vanishing.
            <ContextMenuItem disabled>
              <Trash2 size={14} />
              {t('dashboard.delete_tab_last')}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {description && (
        <TooltipContent side="bottom" className="max-w-64 whitespace-pre-wrap bg-foreground text-background">
          {description}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

export function DashboardTabBar({ dashboardId, editMode }: DashboardTabBarProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const {
    tabs: allTabs,
    widgets,
    activeTabId,
    addTab,
    addSubTab,
    removeTab,
    updateTab,
    reorderTabs,
    setActiveTab,
    enterTab,
  } = useDashboardStore()

  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const editingTab = editingTabId ? allTabs.find((t) => t.id === editingTabId) ?? null : null
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

  // Sibling names (active language, lowercased) for the edit dialog's uniqueness check.
  const editingSiblingNames = editingTab
    ? new Set(
        tabs
          .filter((tt) => tt.id !== editingTab.id)
          .map((tt) => localized(tt.name, language).toLowerCase()),
      )
    : new Set<string>()

  return (
    <>
      <div className="flex min-w-0 flex-1 items-stretch gap-1">
        {/* Breadcrumb shown once we're below the root level: a Home crumb back to the dashboard's
            root tabs, each clickable ancestor, then the immediate parent shown inert (for
            orientation — it names the level you're currently inside). The border-b-2 mirrors the
            tabs' bottom border so the breadcrumb text lines up with the tab labels. */}
        {parentOfLevel && (
          <div className="flex shrink-0 items-center gap-0.5 border-b-2 border-transparent">
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
                  title={localized(anc.name, language)}
                >
                  {localized(anc.name, language)}
                </button>
              </span>
            ))}
            {immediateParent && (
              <span className="flex items-center gap-0.5">
                <ChevronRight size={12} className="shrink-0 text-muted-foreground/50" />
                <span className="max-w-32 truncate px-1 py-0.5 text-xs font-medium text-foreground" title={localized(immediateParent.name, language)}>
                  {localized(immediateParent.name, language)}
                </span>
              </span>
            )}
            <ChevronRight size={12} className="shrink-0 text-muted-foreground/50" />
          </div>
        )}

        {/* Current-level tabs. Thin scrollbar; the row reserves a little extra height (py-1) so
            the scrollbar sits below the labels and the tabs stay vertically aligned with the
            breadcrumb instead of being pushed up. */}
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto py-1 [scrollbar-width:thin]">
          {/* One TooltipProvider around the whole row: the first tab's description tooltip waits 1s,
              then hovering the other tabs shows theirs immediately; leaving the row resets the delay. */}
          <TooltipProvider delayDuration={1000}>
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
                    isActive={tab.id === activeId}
                    canClose={parentOfLevel ? true : tabs.length > 1}
                    editMode={editMode}
                    hasChildren={containerIds.has(tab.id)}
                    label={localized(tab.name, language)}
                    description={localized(tab.description, language)}
                    onActivate={() =>
                      containerIds.has(tab.id)
                        ? enterTab(dashboardId, tab.id)
                        : setActiveTab(dashboardId, tab.id)
                    }
                    onClose={() => setConfirmDeleteTabId(tab.id)}
                    onEdit={() => setEditingTabId(tab.id)}
                    onAddSubTab={() => requestAddSubTab(tab.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </TooltipProvider>
        </div>

        {/* Outside the scrolling tab row: the button keeps its place while the tabs scroll under it. */}
        {editMode && (
          <div className="flex shrink-0 items-center py-1">
            <Button
              variant="outline"
              size="xs"
              className="ml-2 gap-1"
              onClick={() => parentOfLevel ? addSubTab(parentOfLevel) : addTab(dashboardId)}
            >
              <Plus size={12} />
              {parentOfLevel ? t('dashboard.add_sub_tab') : t('dashboard.add_tab')}
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={confirmDeleteTabId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteTabId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dashboard.delete_tab_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard.delete_tab_description', { name: confirmDeleteTab ? localized(confirmDeleteTab.name, language) : '' })}
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

      {editingTab && (
        <DashboardItemEditDialog
          title={t('dashboard.edit_tab_title')}
          name={editingTab.name}
          description={editingTab.description}
          siblingNames={editingSiblingNames}
          onSave={(changes) => updateTab(editingTab.id, changes)}
          onOpenChange={(open) => { if (!open) setEditingTabId(null) }}
        />
      )}
    </>
  )
}
