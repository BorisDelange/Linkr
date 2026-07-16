import { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GridLayout, type LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import type { Dashboard, DashboardWidget, FilterValue } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useAppStore } from '@/stores/app-store'
import { localized } from '@/lib/localized'
import { WidgetCard } from './WidgetCard'
import { MoveWidgetDialog } from './MoveWidgetDialog'
import { buildDashboardTree } from './dashboard-tree'
import { isWidgetPluginStale } from './plugin-drift'
import { PluginWidgetRenderer } from './widget-renderers/PluginWidgetRenderer'
import { InlineCodeWidgetRenderer } from './widget-renderers/InlineCodeWidgetRenderer'
import { DashboardDataProvider } from './DashboardDataProvider'
import { resolveWidgetFilters, buildFilterChips, buildFilterLabelMap } from './dashboard-filters'
import { Filter } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { WidgetEditorDialog } from './WidgetEditorDialog'
import { DashboardItemEditDialog } from './DashboardItemEditDialog'
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

/** Filters reaching a widget (for its data provider) + the chips that describe them (for the
 *  filter badge). Shared so the badge can live in the WidgetCard rail while the provider stays
 *  with the content. */
function useWidgetFilters(
  widget: DashboardWidget,
  dashboard: Dashboard,
  activeFilters: Record<string, FilterValue>,
  parentTabId: string | null | undefined,
) {
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
    () => (filters ? buildFilterChips(filters, datasetFile?.columns ?? [], buildFilterLabelMap(dashboard, columnNameToId)) : []),
    [filters, datasetFile?.columns, dashboard, columnNameToId]
  )
  return { filters, filterChips }
}

