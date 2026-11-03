import type { DataTableAggregate } from '@/lib/duckdb/patient-datatable-queries'

/** A time window, in ms. */
export interface DataTableWindow {
  lo: number
  hi: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The window cut in `n` equal columns. */
export function columnsOf(window: DataTableWindow, n: number): { index: number; lo: number; hi: number }[] {
  const width = (window.hi - window.lo) / n
  return Array.from({ length: n }, (_, index) => ({ index, lo: window.lo + index * width, hi: window.lo + (index + 1) * width }))
}

/** A column's width as one reads it: "6 h", "2 d", "45 min". */
export function durationLabel(ms: number, locale: string): string {
  const fmt = (v: number, unit: string) => `${v.toLocaleString(locale, { maximumFractionDigits: 1 })} ${unit}`
  if (ms >= DAY) return fmt(ms / DAY, 'd')
  if (ms >= HOUR) return fmt(ms / HOUR, 'h')
  return fmt(Math.max(ms, 0) / MINUTE, 'min')
}

/** A column's start, as precise as its width needs: the day for a day or more,
 *  the time within the day below. */
export function columnStartLabel(ms: number, width: number, locale: string): string {
  const d = new Date(ms)
  if (width >= DAY) return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' })
  return d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** A column's span, for its tooltip. */
export function periodLabel(lo: number, hi: number, width: number, locale: string): string {
  return `${columnStartLabel(lo, width, locale)} – ${columnStartLabel(hi, width, locale)}`
}

/** What a cell shows: the count for `count`, the value (or its text) otherwise. */
export function formatCell(cell: { value: number | null; text: string | null; n: number }, aggregate: DataTableAggregate, locale: string): string {
  if (aggregate === 'count') return cell.n.toLocaleString(locale)
  if (cell.value == null) return cell.text ?? '—'
  const digits = Math.abs(cell.value) >= 100 ? 0 : Math.abs(cell.value) >= 10 ? 1 : 2
  return cell.value.toLocaleString(locale, { maximumFractionDigits: digits })
}
