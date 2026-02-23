import { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GridLayout, type LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import {
  usePatientChartStore,
  type PatientChartWidget,
} from '@/stores/patient-chart-store'
import { WidgetCard } from '@/features/projects/dashboard/WidgetCard'
import { PatientSummaryWidget } from './widgets/PatientSummaryWidget'
import { ClinicalTableWidget } from './widgets/ClinicalTableWidget'
import { MedicationWidget } from './widgets/MedicationWidget'
import { DiagnosisWidget } from './widgets/DiagnosisWidget'
import { NotesWidget } from './widgets/NotesWidget'
import { TimelineWidget } from './widgets/TimelineWidget'
import { WarehousePluginWidgetRenderer } from './WarehousePluginWidgetRenderer'
import { ConceptPickerDialog } from './ConceptPickerDialog'
import { WarehousePluginEditorSheet } from './WarehousePluginEditorSheet'
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
  widgets: PatientChartWidget[]
  editMode: boolean
  hideTitleBars?: boolean
  /** When true, grid content can scroll beyond the visible area. */
  scrollable?: boolean
}

/** Widget types that support concept editing. */
const CONCEPT_WIDGET_TYPES = new Set(['clinical_table', 'timeline'])

/** Widget types that support plugin config editing. */
const PLUGIN_WIDGET_TYPES = new Set(['plugin'])

/** Widget types that have an edit button. */
const EDITABLE_WIDGET_TYPES = new Set([...CONCEPT_WIDGET_TYPES, ...PLUGIN_WIDGET_TYPES])

function renderWidgetContent(
  widget: PatientChartWidget,
  onConfigureConcepts?: () => void,
) {
  switch (widget.type) {
    case 'patient_summary':
      return <PatientSummaryWidget />
    case 'clinical_table':
      return <ClinicalTableWidget widgetId={widget.id} onConfigureConcepts={onConfigureConcepts} />
    case 'medications':
      return <MedicationWidget />
    case 'diagnoses':
      return <DiagnosisWidget />
    case 'notes':
      return <NotesWidget widgetId={widget.id} />
    case 'timeline':
      return <TimelineWidget widgetId={widget.id} onConfigureConcepts={onConfigureConcepts} />
    case 'plugin':
      return <WarehousePluginWidgetRenderer widgetId={widget.id} />
    default:
      return (
        <div className="text-xs text-muted-foreground">Unknown widget</div>
      )
  }
}

export const GRID_ROWS = 48
const MARGIN: [number, number] = [8, 8]
const PADDING: [number, number] = [12, 12]

export function PatientChartGrid({
  widgets,
  editMode,
  hideTitleBars,
  scrollable,
}: PatientChartGridProps) {
  const { t } = useTranslation()
  const { updateWidgetLayout, removeWidget, renameWidget, updateWidgetConfig } =
    usePatientChartStore()
  // Outer ref: always overflow-hidden, used to measure available space.
  const measureRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1200)
  const [viewportHeight, setViewportHeight] = useState(800)

  // Concept picker state — lifted here so WidgetCard "Edit" can open it
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null)
  // Plugin config dialog state
  const [editingPluginWidgetId, setEditingPluginWidgetId] = useState<string | null>(null)
  const [confirmDeleteWidgetId, setConfirmDeleteWidgetId] = useState<string | null>(null)
  const confirmDeleteWidget = confirmDeleteWidgetId ? widgets.find(w => w.id === confirmDeleteWidgetId) ?? null : null
  const editingWidget = editingWidgetId
    ? widgets.find((w) => w.id === editingWidgetId)
    : null

  const handleEditWidget = useCallback((widget: PatientChartWidget) => {
    if (CONCEPT_WIDGET_TYPES.has(widget.type)) {
      setEditingWidgetId(widget.id)
    } else if (PLUGIN_WIDGET_TYPES.has(widget.type)) {
      setEditingPluginWidgetId(widget.id)
    }
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
        // In bounded mode, prevent resize beyond the grid bottom.
        ...(scrollable ? {} : { maxH: Math.max(4, GRID_ROWS - w.layout.y) }),
      })),
    [widgets, scrollable],
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
    (ids: number[]) => {
      if (!editingWidget) return
      const config = editingWidget.config as Record<string, unknown>
      updateWidgetConfig(editingWidget.id, { ...config, conceptIds: ids })
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
      autoSize={!!scrollable}
    >
      {widgets.map((widget) => (
        <div key={widget.id}>
          <WidgetCard
            title={widget.name}
            onRemove={() => setConfirmDeleteWidgetId(widget.id)}
            onRename={(name) => renameWidget(widget.id, name)}
            onEdit={
              EDITABLE_WIDGET_TYPES.has(widget.type)
                ? () => handleEditWidget(widget)
                : undefined
            }
            editMode={editMode}
            hideTitleBar={hideTitleBars}
          >
            {renderWidgetContent(
              widget,
              CONCEPT_WIDGET_TYPES.has(widget.type)
                ? () => setEditingWidgetId(widget.id)
                : undefined,
            )}
          </WidgetCard>
        </div>
      ))}
    </GridLayout>
  )

  return (
    <div ref={measureRef} className="w-full h-full overflow-hidden">
      {scrollable ? (
        <ScrollArea className="h-full">
          {gridContent}
        </ScrollArea>
      ) : (
        gridContent
      )}

      {/* Shared concept picker dialog */}
      <ConceptPickerDialog
        open={editingWidgetId !== null}
        onOpenChange={(open) => {
          if (!open) setEditingWidgetId(null)
        }}
        selectedConceptIds={
          (editingWidget?.config as Record<string, unknown>)?.conceptIds as number[] ?? []
        }
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
    </div>
  )
}
