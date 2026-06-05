import type { DatasetColumn } from '@/types'

/**
 * Regex matching ISO date (YYYY-MM-DD) and datetime (YYYY-MM-DDTHH:MM:SS) formats,
 * with optional fractional seconds and timezone offset.
 */
export const DATE_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:?\d{2}|Z)?)?$/

const DATETIME_TIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/

/** Recognized truthy/falsy tokens for boolean columns (EN + FR), case-insensitive. */
const BOOL_TRUE = new Set(['true', '1', 'yes', 'y', 't', 'vrai', 'oui', 'o'])
const BOOL_FALSE = new Set(['false', '0', 'no', 'n', 'f', 'faux', 'non'])

/** Map a raw value to true/false if it is a recognized boolean token, else null. */
export function parseBoolean(value: unknown): boolean | null {
  if (value == null) return null
  const s = String(value).trim().toLowerCase()
  if (BOOL_TRUE.has(s)) return true
  if (BOOL_FALSE.has(s)) return false
  return null
}

/** Detect whether date-typed values contain time components (for choosing date vs datetime-local input). */
export function hasTimeComponent(values: unknown[]): boolean {
  for (const v of values) {
    if (v != null && v !== '') {
      if (DATETIME_TIME_RE.test(String(v).trim())) return true
    }
  }
  return false
}

/**
 * Infer a column type from a sample of values.
 * Samples up to 200 non-null values. Priority: boolean > number > date > string.
 */
export function inferColumnType(values: unknown[]): DatasetColumn['type'] {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== '')
  if (nonNull.length === 0) return 'unknown'

  let allNumbers = true
  let allBooleans = true
  let allDates = true

  for (const v of nonNull.slice(0, 200)) {
    const s = String(v).trim()
    if (allNumbers && isNaN(Number(s))) allNumbers = false
    if (allBooleans && parseBoolean(s) === null) allBooleans = false
    if (allDates && !DATE_DATETIME_RE.test(s)) allDates = false
    if (!allNumbers && !allBooleans && !allDates) return 'string'
  }

  if (allBooleans) return 'boolean'
  if (allNumbers) return 'number'
  if (allDates) return 'date'
  return 'string'
}

/** Subtle per-column background tints, alternating with transparent columns for separation. */
export const COLUMN_TINTS = [
  'bg-blue-500/[0.04]',
  '', // transparent
  'bg-violet-500/[0.04]',
  '',
  'bg-emerald-500/[0.04]',
  '',
  'bg-amber-500/[0.04]',
  '',
  'bg-rose-500/[0.04]',
  '',
  'bg-cyan-500/[0.04]',
  '',
]

/** Background tint class for a column at a given index (cycles, every other column transparent). */
export function columnTint(index: number): string {
  return COLUMN_TINTS[index % COLUMN_TINTS.length]
}

/** Build DatasetColumn metadata from raw headers and rows. */
export function buildColumns(
  headers: string[],
  rows: Record<string, unknown>[],
): DatasetColumn[] {
  return headers.map((name, idx) => ({
    id: `col-${Date.now()}-${idx}`,
    name,
    type: inferColumnType(rows.map((r) => r[name])),
    order: idx,
  }))
}
