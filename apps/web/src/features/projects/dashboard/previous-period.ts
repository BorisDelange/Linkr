import type { FilterValue } from '@/types'
import { resolveRelativeWindow } from './date-presets'

const DAY_MS = 86_400_000

function parseDay(value: string): number | null {
  const ms = Date.parse(`${value.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(ms) ? null : ms
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Number of calendar months a window covers exactly (1st → last day), else 0. */
function wholeMonths(start: number, end: number): number {
  const s = new Date(start)
  const e = new Date(end)
  const lastDayOfEndMonth = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 0)).getUTCDate()
  if (s.getUTCDate() !== 1 || e.getUTCDate() !== lastDayOfEndMonth) return 0
  return (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + e.getUTCMonth() - s.getUTCMonth() + 1
}

/**
 * The same filters, with the active date window moved back by its own length:
 * a 6-month window gives the 6 months just before it. Every other filter is
 * kept, so the two windows compare like with like.
 *
 * Null when there is nothing to compare against: no date filter, an open-ended
 * one (only `from` or only `to`), or several date filters (which one would move?).
 */
export function previousPeriodFilters(
  filters: Record<string, FilterValue>,
): { filters: Record<string, FilterValue>; from: string; to: string } | null {
  const dated = Object.entries(filters).filter(([, f]) => f.type === 'date' || f.type === 'date-relative')
  if (dated.length !== 1) return null
  const [colId, filter] = dated[0]

  const window = filter.type === 'date-relative'
    ? resolveRelativeWindow(filter.count, filter.unit)
    : filter.type === 'date' && filter.from && filter.to ? { from: filter.from, to: filter.to } : null
  if (!window) return null

  const start = parseDay(window.from)
  const end = parseDay(window.to)
  if (start === null || end === null || end < start) return null

  // A window of whole months (Jul 1 → Dec 31) compares with the same number of
  // whole months before it, whatever their length in days; any other window with
  // the N days before `start` (inclusive bounds).
  const months = wholeMonths(start, end)
  const from = months
    ? formatDay(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() - months, 1))
    : formatDay(start - (end - start + DAY_MS))
  const to = formatDay(start - DAY_MS)
  return { filters: { ...filters, [colId]: { type: 'date', from, to } }, from, to }
}
