import { describe, it, expect } from 'vitest'
import { computeFitRows, fitTabLayouts, DASHBOARD_GRID, colWidthFor } from './dashboard-grid'

const box = (id: string, y: number, h: number, x = 0, w = 48) => ({ id, layout: { x, y, w, h } })
const bottom = (m: Map<string, { y: number; h: number }>) =>
  Math.max(...[...m.values()].map((l) => l.y + l.h))

describe('fitTabLayouts', () => {
  it('two stacked widgets filling the height: enlarging the top one keeps the column at maxRows', () => {
    // Stack already fills 20 rows (10 + 10). User dragged the top one to h=11 → stack would be 21.
    const widgets = [box('top', 0, 11), box('bottom', 11, 10)]
    const fitted = fitTabLayouts(widgets, 20)
    // The column must land exactly on maxRows, not one row over.
    expect(bottom(fitted)).toBe(20)
    // No overlap: bottom.y must equal top's bottom edge.
    const top = fitted.get('top')!
    const bot = fitted.get('bottom')!
    expect(bot.y).toBe(top.y + top.h)
    // The bottom widget absorbs the extra row (shrinks), the top keeps (most of) its growth.
    expect(top.h).toBeGreaterThanOrEqual(10)
  })

  it('always lands exactly on maxRows for a single full-height column', () => {
    for (const widgets of [
      [box('a', 0, 25)],
      [box('a', 0, 8), box('b', 8, 8), box('c', 16, 8)],
      [box('a', 0, 30), box('b', 30, 30)],
    ]) {
      const fitted = fitTabLayouts(widgets, 20)
      expect(bottom(fitted)).toBe(20)
    }
  })

  it('never overlaps and respects the 2-row minimum height', () => {
    const widgets = [box('a', 0, 18), box('b', 18, 18), box('c', 36, 18)]
    const fitted = fitTabLayouts(widgets, 20)
    const lays = [...fitted.values()].sort((p, q) => p.y - q.y)
    for (const l of lays) expect(l.h).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < lays.length; i++) expect(lays[i].y).toBeGreaterThanOrEqual(lays[i - 1].y + lays[i - 1].h)
  })

  it('leaves side-by-side columns independent', () => {
    // Two columns: left full, right short. Only the column that overflows is scaled.
    const widgets = [box('l', 0, 30, 0, 24), box('r', 0, 10, 24, 24)]
    const fitted = fitTabLayouts(widgets, 20)
    expect(fitted.get('l')!.y + fitted.get('l')!.h).toBe(20)
    expect(fitted.get('r')!.y + fitted.get('r')!.h).toBe(20) // grown to fill its column
  })
})

describe('computeFitRows', () => {
  it('returns null when the geometry is unmeasurable', () => {
    expect(computeFitRows(0, 800)).toBeNull()
    expect(computeFitRows(1200, 0)).toBeNull()
  })

  it('fills the visible height exactly (fractional row height; no leftover band or clipped cell)', () => {
    for (const height of [600, 800, 1040, 1440]) {
      const fit = computeFitRows(1200, height)
      expect(fit).not.toBeNull()
      const { rows, rowHeight } = fit!
      // Jointive cells flush to the edge: rows × rowHeight spans the full height (no gap, no padding).
      const total = rows * rowHeight
      expect(total).toBeCloseTo(height, 5)
      expect(rows).toBeGreaterThanOrEqual(1)
      expect(rowHeight).toBeGreaterThanOrEqual(4)
    }
  })

  it('produces roughly square cells (row height near column width)', () => {
    const width = 1200
    const fit = computeFitRows(width, 800)!
    const colWidth = colWidthFor(width)
    // Within one row of the column width — cells are intended to look square, not exact.
    expect(Math.abs(fit.rowHeight - colWidth)).toBeLessThan(colWidth)
  })
})
