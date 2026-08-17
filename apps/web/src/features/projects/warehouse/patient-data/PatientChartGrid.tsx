import { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GridLayout, type LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import type { PatientDashboardWidget } from '@/types'
import { WidgetCard } from '@/features/projects/dashboard/WidgetCard'
import { PatientSummaryWidget } from './widgets/PatientSummaryWidget'
import { NotesWidget } from './widgets/NotesWidget'
import { TimelineWidget } from './widgets/TimelineWidget'
import { WarehousePluginWidgetRenderer } from './WarehousePluginWidgetRenderer'
import { ConceptPickerDialog } from './ConceptPickerDialog'
import { WarehousePluginEditorSheet } from './WarehousePluginEditorSheet'
import { getPlugin } from '@/lib/plugins/registry'
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
  editMode: boolean
  hideTitleBars?: boolean
}

/** Built-in widgets rendered by a local React component rather than by the plugin
 *  runtime. Anything else is a real plugin and goes through the executor. */
const BUILTIN_PLUGIN_IDS = {
  patientSummary: 'linkr-widget-patient-summary',
  notes: 'linkr-widget-notes',
  timeline: 'linkr-widget-timeline',
} as const

/** Built-in widgets whose config includes a concept selection. */
const CONCEPT_PLUGIN_IDS = new Set<string>([BUILTIN_PLUGIN_IDS.timeline])

function isBuiltin(pluginId: string): boolean {
  return (Object.values(BUILTIN_PLUGIN_IDS) as string[]).includes(pluginId)
}

function renderWidgetContent(
  widget: PatientDashboardWidget,
  onConfigureConcepts?: () => void,
) {
  switch (widget.pluginId) {
    case BUILTIN_PLUGIN_IDS.patientSummary:
      return <PatientSummaryWidget />
    case BUILTIN_PLUGIN_IDS.notes:
      return <NotesWidget widgetId={widget.id} />
    case BUILTIN_PLUGIN_IDS.timeline:
      return <TimelineWidget widgetId={widget.id} onConfigureConcepts={onConfigureConcepts} />
    default:
      return <WarehousePluginWidgetRenderer widgetId={widget.id} />
  }
}

export const GRID_ROWS = 48
const MARGIN: [number, number] = [8, 8]
const PADDING: [number, number] = [12, 12]

export function PatientChartGrid({
  widgets,
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
  const confirmDeleteWidget = confirmDeleteWidgetId ? widgets.find(w => w.id === confirmDeleteWidgetId) ?? null : null
  const editingWidget = editingWidgetId
    ? widgets.find((w) => w.id === editingWidgetId)
    : null

  // Settings schema for the editing concept-widget (drives the dialog's Settings tab).
  const editingWidgetSchema = editingWidget
    ? getPlugin(editingWidget.pluginId)?.manifest.configSchema
    : undefined

  const handleEditWidget = useCallback((widget: PatientDashboardWidget) => {
    if (CONCEPT_PLUGIN_IDS.has(widget.pluginId)) {
      setEditingInitialTab('settings')
      setEditingWidgetId(widget.id)
    } else if (!isBuiltin(widget.pluginId)) {
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
            widget.pluginId === BUILTIN_PLUGIN_IDS.timeline
              ? 'patient-timeline-item'
              : undefined
          }
        >
          <WidgetCard
            title={localized(widget.name, lang)}
            onRemove={() => setConfirmDeleteWidgetId(widget.id)}
            onRename={(name) => renameWidget(widget.id, name)}
            onEdit={
              CONCEPT_PLUGIN_IDS.has(widget.pluginId) || !isBuiltin(widget.pluginId)
                ? () => handleEditWidget(widget)
                : undefined
            }
            editMode={editMode}
            hideTitleBar={hideTitleBars}
          >
            {renderWidgetContent(
              widget,
              CONCEPT_PLUGIN_IDS.has(widget.pluginId)
                ? () => handleConfigureConcepts(widget.id)
                : undefined,
            )}
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
