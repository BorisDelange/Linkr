import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { widgetFootprint } from '@/features/projects/dashboard/dashboard-grid'
import {
  PATIENT_GRID_COLS,
  PATIENT_GRID_PADDING,
  PATIENT_GRID_ROWS,
  defaultPatientWidgetLayout,
  patientRowHeight,
} from './patient-grid'

describe('patientRowHeight', () => {
  it('the 48 rows plus their margins and the padding span the viewport', () => {
    for (const [height, gap] of [[800, 8], [1200, 0], [1440, 24]] as const) {
      const rh = patientRowHeight(height, gap)
      const spanned =
        PATIENT_GRID_ROWS * rh + (PATIENT_GRID_ROWS - 1) * gap + 2 * PATIENT_GRID_PADDING[1]
      // 1px buffer against react-grid-layout's Math.round drift, so the board never overflows.
      expect(spanned).toBeCloseTo(height - 1, 6)
    }
  })

  // Below that, the 1px floor takes over and the board scrolls rather than collapsing.
  it('never collapses to zero on an unmeasured or tiny viewport', () => {
    expect(patientRowHeight(0, 8)).toBeGreaterThan(0)
    expect(patientRowHeight(100, 24)).toBeGreaterThan(0)
  })
})

describe('defaultPatientWidgetLayout', () => {
  // The store owns the real map; this mirror only sizes the add dialog's preview. If they drift,
  // the preview lies about the footprint the widget lands on.
  it('mirrors defaultWidgetLayouts in the patient chart store', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../stores/patient-chart-store.ts', import.meta.url)),
      'utf8',
    )
    const block = source.match(/defaultWidgetLayouts[^=]*=\s*\{([^}]*\}[^}]*)\}/)?.[1]
    expect(block).toBeDefined()
    const entries = [...block!.matchAll(/'([^']+)':\s*\{\s*w:\s*(\d+),\s*h:\s*(\d+)\s*\}/g)]
    expect(entries.length).toBeGreaterThan(0)
    for (const [, id, w, h] of entries) {
      expect(defaultPatientWidgetLayout(id)).toEqual({ w: Number(w), h: Number(h) })
    }
    const fallback = source.match(/defaultWidgetLayouts\[pluginId\]\s*\?\?\s*\{\s*w:\s*(\d+),\s*h:\s*(\d+)\s*\}/)
    expect(fallback).not.toBeNull()
    expect(defaultPatientWidgetLayout('some-custom-plugin')).toEqual({
      w: Number(fallback![1]),
      h: Number(fallback![2]),
    })
  })

  it('a full-width default fills the board content box exactly', () => {
    const geometry = {
      cols: PATIENT_GRID_COLS,
      containerWidth: 1440,
      rowHeight: 14,
      margin: [8, 8] as [number, number],
      containerPadding: PATIENT_GRID_PADDING,
    }
    const { w, h } = defaultPatientWidgetLayout('linkr-widget-timeline')
    expect(w).toBe(PATIENT_GRID_COLS)
    const box = widgetFootprint(w, h, geometry)!
    expect(box.width).toBe(1440 - 2 * PATIENT_GRID_PADDING[0])
    expect(box.height).toBe(h * 14 + (h - 1) * 8)
  })
})
