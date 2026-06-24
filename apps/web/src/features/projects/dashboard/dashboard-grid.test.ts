import { describe, it, expect } from 'vitest'
import { computeFitRows, DASHBOARD_GRID } from './dashboard-grid'

describe('computeFitRows', () => {
  it('returns null when the geometry is unmeasurable', () => {
    expect(computeFitRows(0, 800, 12)).toBeNull()
    expect(computeFitRows(1200, 0, 12)).toBeNull()
  })

  it('fills the visible height: rows×rowHeight + gaps + padding never exceeds it', () => {
    const gap = DASHBOARD_GRID.margin[0]
    const width = 1200
    const height = 800
    const fit = computeFitRows(width, height, gap)
    expect(fit).not.toBeNull()
    const { rows, rowHeight } = fit!
    // Total content height must fit within the available height (top + bottom padding = 2×gap).
    const total = rows * rowHeight + (rows - 1) * gap + gap * 2
    expect(total).toBeLessThanOrEqual(height)
    expect(rows).toBeGreaterThanOrEqual(1)
    expect(rowHeight).toBeGreaterThanOrEqual(4)
  })

  it('produces roughly square cells (row height near column width)', () => {
    const gap = DASHBOARD_GRID.margin[0]
    const width = 1200
    const fit = computeFitRows(width, 800, gap)!
    const colWidth = (width - gap * 2 - gap * (DASHBOARD_GRID.cols - 1)) / DASHBOARD_GRID.cols
    // Within one row of the column width — cells are intended to look square, not exact.
    expect(Math.abs(fit.rowHeight - colWidth)).toBeLessThan(colWidth)
  })
})
