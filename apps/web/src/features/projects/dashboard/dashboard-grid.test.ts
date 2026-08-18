import { describe, it, expect } from 'vitest'
import { computeFitRows, fitTabLayouts, gridBackgroundStyle, widgetFootprint, FIT_ROWS } from './dashboard-grid'

const box = (id: string, y: number, h: number, x = 0, w = 48) => ({ id, layout: { x, y, w, h } })
const bottom = (m: Map<string, { y: number; h: number }>) =>
  Math.max(...[...m.values()].map((l) => l.y + l.h))

describe('fitTabLayouts', () => {
  it('two stacked widgets filling the height: enlarging the top one keeps the column at maxRows', () => {
    // Stack already fills 20 rows (10 + 10). User dragged the top one to h=11 → stack would be 21.
    const widgets = [box('top', 0, 11), box('bottom', 11, 10)]
    const fitted = fitTabLayouts(widgets, 20, 'fill')
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
      const fitted = fitTabLayouts(widgets, 20, 'fill')
      expect(bottom(fitted)).toBe(20)
    }
  })

  it('never overlaps and respects the 2-row minimum height', () => {
    const widgets = [box('a', 0, 18), box('b', 18, 18), box('c', 36, 18)]
    const fitted = fitTabLayouts(widgets, 20, 'fill')
    const lays = [...fitted.values()].sort((p, q) => p.y - q.y)
    for (const l of lays) expect(l.h).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < lays.length; i++) expect(lays[i].y).toBeGreaterThanOrEqual(lays[i - 1].y + lays[i - 1].h)
  })

  it('leaves side-by-side columns independent', () => {
    // Two columns: left full, right short. Only the column that overflows is scaled.
    const widgets = [box('l', 0, 30, 0, 24), box('r', 0, 10, 24, 24)]
    const fitted = fitTabLayouts(widgets, 20, 'fill')
    expect(fitted.get('l')!.y + fitted.get('l')!.h).toBe(20)
    expect(fitted.get('r')!.y + fitted.get('r')!.h).toBe(20) // grown to fill its column
  })

  it('shrink-only: a stack that fits is returned untouched (no compacting, no growing)', () => {
    // Two half-height widgets side by side, well within maxRows. A drag/resize must not reflow or
    // re-stretch them: heights and positions stay exactly as the user left them.
    const widgets = [box('a', 0, 8, 0, 24), box('b', 2, 8, 24, 24)]
    const fitted = fitTabLayouts(widgets, 20, 'shrink-only')
    expect(fitted.get('a')).toEqual({ x: 0, y: 0, w: 24, h: 8 })
    expect(fitted.get('b')).toEqual({ x: 24, y: 2, w: 24, h: 8 })
  })

  it('shrink-only: an actual vertical overflow is trimmed to land exactly on maxRows (no empty row)', () => {
    // One column overflows (10 + 14 = 24 > 20). The trim must close the rounding slack so the stack
    // lands EXACTLY on maxRows — an over-tall resize must not leave an empty cell at the bottom.
    const widgets = [box('top', 0, 10), box('bottom', 10, 14)]
    const fitted = fitTabLayouts(widgets, 20, 'shrink-only')
    expect(bottom(fitted)).toBe(20)
    expect(fitted.get('bottom')!.h).toBeLessThan(14)
  })
})

