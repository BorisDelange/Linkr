import { describe, it, expect } from 'vitest'
import {
  numericRatio,
  classifySeries,
  pickRenderer,
  resolveRenderer,
  type SeriesShapeResult,
} from './timeline-shape'

// The classification decides which renderer the user gets, so it is worth
// pinning down. The shapes below are the ones real records produce: a charted
// vital (numeric every row), a categorical observation (numeric in none), and an
// infusion (numeric, but lasting — a span, not a reading).

const series = (over: Partial<Parameters<typeof classifySeries>[0]>) =>
  classifySeries({
    conceptId: 1,
    values: [],
    timestamps: [],
    durational: false,
    ...over,
  })

describe('numericRatio', () => {
  it('reports a fully numeric series', () => {
    expect(numericRatio([83, 90, 101])).toBe(1)
  })

  it('reports a fully categorical series', () => {
    expect(numericRatio(['Sinus Rhythm', 'Atrial Fib'])).toBe(0)
  })

  it('reads numeric strings as numbers, which is how SQL often returns them', () => {
    expect(numericRatio(['83', '90'])).toBe(1)
  })

  it('ignores blanks rather than counting them against the series', () => {
    // A vital with a few empty cells is still a vital.
    expect(numericRatio([83, null, '', undefined, 90])).toBe(1)
  })

  it('has no evidence either way when every value is empty', () => {
    expect(numericRatio([null, undefined, '  '])).toBe(0)
  })

  it('handles the bigint DuckDB returns for wide integer columns', () => {
    expect(numericRatio([10n, 20n])).toBe(1)
  })

  it('rejects the non-finite values a bad cast produces', () => {
    expect(numericRatio([NaN, Infinity])).toBe(0)
  })
})

describe('classifySeries', () => {
  it('draws a dense numeric series as a line', () => {
    expect(series({ values: [83, 90, 101], timestamps: [1, 2, 3] }).shape).toBe('line')
  })

  it('draws a numeric series with too few points as marks', () => {
    // Two points make a segment that reads as a trend the record does not show.
    expect(series({ values: [83, 90], timestamps: [1, 2] }).shape).toBe('points')
  })

  it('draws a categorical series as marks', () => {
    const r = series({ values: ['Sinus Rhythm', 'Atrial Fib'], timestamps: [1, 2, 3] })
    expect(r.shape).toBe('points')
    expect(r.numeric).toBe(false)
  })

  it('draws an event that lasts as a bar, even though its value is numeric', () => {
    const r = series({ values: [50, 100], timestamps: [1, 2, 3], durational: true })
    expect(r.shape).toBe('bars')
    expect(r.numeric).toBe(true)
  })

  it('tolerates stray junk in an otherwise numeric column', () => {
    const values = [...Array(19).fill(80), 'ERROR']
    expect(series({ values, timestamps: [1, 2, 3] }).shape).toBe('line')
  })

  it('does not call a genuinely mixed series numeric', () => {
    const values = [80, 90, 'Sinus Rhythm', 'Atrial Fib']
    expect(series({ values, timestamps: [1, 2, 3] }).numeric).toBe(false)
  })
})

describe('pickRenderer', () => {
  const line = (id: number): SeriesShapeResult => ({ conceptId: id, shape: 'line', numeric: true })
  const marks = (id: number): SeriesShapeResult => ({ conceptId: id, shape: 'points', numeric: false })
  const bars = (id: number): SeriesShapeResult => ({ conceptId: id, shape: 'bars', numeric: true })

  it('uses dygraphs while every series is a continuous measurement', () => {
    expect(pickRenderer([line(1), line(2)])).toBe('dygraphs')
  })

  it('moves to the overview renderer as soon as one series is categorical', () => {
    expect(pickRenderer([line(1), marks(2)])).toBe('overview')
  })

  it('moves to the overview renderer for events that last', () => {
    // Dygraph has no way to draw a span: a four-hour infusion would become a dot.
    expect(pickRenderer([line(1), bars(2)])).toBe('overview')
  })

  it('defaults to dygraphs when there is nothing to draw yet', () => {
    // An empty timeline has always been a dygraph; switching on the first rows
    // would make the widget flicker as data arrives.
    expect(pickRenderer([])).toBe('dygraphs')
  })
})

describe('resolveRenderer', () => {
  const mixed: SeriesShapeResult[] = [
    { conceptId: 1, shape: 'line', numeric: true },
    { conceptId: 2, shape: 'points', numeric: false },
  ]

  it('derives the renderer when set to auto', () => {
    expect(resolveRenderer('auto', mixed)).toBe('overview')
  })

  it('derives the renderer when unset, which is what old configs hold', () => {
    expect(resolveRenderer(undefined, mixed)).toBe('overview')
  })

  it('honours an explicit choice over the heuristic', () => {
    // The escape hatch: auto must never be a dead end on an unusual schema.
    expect(resolveRenderer('dygraphs', mixed)).toBe('dygraphs')
    expect(resolveRenderer('overview', [])).toBe('overview')
  })
})
