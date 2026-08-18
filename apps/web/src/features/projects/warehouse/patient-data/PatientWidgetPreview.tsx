import { Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { getPlugin } from '@/lib/plugins/registry'
import { getPatientComponent } from '@/lib/plugins/patient-component-registry'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { usePatientChartContext } from './PatientChartContext'
import { widgetFootprint } from '@/features/projects/dashboard/dashboard-grid'
import { measurePatientGridGeometry } from './patient-grid'

interface PatientWidgetPreviewProps {
  pluginId: string
  /** Identifies the widget to per-widget caches. Any stable string works for a
   *  not-yet-created widget — the preview only reads. */
  widgetId: string
  config: Record<string, unknown>
}

/** The widget itself, rendered with the current (draft) config against the selected patient, so
 *  the preview follows edits before they are saved — or before the widget even exists. */
export function PatientWidgetPreview({ pluginId, widgetId, config }: PatientWidgetPreviewProps) {
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const personId = usePatientChartStore((s) => s.selectedPatientId[projectUid] ?? null)
  const visitOccurrenceId = usePatientChartStore((s) => s.selectedVisitId[projectUid] ?? null)
  const visitDetailId = usePatientChartStore((s) => s.selectedVisitDetailId[projectUid] ?? null)
  const { t } = useTranslation()

  const plugin = getPlugin(pluginId)
  const Component = plugin?.componentId ? getPatientComponent(plugin.componentId) : undefined

  if (!personId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        {t('patient_data.select_patient_first')}
      </div>
    )
  }
  if (!Component) return null

  return (
    <Suspense fallback={null}>
      {/* Not created during render: getPatientComponent memoizes one React.lazy per component id. */}
      {/* eslint-disable-next-line react-hooks/static-components */}
      <Component
        config={config}
        widgetId={widgetId}
        dataSourceId={dataSourceId}
        schemaMapping={schemaMapping}
        personId={personId}
        visitOccurrenceId={visitOccurrenceId}
        visitDetailId={visitDetailId}
      />
    </Suspense>
  )
}

interface SizedPatientWidgetPreviewProps extends PatientWidgetPreviewProps {
  /** Grid cells the widget will occupy once added. */
  layout: { w: number; h: number }
  /** Board settings, so the measured geometry matches the board the widget lands on. */
  widgetSpacing?: number
  fitToHeight?: boolean
}

/** Reference width used when no board is on screen to measure (empty tab, headless test). */
const FALLBACK_GRID_WIDTH = 1400
const FALLBACK_ROW_HEIGHT = 14

/**
 * The preview at the widget's REAL on-board footprint, measured from the live patient grid.
 *
 * Patient cells are spaced, so the footprint goes through `widgetFootprint` with this grid's own
 * geometry (margin = widgetSpacing, containerPadding = [12,12]) — the dashboards' jointive
 * `widgetPixelSize` would be wrong here. The box keeps its true pixel size and the pane scrolls
 * when it doesn't fit, rather than distorting the aspect the user will actually get.
 */
export function SizedPatientWidgetPreview({
  layout,
  widgetSpacing,
  fitToHeight,
  ...previewProps
}: SizedPatientWidgetPreviewProps) {
  const { t } = useTranslation()

  const geometry = measurePatientGridGeometry(widgetSpacing, fitToHeight) ?? {
    cols: 48,
    containerWidth: FALLBACK_GRID_WIDTH,
    rowHeight: FALLBACK_ROW_HEIGHT,
    margin: [widgetSpacing ?? 8, widgetSpacing ?? 8] as [number, number],
    containerPadding: [12, 12] as [number, number],
  }
  const size = widgetFootprint(layout.w, layout.h, geometry)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1 text-[10px] text-muted-foreground">
        <span>{t('dashboard.preview_size')}: {size ? `${size.width} × ${size.height} px` : '—'}</span>
        <span className="ml-auto">{layout.w} × {layout.h} {t('dashboard.preview_cells')}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-6">
        <div
          className="overflow-hidden rounded-lg border bg-background shadow-sm"
          style={size ? { width: size.width, height: size.height } : undefined}
        >
          <PatientWidgetPreview {...previewProps} />
        </div>
      </div>
    </div>
  )
}
