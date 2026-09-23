/**
 * Small-cell suppression. A count below the threshold is never shown as itself:
 * its bar is not drawn and its cell reads `<threshold`, so a report cannot become
 * a way to single out a handful of patients. Applied once, when the model is
 * built, so no renderer can forget it.
 */

/** A count as the report may show it: `value` is null when suppressed. */
export interface ReportCount {
  value: number | null
  label: string
}

export const DEFAULT_SUPPRESSION_THRESHOLD = 11

export function suppress(n: number, threshold: number, locale: string): ReportCount {
  // Zero is not re-identifying: it is the absence of anyone, and hiding it would
  // make an empty month look like a small one.
  if (n > 0 && n < threshold) return { value: null, label: `<${threshold}` }
  return { value: n, label: n.toLocaleString(locale) }
}

/**
 * A share of a total, or null when either side is suppressed — a percentage of
 * a hidden count would give the count back.
 */
export function suppressedShare(part: ReportCount, whole: ReportCount, locale: string): string | null {
  if (part.value == null || whole.value == null || whole.value === 0) return null
  return (part.value / whole.value * 100).toLocaleString(locale, { maximumFractionDigits: 1 })
}