/** Active-filters indicator for the WidgetCard top-left rail. */
function WidgetFilterBadge({ chips }: { chips: ReturnType<typeof useWidgetFilters>['filterChips'] }) {
  const { t } = useTranslation()
  if (chips.length === 0) return null
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex size-5 items-center justify-center rounded bg-muted/80 text-muted-foreground backdrop-blur-sm">
            <Filter size={11} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-h-72 max-w-64 overflow-y-auto bg-foreground text-background">
          <p className="mb-1 text-[11px] font-semibold">{t('dashboard.active_filters', { count: chips.length })}</p>
          <div className="space-y-2">
            {chips.map((chip, i) => (
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
  )
}

function WidgetWithData({
  widget,
  dashboard,
  filters,
}: {
  widget: DashboardWidget
  dashboard: Dashboard
  filters: Record<string, FilterValue> | undefined
}) {
  return (
    <DashboardDataProvider
      datasetFileId={widget.datasetFileId ?? null}
      filters={filters}
      reloadOnTabSwitch={dashboard.reloadWidgetsOnTabSwitch === true}
    >
      <div className="relative flex h-full flex-col">
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

/** One widget: resolves its filters (for the data provider + the filter badge), then renders the
 *  card with the badge in its top-left rail. Separate component so the filter hook runs per widget
 *  (hooks can't be called inside the .map callback). */
function WidgetCell({
  widget,
  dashboard,
  activeFilters,
  parentTabId,
  language,
  editMode,
  hideTitleBar,
  canMove,
  onRemove,
  onEdit,
  onConfigure,
  onExport,
  onDuplicate,
  onMove,
  onAcceptPluginVersion,
}: {
  widget: DashboardWidget
  dashboard: Dashboard
  activeFilters: Record<string, FilterValue>
  parentTabId: string | null | undefined
  language: string
  editMode: boolean
  hideTitleBar?: boolean
  canMove: boolean
  onRemove: () => void
  onEdit: () => void
  onConfigure: () => void
  onExport?: () => void
  onDuplicate: () => void
  onMove: () => void
  onAcceptPluginVersion: () => void
}) {
  const { filters, filterChips } = useWidgetFilters(widget, dashboard, activeFilters, parentTabId)
  return (
    <WidgetCard
      title={localized(widget.name, language)}
      description={localized(widget.description, language)}
      onRemove={onRemove}
      onEdit={onEdit}
      onConfigure={onConfigure}
      onExport={onExport}
      onDuplicate={onDuplicate}
      onMove={canMove ? onMove : undefined}
      editMode={editMode}
      hideTitleBar={hideTitleBar}
      stale={isWidgetPluginStale(widget)}
      onAcceptPluginVersion={onAcceptPluginVersion}
      topLeftBadges={filterChips.length > 0 ? <WidgetFilterBadge chips={filterChips} /> : undefined}
    >
      <WidgetWithData widget={widget} dashboard={dashboard} filters={filters} />
    </WidgetCard>
  )
}

export function WidgetGrid({ widgets, editMode, hideTitleBars, dashboard, projectUid, onRequestExport }: WidgetGridProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { updateWidgetLayout, removeWidget, updateWidget, acceptPluginVersion, activeFilters, tabs, moveWidget, duplicateWidget, fitDashboardToHeight } = useDashboardStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1200)
  const [availableHeight, setAvailableHeight] = useState(0)
  // Two distinct widget editors: the config panel (data/plugin) and the metadata dialog (name + description).
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null)
  const [editingMetaWidgetId, setEditingMetaWidgetId] = useState<string | null>(null)
  const [confirmDeleteWidgetId, setConfirmDeleteWidgetId] = useState<string | null>(null)
  const [movingWidgetId, setMovingWidgetId] = useState<string | null>(null)
  const confirmDeleteWidget = confirmDeleteWidgetId ? widgets.find(w => w.id === confirmDeleteWidgetId) ?? null : null
  const movingWidget = movingWidgetId ? widgets.find(w => w.id === movingWidgetId) ?? null : null

  const editingWidget = editingWidgetId ? widgets.find(w => w.id === editingWidgetId) ?? null : null
  const editingMetaWidget = editingMetaWidgetId ? widgets.find(w => w.id === editingMetaWidgetId) ?? null : null

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      // Ignore a 0 width: it means the grid is in a display:none tab (kept mounted for
      // keep-alive). Keeping the last good width avoids a 0-column relayout that would
      // flash when the tab is shown again — the ResizeObserver re-measures on reveal.
      if (el.clientWidth > 0) setContainerWidth(el.clientWidth)
      const viewport = el.closest('[data-slot="scroll-area-viewport"]') ?? el.parentElement
      if (viewport && viewport.clientHeight > 0) setAvailableHeight(viewport.clientHeight)
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
    () => buildDashboardTree(tabs, widgets, dashboard.id, language, true),
    [tabs, widgets, dashboard.id, language],
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
            data-widget-name={localized(widget.name, 'en')}
          >
            <WidgetCell
              widget={widget}
              dashboard={dashboard}
              activeFilters={activeFilters}
              parentTabId={tabParentById.get(widget.tabId)}
              language={language}
              editMode={editMode}
              hideTitleBar={hideTitleBars}
              canMove={canMove}
              onRemove={() => setConfirmDeleteWidgetId(widget.id)}
              onEdit={() => setEditingMetaWidgetId(widget.id)}
              onConfigure={() => setEditingWidgetId(widget.id)}
              onExport={onRequestExport ? () => onRequestExport(widget.id) : undefined}
              onDuplicate={() => duplicateWidget(widget.id)}
              onMove={() => setMovingWidgetId(widget.id)}
              onAcceptPluginVersion={() => acceptPluginVersion(widget.id)}
            />
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

      {editingMetaWidget && (
        <DashboardItemEditDialog
          title={t('dashboard.edit_widget_title')}
          name={editingMetaWidget.name}
          description={editingMetaWidget.description}
          siblingNames={new Set(
            widgets
              .filter((w) => w.id !== editingMetaWidget.id && w.tabId === editingMetaWidget.tabId)
              .map((w) => localized(w.name, language).toLowerCase()),
          )}
          onSave={(changes) => updateWidget(editingMetaWidget.id, changes)}
          onOpenChange={(open) => { if (!open) setEditingMetaWidgetId(null) }}
        />
      )}

      <AlertDialog open={confirmDeleteWidgetId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteWidgetId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dashboard.delete_widget_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard.delete_widget_description', { name: confirmDeleteWidget ? localized(confirmDeleteWidget.name, language) : '' })}
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
          widgetName={localized(movingWidget.name, language)}
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
