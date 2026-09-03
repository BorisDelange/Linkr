/**
 * Turning dataset rows into the periods a control chart plots.
 *
 * This is where the clinically wrong answers come from, far more than from the
 * limit formulas. Three traps, all of which the hand-written R scripts hit at
 * some point:
 *
 * - **The denominator is not always a row count.** For a device-associated
 *   infection the population at risk is "patients with a line in place", counted
 *   in device-days, not "patients admitted". See `DenominatorMode`.
 * - **A long stay spans periods.** A 90-day stay contributes patient-days to
 *   three consecutive months. Summing a per-stay length into the admission month
 *   attributes all of it to one month and understates the others.
 * - **The denominator needs rows the numerator filter removes.** Filtering the
 *   dataset down to infection rows and then counting patient-days over what is
 *   left gives a denominator of only the infected patients. The numerator is
 *   filtered; the denominator must not be.
 */

import type { DenominatorMode, Period, PeriodPoint, StatisticType } from './spc-types'

/** Parse a date-ish cell to a UTC midnight timestamp, or null. */
export function parseDate(value: unknown): number | null {
  if (value == null) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : startOfDay(value.getTime())
  const text = String(value).trim()
  if (!text) return null
  // Take the leading YYYY-MM-DD: values arrive as dates, ISO timestamps, or
  // "2024-03-01 08:12:00", and only the day matters for bucketing.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : startOfDay(parsed)
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

const DAY_MS = 86400000

/** ISO date (YYYY-MM-DD) of a timestamp. */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Start of the calendar bucket containing `ms`. Weeks start on Monday (ISO). */
export function floorToPeriod(ms: number, period: Period): number {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth()
  switch (period) {
    case 'day':
      return Date.UTC(y, mo, d.getUTCDate())
    case 'week': {
      // getUTCDay: 0=Sunday. Shift so Monday is the first day of the week.
      const dow = (d.getUTCDay() + 6) % 7
      return Date.UTC(y, mo, d.getUTCDate() - dow)
    }
    case 'month':
      return Date.UTC(y, mo, 1)
    case 'quarter':
      return Date.UTC(y, Math.floor(mo / 3) * 3, 1)
    case 'year':
      return Date.UTC(y, 0, 1)
  }
}

/** Start of the period after the one containing `ms`. */
export function nextPeriod(ms: number, period: Period): number {
  const d = new Date(floorToPeriod(ms, period))
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth()
  switch (period) {
    case 'day':
      return ms + DAY_MS
    case 'week':
      return floorToPeriod(ms, period) + 7 * DAY_MS
    case 'month':
      return Date.UTC(y, mo + 1, 1)
    case 'quarter':
      return Date.UTC(y, mo + 3, 1)
    case 'year':
      return Date.UTC(y + 1, 0, 1)
  }
}

/** Every period start from the first to the last, with no gaps. */
export function periodGrid(fromMs: number, toMs: number, period: Period): number[] {
  const out: number[] = []
  let cursor = floorToPeriod(fromMs, period)
  const end = floorToPeriod(toMs, period)
  // Bound the loop: a corrupt date could otherwise spin for millions of buckets.
  for (let guard = 0; cursor <= end && guard < 20000; guard++) {
    out.push(cursor)
    cursor = nextPeriod(cursor, period)
  }
  return out
}

export function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const n = Number(String(value).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export interface AggregateOptions {
  rows: Record<string, unknown>[]
  statisticType: StatisticType
  dateColumn: string
  period: Period
  /** Column holding the event flag, or the measured quantity. */
  valueColumn: string
  /** Which values of `valueColumn` count as the event (categorical numerator). */
  eventValues?: string[]
  denominatorMode: DenominatorMode
  /** Per-stay duration column, for `exposure-column`. */
  exposureColumn?: string
  /** Stay boundaries, for `patient-days`. */
  admissionColumn?: string
  dischargeColumn?: string
  /** Device boundaries, for `device-days`. */
  deviceStartColumn?: string
  deviceEndColumn?: string
  /** One row per entity (e.g. `visit_id`) before counting. */
  deduplicateBy?: string
  /** How to aggregate a measurement within a period. */
  aggregation?: 'mean' | 'median' | 'sum' | 'min' | 'max'
  /**
   * Rows to compute the denominator over, when the numerator is filtered.
   * Defaults to `rows` — pass the unfiltered dataset for a rate whose
   * denominator must span every stay, not only the ones with an event.
   */
  denominatorRows?: Record<string, unknown>[]
}

function dedupe(rows: Record<string, unknown>[], key?: string): Record<string, unknown>[] {
  if (!key) return rows
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []
  for (const row of rows) {
    const id = row[key]
    if (id == null) continue
    const k = String(id)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(row)
  }
  return out
}

function aggregateValues(values: number[], how: NonNullable<AggregateOptions['aggregation']>): number {
  if (values.length === 0) return 0
  switch (how) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length
    case 'median': {
      const sorted = [...values].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }
  }
}

/** Sample variance; undefined below two observations. */
function variance(values: number[]): number | undefined {
  if (values.length < 2) return undefined
  const m = values.reduce((a, b) => a + b, 0) / values.length
  return values.reduce((a, b) => a + (b - m) * (b - m), 0) / (values.length - 1)
}

function isEvent(cell: unknown, eventValues?: string[]): boolean {
  if (cell == null) return false
  if (!eventValues || eventValues.length === 0) {
    // No explicit modality: treat a truthy numeric flag as the event.
    const n = toNumber(cell)
    if (n !== null) return n !== 0
    const s = String(cell).toLowerCase()
    return s === 'true' || s === 'yes' || s === 'oui'
  }
  return eventValues.includes(String(cell))
}

/**
 * Sum, per period, the days each interval overlaps that period.
 *
 * The `+1` makes a stay admitted and discharged the same day count as one day
 * rather than zero — matching how bed-days are counted in practice. An interval
 * with no end is clipped to `openEnd` (the last date observed anywhere in the
 * data) rather than dropped, since an ongoing stay is still occupying a bed.
 */
export function overlapDaysByPeriod(
  intervals: { start: number; end: number | null }[],
  grid: number[],
  period: Period,
  openEnd: number,
): Map<number, number> {
  const out = new Map<number, number>()
  for (const bucket of grid) {
    const bucketEnd = nextPeriod(bucket, period) - DAY_MS
    let days = 0
    for (const iv of intervals) {
      const end = iv.end ?? openEnd
      const from = Math.max(iv.start, bucket)
      const to = Math.min(end, bucketEnd)
      if (to >= from) days += (to - from) / DAY_MS + 1
    }
    out.set(bucket, days)
  }
  return out
}

function collectIntervals(
  rows: Record<string, unknown>[],
  startCol: string,
  endCol: string | undefined,
): { start: number; end: number | null }[] {
  const out: { start: number; end: number | null }[] = []
  for (const row of rows) {
    const start = parseDate(row[startCol])
    if (start === null) continue
    out.push({ start, end: endCol ? parseDate(row[endCol]) : null })
  }
  return out
}

/**
 * Aggregate rows into periods, ready for a limit builder.
 *
 * Periods whose denominator is 0 are dropped: their statistic is undefined, and
 * plotting them as zero would invent an in-control point where there is no
 * information at all.
 */
export function aggregate(opts: AggregateOptions): PeriodPoint[] {
  const {
    rows,
    statisticType,
    dateColumn,
    period,
    valueColumn,
    eventValues,
    denominatorMode,
    exposureColumn,
    admissionColumn,
    dischargeColumn,
    deviceStartColumn,
    deviceEndColumn,
    deduplicateBy,
    aggregation = 'median',
    denominatorRows,
  } = opts

  const numeratorRows = dedupe(rows, deduplicateBy)
  const denomRows = dedupe(denominatorRows ?? rows, deduplicateBy)

  const dated = numeratorRows
    .map(row => ({ row, ms: parseDate(row[dateColumn]) }))
    .filter((r): r is { row: Record<string, unknown>; ms: number } => r.ms !== null)
  if (dated.length === 0) return []

  // A measurement chart aggregates the values themselves; there is no event
  // count and no external denominator.
  if (statisticType === 'measurement') {
    const buckets = new Map<number, number[]>()
    for (const { row, ms } of dated) {
      const v = toNumber(row[valueColumn])
      if (v === null) continue
      const b = floorToPeriod(ms, period)
      const list = buckets.get(b)
      if (list) list.push(v)
      else buckets.set(b, [v])
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ms, values]) => ({
        date: isoDate(ms),
        y: aggregateValues(values, aggregation),
        n: values.length,
        variance: variance(values),
      }))
  }

  const events = new Map<number, number>()
  for (const { row, ms } of dated) {
    if (!isEvent(row[valueColumn], eventValues)) continue
    const b = floorToPeriod(ms, period)
    events.set(b, (events.get(b) ?? 0) + 1)
  }

  // The denominator drives which periods exist: a period with exposure but no
  // event is a real zero and must be plotted, whereas a period with neither is
  // simply outside the observation window.
  let denominators: Map<number, number>

  if (denominatorMode === 'patient-days' || denominatorMode === 'device-days') {
    const startCol = denominatorMode === 'patient-days' ? admissionColumn : deviceStartColumn
    const endCol = denominatorMode === 'patient-days' ? dischargeColumn : deviceEndColumn
    if (!startCol) return []
    const intervals = collectIntervals(denomRows, startCol, endCol)
    if (intervals.length === 0) return []
    const starts = intervals.map(i => i.start)
    const ends = intervals.map(i => i.end).filter((e): e is number => e !== null)
    const openEnd = Math.max(...(ends.length ? ends : starts), ...dated.map(d => d.ms))
    const grid = periodGrid(Math.min(...starts), openEnd, period)
    denominators = overlapDaysByPeriod(intervals, grid, period, openEnd)
  } else if (denominatorMode === 'exposure-column') {
    if (!exposureColumn) return []
    denominators = new Map()
    for (const row of denomRows) {
      const ms = parseDate(row[dateColumn])
      const v = toNumber(row[exposureColumn])
      if (ms === null || v === null) continue
      const b = floorToPeriod(ms, period)
      denominators.set(b, (denominators.get(b) ?? 0) + v)
    }
  } else {
    denominators = new Map()
    for (const row of denomRows) {
      const ms = parseDate(row[dateColumn])
      if (ms === null) continue
      const b = floorToPeriod(ms, period)
      denominators.set(b, (denominators.get(b) ?? 0) + 1)
    }
  }

  return [...denominators.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([ms, n]) => ({ date: isoDate(ms), y: events.get(ms) ?? 0, n }))
}

/**
 * Intervals between consecutive events, for a g-chart (days between).
 *
 * Returns one point per event after the first — an interval needs two events to
 * exist. Same-day repeat events give an interval of 0, which is meaningful (a
 * cluster) and is kept rather than filtered.
 */
export function eventIntervals(
  rows: Record<string, unknown>[],
  dateColumn: string,
  valueColumn: string,
  eventValues?: string[],
  deduplicateBy?: string,
): PeriodPoint[] {
  const stamps = dedupe(rows, deduplicateBy)
    .filter(row => isEvent(row[valueColumn], eventValues))
    .map(row => parseDate(row[dateColumn]))
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b)

  const out: PeriodPoint[] = []
  for (let i = 1; i < stamps.length; i++) {
    out.push({ date: isoDate(stamps[i]), y: (stamps[i] - stamps[i - 1]) / DAY_MS, n: 1 })
  }
  return out
}
