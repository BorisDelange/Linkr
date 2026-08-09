import type { SchemaMapping } from '@/types/schema-mapping'
import type { TFunction } from 'i18next'

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

/** Format a date string as locale-aware YYYY-MM-DD (en) or DD/MM/YYYY (fr). */
export function formatDate(d: string | undefined, lang: string): string {
  if (!d) return '—'
  try {
    const dt = new Date(d)
    if (lang === 'fr') {
      return dt.toLocaleDateString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit' })
    }
    const y = dt.getFullYear()
    const m = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    return `${y}-${m}-${dd}`
  } catch {
    return d ?? '—'
  }
}

/** Short date: MM-DD (en) or DD/MM (fr). */
export function formatDateShort(d: string | undefined, lang: string): string {
  if (!d) return '—'
  try {
    const dt = new Date(d)
    if (lang === 'fr') {
      return dt.toLocaleDateString('fr-FR', { month: '2-digit', day: '2-digit' })
    }
    const m = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    return `${m}-${dd}`
  } catch {
    return d ?? '—'
  }
}

/** Short date+time for clinical tables. */
export function formatDateTime(d: string): string {
  try {
    return new Date(d).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return d
  }
}

// ---------------------------------------------------------------------------
// Gender formatting
// ---------------------------------------------------------------------------

/** Format a gender concept value to a localized label. */
export function formatGender(
  gender: string | undefined,
  genderValues: SchemaMapping['genderValues'],
  t: TFunction,
): string {
  if (!gender || !genderValues) return gender ?? '—'
  if (gender === genderValues.male) return t('patient_data.male')
  if (gender === genderValues.female) return t('patient_data.female')
  return gender
}

/** Short gender label (M/F). */
export function formatGenderShort(
  gender: string | undefined,
  genderValues: SchemaMapping['genderValues'],
  t: TFunction,
): string {
  if (!gender || !genderValues) return gender ?? '—'
  if (gender === genderValues.male) return t('patient_data.male_short')
  if (gender === genderValues.female) return t('patient_data.female_short')
  return gender
}

// ---------------------------------------------------------------------------
// Time math
// ---------------------------------------------------------------------------

/** Compute days between two date strings. Returns null if either is missing. */
export function daysBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime()
    return Math.round(ms / (1000 * 60 * 60 * 24))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Label formatting
// ---------------------------------------------------------------------------

/** Capitalize a snake_case key into a display label (e.g. "concept_name" → "Concept Name"). */
export function columnLabel(id: string): string {
  return id
    .replace(/^_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Capitalize first letter of a string. */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Abbreviated count for narrow columns: 1234 -> "1.2k", 33278686 -> "33M".
 * A row count printed in full ("33,278,686") eats the width a table name needs.
 */
export function compactCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1_000
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`
  }
  const m = n / 1_000_000
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`
}

/**
 * Human-readable byte size, scaling the unit to the value: a 30 KB file shown in
 * MB rounds to "0.0 MB" and reads as empty.
 */
export function humanBytes(n: number | undefined): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// SQL escaping
// ---------------------------------------------------------------------------

/**
 * Escape a string value for use in a SQL single-quoted literal.
 * Handles single quotes, backslashes, and NUL bytes.
 */
export function escSql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '')
}

/**
 * Validate that a value is a safe SQL identifier (column/table name).
 * Only allows alphanumeric, underscore, and dot characters.
 */
export function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(name)
}

/**
 * Validate that all values in an array are finite numbers.
 * Use before joining IDs into an IN (...) clause.
 */
export function validateIntegerIds(ids: number[]): boolean {
  return ids.every((id) => Number.isFinite(id) && Number.isInteger(id))
}

/**
 * Sort so `2_x` precedes `10_x` — script and dictionary files are numbered, and
 * a plain string sort scrambles them (`10` before `2`).
 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}
