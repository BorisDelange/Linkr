import type { GridGeometry } from '@/features/projects/dashboard/dashboard-grid'
import {
  NOTES_PLUGIN_ID,
  PATIENT_SUMMARY_PLUGIN_ID,
  TIMELINE_PLUGIN_ID,
} from '@/lib/plugins/builtin-widget-plugins'

/** Geometry of a patient-data board's react-grid-layout container.
 *
 *  Unlike the dashboards grid (jointive cells flush to the edge), patient cells are SPACED: the
 *  inter-cell gap is a real react-grid-layout `margin` (the board's `widgetSpacing`) and the grid
 *  sits inside a `containerPadding`. Every pixel measurement therefore has to go through
 *  `widgetFootprint`, never the dashboards' `widgetPixelSize`. */
export const PATIENT_GRID_ROWS = 48
export const PATIENT_GRID_COLS = 48
export const PATIENT_DEFAULT_SPACING = 8
export const PATIENT_GRID_PADDING: [number, number] = [12, 12]
/** Rows a non-fitted board scrolls over, instead of squeezing into the viewport. */
export const PATIENT_SCROLL_ROW_HEIGHT = 14

/** Row height that makes PATIENT_GRID_ROWS rows span `viewportHeight` exactly, mirroring the grid's
 *  own computation (the 1px buffer absorbs react-grid-layout's Math.round drift). */
export function patientRowHeight(viewportHeight: number, gap: number): number {
  return Math.max(
    1,
    (viewportHeight - 1 - 2 * PATIENT_GRID_PADDING[1] - (PATIENT_GRID_ROWS - 1) * gap) /
      PATIENT_GRID_ROWS,
  )
}

/** Grid size a freshly added widget gets. MUST stay in step with `defaultWidgetLayouts` in
 *  `stores/patient-chart-store.ts` — that is what `addWidget` actually applies; this mirror only
 *  lets the add dialog preview the widget at the size it is about to land on. */
export function defaultPatientWidgetLayout(pluginId: string): { w: number; h: number } {
  switch (pluginId) {
    case PATIENT_SUMMARY_PLUGIN_ID:
      return { w: 48, h: 24 }
    case TIMELINE_PLUGIN_ID:
      return { w: 48, h: 14 }
    case NOTES_PLUGIN_ID:
      return { w: 48, h: 20 }
    default:
      return { w: 24, h: 14 }
  }
}

/** Measure the live patient board so a preview can be sized to the widget's real footprint.
 *  Returns null when no board is on screen (e.g. the dialog opened from an empty tab). */
export function measurePatientGridGeometry(
  widgetSpacing?: number,
  fitToHeight = true,
): GridGeometry | null {
  if (typeof document === 'undefined') return null
  const viewport = document.querySelector<HTMLElement>(
    '[data-patient-grid] [data-slot="scroll-area-viewport"]',
  )
  if (!viewport) return null
  const gridEl = viewport.querySelector<HTMLElement>('.react-grid-layout')
  const containerWidth = gridEl?.clientWidth ?? viewport.clientWidth
  const height = viewport.clientHeight
  if (containerWidth <= 0 || height <= 0) return null
  const gap = widgetSpacing ?? PATIENT_DEFAULT_SPACING
  return {
    cols: PATIENT_GRID_COLS,
    containerWidth,
    rowHeight: fitToHeight ? patientRowHeight(height, gap) : PATIENT_SCROLL_ROW_HEIGHT,
    margin: [gap, gap],
    containerPadding: PATIENT_GRID_PADDING,
  }
}
