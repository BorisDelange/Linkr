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
import { TimelineWidget } from './widgets/TimelineWidget'
import { ClinicalTableWidget } from './widgets/ClinicalTableWidget'
import { MedicationWidget } from './widgets/MedicationWidget'
import { DiagnosisWidget } from './widgets/DiagnosisWidget'
import { ConceptPickerDialog } from './ConceptPickerDialog'
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
}

/** Widget types that support concept editing. */
const CONCEPT_WIDGET_TYPES = new Set(['timeline', 'clinical_table'])

function renderWidgetContent(
  widget: PatientChartWidget,
  onConfigureConcepts?: () => void,
) {
  switch (widget.type) {
    case 'patient_summary':
      return <PatientSummaryWidget />
    case 'timeline':
      return <TimelineWidget widgetId={widget.id} onConfigureConcepts={onConfigureConcepts} />
    case 'clinical_table':
      return <ClinicalTableWidget widgetId={widget.id} onConfigureConcepts={onConfigureConcepts} />
    case 'medications':
      return <MedicationWidget />
    case 'diagnoses':
      return <DiagnosisWidget />
    default:
      return (
        <div className="text-xs text-muted-foreground">Unknown widget</div>
      )
  }
}

export function PatientChartGrid({
  widgets,
  editMode,
  hideTitleBars,
}: PatientChartGridProps) {
  const { t } = useTranslation()
  const { updateWidgetLayout, removeWidget, updateWidgetConfig } =
    usePatientChartStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1200)

  // Concept picker state — lifted here so WidgetCard "Edit" can open it
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null)
  const [confirmDeleteWidgetId, setConfirmDeleteWidgetId] = useState<string | null>(null)
  const confirmDeleteWidget = confirmDeleteWidgetId ? widgets.find(w => w.id === confirmDeleteWidgetId) ?? null : null
  const editingWidget = editingWidgetId
    ? widgets.find((w) => w.id === editingWidgetId)
    : null

  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(containerRef.current)
    setContainerWidth(containerRef.current.clientWidth)
    return () => observer.disconnect()
  }, [])

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
    (ids: number[]) => {
      if (!editingWidget) return
      const config = editingWidget.config as Record<string, unknown>
      updateWidgetConfig(editingWidget.id, { ...config, conceptIds: ids })
      setEditingWidgetId(null)
    },
    [editingWidget, updateWidgetConfig],
  )

  return (
    <div ref={containerRef} className="w-full">
      <GridLayout
        layout={layout}
        width={containerWidth}
        gridConfig={{
          cols: 24,
          rowHeight: 40,
          margin: [12, 12] as [number, number],
          containerPadding: [16, 16] as [number, number],
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
          <div key={widget.id}>
            <WidgetCard
              title={widget.name}
              onRemove={() => setConfirmDeleteWidgetId(widget.id)}
              onEdit={
                CONCEPT_WIDGET_TYPES.has(widget.type)
                  ? () => setEditingWidgetId(widget.id)
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
