import { toIsoDay, fromIsoDay } from '@/components/ui/date-picker-field'

/**
 * A date range filter driven by a slider works in whole days counted from the
 * column's earliest value, so the slider stays an integer scale whatever the span.
 *
 * Every conversion goes through the local-date helpers in date-picker-field, so a
 * day never shifts across a timezone boundary.
 */

const MS_PER_DAY = 86_400_000

/** Whole days from `from` to `to`, both read as local days. Negative when `to` precedes `from`. */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = fromIsoDay(fromIso)
  const b = fromIsoDay(toIso)
  if (!a || !b) return 0
  // Compare at midday so a DST transition can't round the difference to the wrong day.
  const aNoon = new Date(a.getFullYear(), a.getMonth(), a.getDate(), 12).getTime()
  const bNoon = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 12).getTime()
  return Math.round((bNoon - aNoon) / MS_PER_DAY)
}

/** The ISO day `offset` days after `baseIso`. */
export function addDays(baseIso: string, offset: number): string {
  const base = fromIsoDay(baseIso)
  if (!base) return baseIso
  return toIsoDay(new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset))
}

/** Trim a stats value like "2020-01-05 00:00:00" (or an ISO datetime) to its day. */
export function toDayBound(value: string | null | undefined): string | null {
  if (!value) return null
  const day = String(value).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

export interface DateBounds {
  min: string
  max: string
}

/** Both bounds as days, or null when either is missing or they are inverted. */
export function parseBounds(
  min: string | null | undefined,
  max: string | null | undefined,
): DateBounds | null {
  const lo = toDayBound(min)
  const hi = toDayBound(max)
  if (!lo || !hi || daysBetween(lo, hi) < 0) return null
  return { min: lo, max: hi }
}

/**
 * Slider positions [from, to] for a filter value, clamped into the bounds. An unset
 * end defaults to that end of the range, so a half-open filter still shows a handle.
 */
export function valueToSlider(
  bounds: DateBounds,
  from: string | null,
  to: string | null,
): [number, number] {
  const span = daysBetween(bounds.min, bounds.max)
  const clamp = (n: number) => Math.max(0, Math.min(span, n))
  return [
    from ? clamp(daysBetween(bounds.min, from)) : 0,
    to ? clamp(daysBetween(bounds.min, to)) : span,
  ]
}

/**
 * Slider positions back to a filter value. A range covering the whole span means
 * "no restriction", so both ends come back null and the filter reads as inactive
 * rather than as a redundant window over all the data.
 */
export function sliderToValue(
  bounds: DateBounds,
  [start, end]: [number, number],
): { from: string | null; to: string | null } {
  const span = daysBetween(bounds.min, bounds.max)
  return {
    from: start <= 0 ? null : addDays(bounds.min, start),
    to: end >= span ? null : addDays(bounds.min, end),
  }
}
