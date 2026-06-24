import { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GridLayout, type LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import type { Dashboard, DashboardWidget, FilterValue } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { WidgetCard } from './WidgetCard'
import { MoveWidgetDialog } from './MoveWidgetDialog'
import { buildDashboardTree } from './dashboard-tree'
import { isWidgetPluginStale } from './plugin-drift'
import { PluginWidgetRenderer } from './widget-renderers/PluginWidgetRenderer'
import { InlineCodeWidgetRenderer } from './widget-renderers/InlineCodeWidgetRenderer'
import { DashboardDataProvider, FILTER_NONE } from './DashboardDataProvider'
import { Filter } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { WidgetEditorDialog } from './WidgetEditorDialog'
import { DASHBOARD_GRID, computeFitRows, colWidthFor, FIT_ROWS } from './dashboard-grid'
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

interface WidgetGridProps {
  widgets: DashboardWidget[]
  editMode: boolean
  hideTitleBars?: boolean
  dashboard: Dashboard
  projectUid: string
  /** Open the dashboard Export dialog preselected to this widget. */
  onRequestExport?: (widgetId: string) => void
}

/** Resolve which filters apply to a given widget, keyed by column ID. `widgetParentTabId` is the
 *  parent of the widget's tab (when it's a sub-tab), so a tab-scoped filter targeting a container
 *  tab also reaches the widgets living in its sub-tabs. */
function resolveWidgetFilters(
  widget: DashboardWidget,
  dashboard: Dashboard,
  activeFilters: Record<string, FilterValue>,
  columnNameToId: Map<string, string>,
  widgetParentTabId: string | null | undefined,
): Record<string, FilterValue> | undefined {
  const result: Record<string, FilterValue> = {}
  let hasAny = false

  for (const filter of dashboard.filterConfig) {
    const filterValue = activeFilters[filter.id]
    if (!filterValue) continue

    // Check scope: skip if filter is scoped and widget is not in scope. A container tab in scope
    // covers the widgets of its sub-tabs, so match on the parent tab too.
    const scope = filter.scope ?? { type: 'all' }
    if (scope.type === 'tabs'
      && !scope.tabIds.includes(widget.tabId)
      && !(widgetParentTabId != null && scope.tabIds.includes(widgetParentTabId))) continue
    if (scope.type === 'widgets' && !scope.widgetIds.includes(widget.id)) continue

    if (filter.datasetFileId === widget.datasetFileId) {
      // Direct match: filter targets this widget's dataset
      result[filter.columnId] = filterValue
      hasAny = true
    } else {
      // Different dataset: match by column name (scope already decided this widget is in range).
      const targetColumnId = columnNameToId.get(filter.columnName)
      if (targetColumnId) {
        result[targetColumnId] = filterValue
        hasAny = true
      }
    }
  }

  return hasAny ? result : undefined
}

function formatRange(min: number | null, max: number | null): string {
  return `${min ?? '−∞'} – ${max ?? '+∞'}`
}

/** Structured summary of the filters that apply to a widget — one entry per active filter,
 *  with the column name and its restricting value(s) — for the widget's filter tooltip. */
interface FilterChip { column: string; values: string[] }

function buildFilterChips(
  filters: Record<string, FilterValue>,
  columns: { id: string; name: string }[],
): FilterChip[] {
  const nameOf = (id: string) => columns.find((c) => c.id === id)?.name ?? id
  const chips: FilterChip[] = []
  for (const [colId, v] of Object.entries(filters)) {
    const column = nameOf(colId)
    switch (v.type) {
      case 'categorical':
        if (v.selected.length === 1 && v.selected[0] === FILTER_NONE) { chips.push({ column, values: ['∅'] }); break }
        if (v.selected.length === 0) break
        chips.push({ column, values: v.selected })
        break
      case 'numeric':
        if (v.min == null && v.max == null) break
        chips.push({ column, values: [formatRange(v.min, v.max)] })
        break
      case 'numeric-double': {
        const parts: string[] = []
        if (v.min1 != null || v.max1 != null) parts.push(formatRange(v.min1, v.max1))
        if (v.min2 != null || v.max2 != null) parts.push(formatRange(v.min2, v.max2))
        if (parts.length === 0) break
        chips.push({ column, values: parts })
        break
      }
      case 'date':
        if (!v.from && !v.to) break
        chips.push({ column, values: [`${v.from ?? '…'} – ${v.to ?? '…'}`] })
        break
      case 'date-relative':
        chips.push({ column, values: [`${v.count} ${v.unit}`] })
        break
    }
  }
  return chips
}

function WidgetWithData({
  widget,
  dashboard,
  activeFilters,
  parentTabId,
}: {
  widget: DashboardWidget
  dashboard: Dashboard
  activeFilters: Record<string, FilterValue>
  parentTabId: string | null | undefined
}) {
  const { t } = useTranslation()
  const { files } = useDatasetStore()
  const datasetFile = files.find((f) => f.id === widget.datasetFileId)
  const columnNameToId = useMemo(
    () => new Map((datasetFile?.columns ?? []).map((c) => [c.name, c.id])),
    [datasetFile?.columns]
  )

  const filters = useMemo(
    () => resolveWidgetFilters(widget, dashboard, activeFilters, columnNameToId, parentTabId),
    [widget, dashboard, activeFilters, columnNameToId, parentTabId]
  )

  const filterChips = useMemo(
    () => (filters ? buildFilterChips(filters, datasetFile?.columns ?? []) : []),
    [filters, datasetFile?.columns]
  )

  return (
    <DashboardDataProvider
      datasetFileId={widget.datasetFileId ?? null}
      filters={filters}
      reloadOnTabSwitch={dashboard.reloadWidgetsOnTabSwitch === true}
    >
      <div className="relative flex h-full flex-col">
        {filterChips.length > 0 && (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="absolute left-1 top-1 z-10 flex size-5 items-center justify-center rounded bg-muted/80 text-muted-foreground backdrop-blur-sm">
                  <Filter size={11} />
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-h-72 max-w-64 overflow-y-auto bg-foreground text-background">
                <p className="mb-1 text-[11px] font-semibold">{t('dashboard.active_filters', { count: filterChips.length })}</p>
                <div className="space-y-2">
                  {filterChips.map((chip, i) => (
                    <div key={i} className="text-[11px]">
                      <div>
                        <span className="text-background/70">{t('dashboard.filter_column')} : </span>
                        <span className="font-medium">{chip.column}</span>
                      </div>
                      <div className="text-background/70">{t('dashboard.filter_values')} :</div>
                      <ul className="ml-1 list-inside list-disc">
                        {chip.values.slice(0, 12).map((val, j) => (
                          <li key={j} className="font-medium">{val}</li>
                        ))}
                        {chip.values.length > 12 && (
                          <li className="list-none text-background/70">
                            {t('dashboard.filter_values_more', { count: chip.values.length - 12 })}
                          </li>
                        )}
                      </ul>
                    </div>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <div className="min-h-0 flex-1">
          {widget.source.type === 'plugin' ? (
            <PluginWidgetRenderer widget={widget} />
          ) : widget.source.type === 'inline' ? (
            <InlineCodeWidgetRenderer widget={widget} />
          ) : (
            <div className="text-xs text-muted-foreground">Unknown widget type</div>
          )}
        </div>
      </div>
    </DashboardDataProvider>
  )
}

export function WidgetGrid({ widgets, editMode, hideTitleBars, dashboard, projectUid, onRequestExport }: WidgetGridProps) {
  const { t } = useTranslation()
  const { updateWidgetLayout, removeWidget, updateWidgetName, acceptPluginVersion, activeFilters, tabs, moveWidget, duplicateWidget, fitDashboardToHeight } = useDashboardStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1200)
  const [availableHeight, setAvailableHeight] = useState(0)
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null)
  const [confirmDeleteWidgetId, setConfirmDeleteWidgetId] = useState<string | null>(null)
  const [movingWidgetId, setMovingWidgetId] = useState<string | null>(null)
  const confirmDeleteWidget = confirmDeleteWidgetId ? widgets.find(w => w.id === confirmDeleteWidgetId) ?? null : null
  const movingWidget = movingWidgetId ? widgets.find(w => w.id === movingWidgetId) ?? null : null

  const editingWidget = editingWidgetId ? widgets.find(w => w.id === editingWidgetId) ?? null : null

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      setContainerWidth(el.clientWidth)
      const viewport = el.closest('[data-slot="scroll-area-viewport"]') ?? el.parentElement
      if (viewport) setAvailableHeight(viewport.clientHeight)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    const viewport = el.closest('[data-slot="scroll-area-viewport"]') ?? el.parentElement
    if (viewport) observer.observe(viewport)
    measure()
    return () => observer.disconnect()
  }, [])

  // Widget spacing drives both the inter-widget margin AND the outer padding, so the grid sits
  // flush against the available space (no half-cells at the edges) with one notion of spacing.
  // With "fit to height" on, the visible area holds a fixed number of rows (cells stay ~square).
  // We deliberately DON'T set the grid's maxRows: that would make react-grid-layout block a resize
  // that pushes another widget past the bottom. Instead we let the resize happen and re-fit the tab
  // afterwards (handleLayoutChange) so the others shrink to make room.
  const fitToHeight = dashboard.fitToHeight !== false
  // Spacing model (see DASHBOARD_GRID): jointive cells (margin 0) flush to the container edge
  // (containerPadding 0), so the full cells show right at the border. Each widget is inset by gap/2
  // (the wrapper below), so two touching widgets are separated by a full `gap` (gap/2 + gap/2,
  // demarcation centered) while edge widgets sit gap/2 from the border.
  const gap = dashboard.widgetSpacing ?? DASHBOARD_GRID.margin[0]
  const halfGap = gap / 2
  const fitRows = useMemo(() => {
    if (!fitToHeight || availableHeight === 0) return null
    return computeFitRows(containerWidth, availableHeight)
  }, [fitToHeight, availableHeight, containerWidth])
  const fitMaxRows = fitRows?.rows ?? 0

  const gridConfig = useMemo(() => {
    // Row height = visibleHeight / FIT_ROWS in BOTH modes, so a cell is the same size whether
    // fit-to-height is on or off (toggling it never resizes the cells). The only difference: with
    // fit on, layouts are kept within FIT_ROWS so everything is visible; with it off, a tall stack
    // is free to exceed FIT_ROWS and the grid scrolls. Falls back to the static row height before
    // the viewport is measured.
    const rowHeight = availableHeight > 0 ? availableHeight / FIT_ROWS : DASHBOARD_GRID.rowHeight
    const base = {
      ...DASHBOARD_GRID,
      rowHeight,
      margin: [0, 0] as [number, number],
      containerPadding: [0, 0] as [number, number],
    }
    return fitRows ? { ...base, rowHeight: fitRows.rowHeight } : base
  }, [fitRows, availableHeight])

  // When the visible row count changes (mount, reload, entering/leaving fullscreen, window resize)
  // we keep the widgets' vertical PROPORTIONS: their heights in rows stay as the user set them, and
  // since rowHeight (px) is recomputed for the new height, the same rows fill the new viewport
  // proportionally. So this is always shrink-only — it never re-stretches widgets to fill leftover
  // space (that would undo half-height layouts on reload/fullscreen); it only trims a real overflow.
  // Explicit actions still fill: turning the mode on (settings) and adding a widget.
  useEffect(() => {
    if (fitMaxRows > 0) fitDashboardToHeight(dashboard.id, fitMaxRows, 'shrink-only')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitMaxRows, dashboard.id])

  const layout: LayoutItem[] = useMemo(
    () =>
      widgets.map((w) => ({
        i: w.id,
        x: w.layout.x,
        y: w.layout.y,
        w: w.layout.w,
        h: w.layout.h,
        minW: 2,
        minH: 2,
      })),
    [widgets]
  )

  const handleLayoutChange = useCallback(
    (newLayout: readonly LayoutItem[]) => {
      for (const item of newLayout) {
        const widget = widgets.find((w) => w.id === item.i)
        if (
          widget &&
          (widget.layout.x !== item.x ||
            widget.layout.y !== item.y ||
            widget.layout.w !== item.w ||
            widget.layout.h !== item.h)
        ) {
          updateWidgetLayout(item.i, {
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
          })
        }
      }
      // In fit-to-height, re-fit after a drag/resize — but shrink-only: only trim widgets when the
      // change pushes the stack past the bottom. Widening or moving a widget that still fits must
      // not reflow or re-stretch the others. (A no-op once the tab fits, so this never loops.)
      if (fitMaxRows > 0) fitDashboardToHeight(dashboard.id, fitMaxRows, 'shrink-only')
    },
    [widgets, updateWidgetLayout, fitMaxRows, fitDashboardToHeight, dashboard.id]
  )

  const tabParentById = useMemo(
    () => new Map(tabs.map((tb) => [tb.id, tb.parentTabId ?? null])),
    [tabs],
  )

  // Hierarchical tab/widget rows for the Move-to-tab dialog (widgets shown for context).
  const moveTree = useMemo(
    () => buildDashboardTree(tabs, widgets, dashboard.id, true),
    [tabs, widgets, dashboard.id],
  )
  // Leaf tabs are the valid move destinations.
  const moveTargetIds = useMemo(
    () => new Set(moveTree.filter((r) => r.kind === 'tab' && !r.isContainer).map((r) => r.id)),
    [moveTree],
  )

  // In edit mode, paint a faint cell grid so widget placement is easier to read. The backdrop fills
  // the whole container flush to the parent (inset 0) and the cell lines start at the top-left
  // corner (cells are jointive, flush to the edge, pitch = colWidth × rowHeight), so the full first
  // and last cells are visible right at the border. Lines past the last widget read as free grid.
  const gridBackground = useMemo(() => {
    if (!editMode) return undefined
    const { rowHeight } = gridConfig
    const colWidth = colWidthFor(containerWidth)
    if (colWidth <= 0 || rowHeight <= 0) return undefined
    return {
      position: 'absolute' as const,
      inset: 0,
      backgroundImage:
        'linear-gradient(to right, var(--color-border) 1px, transparent 1px),' +
        'linear-gradient(to bottom, var(--color-border) 1px, transparent 1px)',
      backgroundSize: `${colWidth}px ${rowHeight}px`,
      backgroundPosition: '0 0',
      opacity: 0.4,
    } as const
  }, [editMode, gridConfig, containerWidth])

  // Heights are driven by the measured viewport (the Radix scroll viewport uses display:table, so
  // percentage heights don't resolve). In fit-to-height we pin the container to the full viewport
  // and clip overflow: the row height is floored so the grid never exceeds it (no clipped bottom
  // widget) and the sub-row leftover sits at the very bottom as background. In fixed-height edit
  // mode we only stretch the minimum so the grid backdrop reaches the bottom.
  const containerStyle = availableHeight > 0
    ? (fitToHeight
        ? { height: availableHeight, overflow: 'hidden' as const }
        : (editMode ? { minHeight: availableHeight } : undefined))
    : undefined

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      style={containerStyle}
    >
      {gridBackground && <div className="pointer-events-none" style={gridBackground} />}
      <GridLayout
        layout={layout}
        width={containerWidth}
        gridConfig={gridConfig}
        dragConfig={{
          enabled: editMode,
        }}
        resizeConfig={{
          enabled: editMode,
        }}
        onLayoutChange={handleLayoutChange}
        autoSize
      >
        {widgets.map((widget) => {
          // Sibling names for uniqueness check (exclude current widget)
          const siblingNames = new Set(
            widgets.filter(w => w.id !== widget.id).map(w => w.name.toLowerCase())
          )
          const canMove = [...moveTargetIds].some((id) => id !== widget.tabId)
          return (
          // Inset the card inside its jointive grid cell so two adjacent cards show a `gap`-wide
          // gutter. The top/left padding is `halfGap + 1`: the card's border sits ON the grid line on
          // those sides (the line is drawn at the cell's top-left), whereas on the bottom/right it
          // falls just inside, so the extra pixel left/top compensates and the gutters read even.
          <div
            key={widget.id}
            className="box-border h-full"
            style={{ paddingTop: halfGap + 1, paddingLeft: halfGap + 1, paddingBottom: halfGap, paddingRight: halfGap }}
            data-widget-id={widget.id}
            data-widget-name={widget.name}
          >
            <WidgetCard
              title={widget.name}
              onRemove={() => setConfirmDeleteWidgetId(widget.id)}
              onRename={(name) => updateWidgetName(widget.id, name)}
              siblingNames={siblingNames}
              onEdit={() => setEditingWidgetId(widget.id)}
              onExport={onRequestExport ? () => onRequestExport(widget.id) : undefined}
              onDuplicate={() => duplicateWidget(widget.id)}
              onMove={canMove ? () => setMovingWidgetId(widget.id) : undefined}
              editMode={editMode}
              hideTitleBar={hideTitleBars}
              stale={isWidgetPluginStale(widget)}
              onAcceptPluginVersion={() => acceptPluginVersion(widget.id)}
            >
              <WidgetWithData
                widget={widget}
                dashboard={dashboard}
                activeFilters={activeFilters}
                parentTabId={tabParentById.get(widget.tabId)}
              />
            </WidgetCard>
          </div>
          )
        })}
      </GridLayout>

      <WidgetEditorDialog
        widget={editingWidget}
        open={editingWidgetId !== null}
        onOpenChange={(open) => { if (!open) setEditingWidgetId(null) }}
        projectUid={projectUid}
        gridWidth={containerWidth}
        widgetSpacing={dashboard.widgetSpacing}
      />

      <AlertDialog open={confirmDeleteWidgetId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteWidgetId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dashboard.delete_widget_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard.delete_widget_description', { name: confirmDeleteWidget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (confirmDeleteWidgetId) removeWidget(confirmDeleteWidgetId)
                setConfirmDeleteWidgetId(null)
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {movingWidget && (
        <MoveWidgetDialog
          open={movingWidgetId !== null}
          onOpenChange={(o) => { if (!o) setMovingWidgetId(null) }}
          widgetName={movingWidget.name}
          currentTabId={movingWidget.tabId}
          rows={moveTree}
          onMove={(tabId) => {
            moveWidget(movingWidget.id, tabId)
            // In fit-to-height, only trim the target tab if the moved widget makes it overflow —
            // never re-stretch its existing widgets.
            if (fitToHeight) {
              const fit = computeFitRows(containerWidth, availableHeight)
              if (fit) fitDashboardToHeight(dashboard.id, fit.rows, 'shrink-only')
            }
          }}
        />
      )}
    </div>
  )
}
