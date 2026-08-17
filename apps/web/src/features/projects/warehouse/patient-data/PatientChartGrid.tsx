import { useMemo, useCallback, useRef, useEffect, useState, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { GridLayout, type LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import type { PatientDashboardTab, PatientDashboardWidget } from '@/types'
import { MoveWidgetDialog } from '@/features/projects/dashboard/MoveWidgetDialog'
import { DashboardItemEditDialog } from '@/features/projects/dashboard/DashboardItemEditDialog'
import type { DashboardTreeRow } from '@/features/projects/dashboard/dashboard-tree'
import { WidgetCard } from '@/features/projects/dashboard/WidgetCard'
import { WarehousePluginWidgetRenderer } from './WarehousePluginWidgetRenderer'
import { ConceptPickerDialog } from './ConceptPickerDialog'
import { WarehousePluginEditorSheet } from './WarehousePluginEditorSheet'
import { getPlugin } from '@/lib/plugins/registry'
import { getPatientComponent } from '@/lib/plugins/patient-component-registry'
import { TIMELINE_PLUGIN_ID } from '@/lib/plugins/builtin-widget-plugins'
import { usePatientChartContext } from './PatientChartContext'
import { localized } from '@/lib/localized'
import { ScrollArea } from '@/components/ui/scroll-area'
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

interface PatientChartGridProps {
  widgets: PatientDashboardWidget[]
  /** Every tab of the current board — the Move dialog's destinations. */
  tabs: PatientDashboardTab[]
  editMode: boolean
  hideTitleBars?: boolean
}

/** Renders a widget from its plugin id: a component plugin through the patient
 *  component registry, anything else (script plugin) through the executor. Nothing
 *  is hard-coded per widget type — a custom patient-data plugin renders the same way. */
/** Renders one component-runtime patient plugin. Split out so the registry lookup
 *  is this component's own body, not a component created during another's render. */
function PatientComponentWidget({
  widget,
  componentId,
  onConfigureConcepts,
}: {
  widget: PatientDashboardWidget
  componentId: string
  onConfigureConcepts?: () => void
}) {
  const { dataSourceId, schemaMapping, projectUid } = usePatientChartContext()
  const personId = usePatientChartStore((s) => s.selectedPatientId[projectUid] ?? null)
  const visitOccurrenceId = usePatientChartStore((s) => s.selectedVisitId[projectUid] ?? null)
  const visitDetailId = usePatientChartStore(
    (s) => s.selectedVisitDetailId[projectUid] ?? null,
  )

  // The registry memoizes one React.lazy per id, so this is a stable identity.
  const Component = getPatientComponent(componentId)
  if (!Component) return <WarehousePluginWidgetRenderer widgetId={widget.id} />

  return (
    <Suspense fallback={null}>
      {/* Not created during render: getPatientComponent memoizes one React.lazy
          per component id, so this identity is stable across renders. */}
      {/* eslint-disable-next-line react-hooks/static-components */}
      <Component
        config={widget.config}
        widgetId={widget.id}
        dataSourceId={dataSourceId}
        schemaMapping={schemaMapping}
        personId={personId}
        visitOccurrenceId={visitOccurrenceId}
        visitDetailId={visitDetailId}
        onConfigureConcepts={onConfigureConcepts}
      />
    </Suspense>
  )
}

function WidgetContent({
  widget,
  onConfigureConcepts,
}: {
  widget: PatientDashboardWidget
  onConfigureConcepts?: () => void
}) {
  const plugin = getPlugin(widget.pluginId)
  if (!plugin) {
    return (
      <div className="p-2 text-xs text-muted-foreground">
        {`Plugin not found: ${widget.pluginId}`}
      </div>
    )
  }
  if (!plugin.componentId) return <WarehousePluginWidgetRenderer widgetId={widget.id} />
  return (
    <PatientComponentWidget
      widget={widget}
      componentId={plugin.componentId}
      onConfigureConcepts={onConfigureConcepts}
    />
  )
}

/** Whether this widget's config includes a concept selection (manifest-declared). */
function needsConcepts(pluginId: string): boolean {
  return getPlugin(pluginId)?.manifest.needsConceptPicker ?? false
}

/** A component plugin is configured in place; a script plugin opens the editor sheet. */
function isComponentPlugin(pluginId: string): boolean {
  return Boolean(getPlugin(pluginId)?.componentId)
}

export const GRID_ROWS = 48
const MARGIN: [number, number] = [8, 8]
const PADDING: [number, number] = [12, 12]

export function PatientChartGrid({
  widgets,
  tabs,
  editMode,
  hideTitleBars,
}: PatientChartGridProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  // Narrow selectors: a bare usePatientChartStore() re-renders every widget on the
  // grid whenever a patient or visit is selected.
  const updateWidgetLayout = usePatientChartStore((s) => s.updateWidgetLayout)
  const removeWidget = usePatientChartStore((s) => s.removeWidget)
  const renameWidget = usePatientChartStore((s) => s.renameWidget)
  const updateWidgetConfig = usePatientChartStore((s) => s.updateWidgetConfig)
  const updateWidget = usePatientChartStore((s) => s.updateWidget)
  const duplicateWidget = usePatientChartStore((s) => s.duplicateWidget)
  const moveWidget = usePatientChartStore((s) => s.moveWidget)
  // Outer ref: always overflow-hidden, used to measure available space.
  const measureRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1200)
  const [viewportHeight, setViewportHeight] = useState(800)

  // Concept picker state — lifted here so WidgetCard "Edit" can open it.
  // `editingInitialTab` lets the empty-state "Select concepts" button jump
  // straight to the Concepts tab, while the kebab "Edit" opens Settings first.
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null)
  const [editingInitialTab, setEditingInitialTab] = useState<'settings' | 'concepts'>('settings')
  // Plugin config dialog state
  const [editingPluginWidgetId, setEditingPluginWidgetId] = useState<string | null>(null)
  const [confirmDeleteWidgetId, setConfirmDeleteWidgetId] = useState<string | null>(null)
  const [movingWidgetId, setMovingWidgetId] = useState<string | null>(null)
  const [editingMetaWidgetId, setEditingMetaWidgetId] = useState<string | null>(null)
  const movingWidget = movingWidgetId
    ? (widgets.find((w) => w.id === movingWidgetId) ?? null)
    : null
  const editingMetaWidget = editingMetaWidgetId
    ? (widgets.find((w) => w.id === editingMetaWidgetId) ?? null)
    : null

  // Reuses the dashboard's Move dialog: a patient board's tabs are flat, so every
  // tab is a valid destination (no container rows to exclude).
  const moveRows: DashboardTreeRow[] = useMemo(
    () =>
      [...tabs]
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((tab) => ({
          kind: 'tab' as const,
          id: tab.id,
          name: localized(tab.name, lang),
          depth: 0,
        })),
    [tabs, lang],
  )
  const confirmDeleteWidget = confirmDeleteWidgetId ? widgets.find(w => w.id === confirmDeleteWidgetId) ?? null : null
  const editingWidget = editingWidgetId
    ? widgets.find((w) => w.id === editingWidgetId)
    : null

  // Settings schema for the editing concept-widget (drives the dialog's Settings tab).
  const editingWidgetSchema = editingWidget
    ? getPlugin(editingWidget.pluginId)?.manifest.configSchema
    : undefined

  const handleEditWidget = useCallback((widget: PatientDashboardWidget) => {
    if (needsConcepts(widget.pluginId)) {
      setEditingInitialTab('settings')
      setEditingWidgetId(widget.id)
    } else if (!isComponentPlugin(widget.pluginId)) {
      setEditingPluginWidgetId(widget.id)
    }
  }, [])

  const handleConfigureConcepts = useCallback((widgetId: string) => {
    setEditingInitialTab('concepts')
    setEditingWidgetId(widgetId)
  }, [])

  // Measure the outer (bounded) container for both width and height.
  useEffect(() => {
    if (!measureRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
        setViewportHeight(entry.contentRect.height)
      }
    })
    observer.observe(measureRef.current)
    setContainerWidth(measureRef.current.clientWidth)
    setViewportHeight(measureRef.current.clientHeight)
    return () => observer.disconnect()
  }, [])

  // Dynamic row height: h:48 ≈ full visible height.
  // Subtract a small buffer (1px) to compensate for Math.round in react-grid-layout
  // position calculations that can add fractional pixels.
  const rowHeight = Math.max(1, (viewportHeight - 1 - 2 * PADDING[1] - (GRID_ROWS - 1) * MARGIN[1]) / GRID_ROWS)

  const layout: LayoutItem[] = useMemo(
    () =>
      widgets.map((w) => ({
        i: w.id,
        x: w.layout.x,
        y: w.layout.y,
        w: w.layout.w,
        h: w.layout.h,
        minW: 4,
        minH: 4,
      })),
    [widgets],
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
    },
    [widgets, updateWidgetLayout],
  )

  const handleConceptsConfirm = useCallback(
    (config: Record<string, unknown>) => {
      if (!editingWidget) return
      updateWidgetConfig(editingWidget.id, config)
      setEditingWidgetId(null)
    },
    [editingWidget, updateWidgetConfig],
  )

  const gridContent = (
    <GridLayout
      layout={layout}
      width={containerWidth}
      gridConfig={{
        cols: 48,
        rowHeight: rowHeight,
        margin: MARGIN,
        containerPadding: PADDING,
      }}
      dragConfig={{
        enabled: editMode,
      }}
      resizeConfig={{
        enabled: editMode,
      }}
      onLayoutChange={handleLayoutChange}
      autoSize
    >
      {widgets.map((widget) => (
        <div
          key={widget.id}
          // Timeline's follow-legend can spill past the card; raise the grid
          // item on hover so it stacks above sibling widgets (each react-grid
          // item is its own transformed stacking context).
          className={
            widget.pluginId === TIMELINE_PLUGIN_ID ? 'patient-timeline-item' : undefined
          }
        >
          <WidgetCard
            title={localized(widget.name, lang)}
            onRemove={() => setConfirmDeleteWidgetId(widget.id)}
            onRename={(name) => renameWidget(widget.id, name)}
            // Same split as dashboards: Edit is name+description, Configure is
            // the widget's own settings (concepts / plugin config).
            onEdit={() => setEditingMetaWidgetId(widget.id)}
            onConfigure={
              needsConcepts(widget.pluginId) || !isComponentPlugin(widget.pluginId)
                ? () => handleEditWidget(widget)
                : undefined
            }
            onDuplicate={() => duplicateWidget(widget.id)}
            // Only offered when there is somewhere else to move it to.
            onMove={tabs.length > 1 ? () => setMovingWidgetId(widget.id) : undefined}
            editMode={editMode}
            hideTitleBar={hideTitleBars}
          >
            <WidgetContent
              widget={widget}
              onConfigureConcepts={
                needsConcepts(widget.pluginId)
                  ? () => handleConfigureConcepts(widget.id)
                  : undefined
              }
            />
          </WidgetCard>
        </div>
      ))}
    </GridLayout>
  )

  return (
    <div ref={measureRef} className="w-full h-full overflow-hidden">
      <ScrollArea className="h-full">
        {gridContent}
      </ScrollArea>

      {/* Shared concept picker dialog */}
      <ConceptPickerDialog
        open={editingWidgetId !== null}
        onOpenChange={(open) => {
          if (!open) setEditingWidgetId(null)
        }}
        config={
          (editingWidget?.config as Record<string, unknown>) ?? { conceptIds: [] }
        }
        schema={editingWidgetSchema}
        initialTab={editingInitialTab}
        onConfirm={handleConceptsConfirm}
      />

      {/* Plugin editor sidebar */}
      <WarehousePluginEditorSheet
        widgetId={editingPluginWidgetId}
        open={editingPluginWidgetId !== null}
        onOpenChange={(open) => {
          if (!open) setEditingPluginWidgetId(null)
        }}
      />

      {movingWidget && (
        <MoveWidgetDialog
          open
          onOpenChange={(open) => { if (!open) setMovingWidgetId(null) }}
          widgetName={localized(movingWidget.name, lang)}
          currentTabId={movingWidget.tabId}
          rows={moveRows}
          onMove={(tabId) => {
            moveWidget(movingWidget.id, tabId)
            setMovingWidgetId(null)
          }}
        />
      )}

      {editingMetaWidget && (
        <DashboardItemEditDialog
          title={t('dashboard.edit_widget_title')}
          name={editingMetaWidget.name}
          description={editingMetaWidget.description}
          siblingNames={new Set(
            widgets
              .filter(
                (w) =>
                  w.id !== editingMetaWidget.id && w.tabId === editingMetaWidget.tabId,
              )
              .map((w) => localized(w.name, lang).toLowerCase()),
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
              {t('dashboard.delete_widget_description', { name: confirmDeleteWidget ? localized(confirmDeleteWidget.name, lang) : '' })}
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
    </div>
  )
}