describe('gridBackgroundStyle', () => {
  // react-grid-layout's own placement maths (calcGridColWidth / calcGridItemPosition), which the
  // backdrop has to line up with.
  const rglColWidth = (g: Parameters<typeof gridBackgroundStyle>[0]) =>
    (g.containerWidth - g.margin[0] * (g.cols - 1) - g.containerPadding[0] * 2) / g.cols
  const rglLeft = (g: Parameters<typeof gridBackgroundStyle>[0], x: number) =>
    (rglColWidth(g) + g.margin[0]) * x + g.containerPadding[0]
  const rglTop = (g: Parameters<typeof gridBackgroundStyle>[0], y: number) =>
    (g.rowHeight + g.margin[1]) * y + g.containerPadding[1]
  const px = (v: unknown, i: number) => parseFloat(String(v).split(' ')[i])

  const geometries = [
    // Dashboards: jointive cells, flush to the edge.
    { cols: 48, containerWidth: 1200, rowHeight: 20, margin: [0, 0] as [number, number], containerPadding: [0, 0] as [number, number] },
    // Patient boards, fit-to-height and scrolling, across the widgetSpacing range.
    { cols: 48, containerWidth: 1440, rowHeight: 13.7, margin: [8, 8] as [number, number], containerPadding: [12, 12] as [number, number] },
    { cols: 48, containerWidth: 900, rowHeight: 14, margin: [0, 0] as [number, number], containerPadding: [12, 12] as [number, number] },
    { cols: 48, containerWidth: 2560, rowHeight: 22.5, margin: [24, 24] as [number, number], containerPadding: [12, 12] as [number, number] },
  ]

  it('lines land exactly on every cell edge react-grid-layout places a widget at', () => {
    for (const g of geometries) {
      const style = gridBackgroundStyle(g)!
      expect(style).toBeDefined()
      const [pitchX, pitchY] = [px(style.backgroundSize, 0), px(style.backgroundSize, 1)]
      const [originX, originY] = [px(style.backgroundPosition, 0), px(style.backgroundPosition, 1)]
      for (const i of [0, 1, 7, 24, 47]) {
        expect(originX + pitchX * i).toBeCloseTo(rglLeft(g, i), 6)
        expect(originY + pitchY * i).toBeCloseTo(rglTop(g, i), 6)
      }
    }
  })

  it('the last column line closes on the container edge (no half cell left over)', () => {
    for (const g of geometries) {
      const style = gridBackgroundStyle(g)!
      const pitchX = px(style.backgroundSize, 0)
      const originX = px(style.backgroundPosition, 0)
      // Right edge of the last cell = containerWidth − padding.
      expect(originX + pitchX * g.cols - g.margin[0]).toBeCloseTo(g.containerWidth - g.containerPadding[0], 6)
    }
  })

  it('returns undefined before the container is measured', () => {
    expect(gridBackgroundStyle({ cols: 48, containerWidth: 0, rowHeight: 20, margin: [0, 0], containerPadding: [0, 0] })).toBeUndefined()
    expect(gridBackgroundStyle({ cols: 48, containerWidth: 1200, rowHeight: 0, margin: [0, 0], containerPadding: [0, 0] })).toBeUndefined()
  })
})

describe('widgetFootprint', () => {
  // The patient-data grid: spaced cells (margin = widgetSpacing) inside a padded container.
  const patient = (containerWidth: number, rowHeight: number, gap: number) => ({
    cols: 48,
    containerWidth,
    rowHeight,
    margin: [gap, gap] as [number, number],
    containerPadding: [12, 12] as [number, number],
  })

  it('a full-width widget spans the whole content box, padding excluded', () => {
    for (const gap of [0, 8, 24]) {
      const g = patient(1440, 14, gap)
      const box = widgetFootprint(48, 10, g)!
      expect(box.width).toBe(1440 - 2 * 12)
    }
  })

  it('two half-width widgets plus one margin fill the same content box', () => {
    const g = patient(1200, 14, 8)
    const half = widgetFootprint(24, 5, g)!
    expect(half.width * 2 + g.margin[0]).toBeCloseTo(1200 - 2 * 12, 0)
  })

  it('height counts the margins between rows, not around them', () => {
    const g = patient(1200, 20, 8)
    expect(widgetFootprint(24, 1, g)!.height).toBe(20)
    expect(widgetFootprint(24, 4, g)!.height).toBe(4 * 20 + 3 * 8)
  })

  it('matches the jointive dashboard cell footprint when margin and padding are zero', () => {
    const g = { cols: 48, containerWidth: 1200, rowHeight: 20, margin: [0, 0] as [number, number], containerPadding: [0, 0] as [number, number] }
    expect(widgetFootprint(12, 6, g)).toEqual({ width: (1200 / 48) * 12, height: 120 })
  })

  it('returns null before the container is measured', () => {
    expect(widgetFootprint(24, 10, patient(0, 14, 8))).toBeNull()
    expect(widgetFootprint(24, 10, patient(1200, 0, 8))).toBeNull()
  })
})

describe('computeFitRows', () => {
  it('returns null only when the height is unmeasurable (width is irrelevant — row count is fixed)', () => {
    expect(computeFitRows(1200, 0)).toBeNull()
    // Width no longer affects the vertical geometry: a measurable height alone is enough.
    expect(computeFitRows(0, 800)).not.toBeNull()
  })

  it('keeps a fixed row count and fills the visible height exactly at every viewport height', () => {
    for (const height of [600, 800, 1040, 1440]) {
      const fit = computeFitRows(1200, height)
      expect(fit).not.toBeNull()
      const { rows, rowHeight } = fit!
      // The row COUNT is constant; rowHeight stretches so the rows span the full height exactly.
      expect(rows).toBe(FIT_ROWS)
      expect(rows * rowHeight).toBeCloseTo(height, 5)
      expect(rowHeight).toBeGreaterThanOrEqual(4)
    }
  })

  it('row count is independent of width (proportions survive a horizontal resize)', () => {
    expect(computeFitRows(800, 900)!.rows).toBe(computeFitRows(1600, 900)!.rows)
    // Same height → same rowHeight regardless of width, so widget heights keep their proportion.
    expect(computeFitRows(800, 900)!.rowHeight).toBeCloseTo(computeFitRows(1600, 900)!.rowHeight, 5)
  })
})
