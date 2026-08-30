/**
 * How an event's value, unit, duration and rate are written.
 *
 * Shared by the patient overview and the timeline so a figure reads the same
 * wherever it appears: the same rounding, the same unit placement, the same
 * "dose · rate" for an infusion.
 */

import { hourlyRate, unitIsRate } from './overview-layout'

/**
 * A measured value, rounded to something a person can read.
 *
 * Two decimals is enough for any clinical figure, and raw floats are the problem
 * this solves — a rate stored as 0.0833333333 prints ten digits of noise.
 * Very small and very large numbers go to exponential rather than rounding to
 * "0" or filling the tooltip.
 */
export function fmtValue(v: number): string {
  const a = Math.abs(v)
  if (a !== 0 && (a < 0.01 || a >= 1e6)) return v.toExponential(2)
  return String(Math.round(v * 100) / 100)
}

/** A duration, in the largest unit that keeps it readable. */
export function fmtDuration(ms: number): string {
  const m = ms / 60_000
  if (m < 1) return '<1 min'
  if (m < 60) return `${Math.round(m)} min`
  const h = m / 60
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`
  return `${(h / 24).toFixed(1)} d`
}

/** A timestamp, to the minute. */
export function fmtStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

/**
 * The value line for one event: the figure with its unit, and for something
 * infused, the average rate beside it.
 *
 * Dose and rate read as one fact — "500 mg · 55.56 mg/h" — because for an
 * infusion neither answers the question alone. A value already expressed per
 * hour is NOT divided by the duration a second time; that prints a confidently
 * wrong "mL/h".
 *
 * Returns the categorical text when there is no number, and null when there is
 * nothing to show at all.
 */
export function fmtEventValue(
  value: number | null,
  text: string | null,
  unit: string | null | undefined,
  startMs: number,
  endMs: number | null,
): string | null {
  if (value == null) return text || null
  const suffix = unit ? ` ${unit}` : ''
  const total = `${fmtValue(value)}${suffix}`
  const rate = hourlyRate(value, startMs, endMs)
  if (rate == null || unitIsRate(unit)) return total
  return `${total} · ${fmtValue(rate)} ${unit ? `${unit}/h` : '/h'}`
}

/** When an event happened: an instant, or a span with its duration. */
export function fmtEventWhen(startMs: number, endMs: number | null): string {
  return endMs != null
    ? `${fmtStamp(startMs)} → ${fmtStamp(endMs)} · ${fmtDuration(endMs - startMs)}`
    : fmtStamp(startMs)
}
