/**
 * Small-count masking of a mapping project's source-concepts.csv on export.
 *
 * A mapping project is what travels from an SPE to the global instance, which
 * holds no patient data: whatever leaves in `source-concepts.csv` must carry no
 * count under the threshold and no single patient's value. Twin of
 * `apps/api/app/services/export_masking.py` — both must emit the same bytes, or
 * a front-only and a server client pushing the same repo would fight over the
 * file. The rule is documented there.
 */
import Papa from 'papaparse'
import type { FileColumnMapping } from '@/types'

/** The threshold a server instance applies by default (LINKR_EXPORT_MIN_COUNT). */
export const EXPORT_MIN_COUNT = 11

let exportMinCount = EXPORT_MIN_COUNT

/** The instance's threshold, read from the server at boot: the exports the
 *  browser builds must mask like the ones the server builds. */
export function setExportMinCount(k: number): void {
  if (Number.isInteger(k) && k >= 1) exportMinCount = k
}

const JSON_HEADERS = ['info_json', 'metadata_json', 'json_metadata']
const EXTREMES = new Set(['min', 'max'])

type Json = Record<string, unknown>

function isSmall(value: unknown, k: number): boolean {
  if (value == null || value === '' || typeof value === 'boolean') return false
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && n < k
}

function impliedSmall(percentage: unknown, total: unknown, k: number): boolean {
  if (percentage == null || total == null || percentage === '' || total === '') return false
  return isSmall((Number(percentage) / 100) * Number(total), k)
}

/** A mapping's source frequency as it may leave the instance: a small one is
 *  unknown (null) — the field is a number, so it cannot read "<k". */
export function maskFrequency<T>(value: T, k: number = exportMinCount): T | null {
  return isSmall(value, k) ? null : value
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The profile as it may leave the instance, or null to withhold it. */
export function maskProfile(profile: Json, k: number): Json | null {
  if (isSmall(profile.patients_count, k) || isSmall(profile.rows_count, k)) return null
  const out: Json = { ...profile }
  delete out.range
  for (const key of ['numeric_data', 'records_per_patient']) {
    const block = out[key]
    if (isObject(block)) {
      out[key] = Object.fromEntries(Object.entries(block).filter(([name]) => !EXTREMES.has(name)))
    }
  }
  const total = profile.rows_count
  if (Array.isArray(out.histogram)) {
    out.histogram = out.histogram.filter((b) => !(isObject(b) && isSmall(b.count, k)))
  }
  if (Array.isArray(out.categorical_data)) {
    out.categorical_data = out.categorical_data.filter((c) => !(isObject(c) && (
      isSmall(c.count, k) || (!('count' in c) && impliedSmall(c.percentage, total, k))
    )))
  }
  if (Array.isArray(out.hospital_units)) {
    out.hospital_units = out.hospital_units.filter((u) => !(isObject(u) && impliedSmall(u.percentage, total, k)))
  }
  const temporal = out.temporal_distribution
  if (isObject(temporal) && Array.isArray(temporal.by_year)) {
    out.temporal_distribution = {
      ...temporal,
      by_year: temporal.by_year.filter((y) => !(isObject(y) && impliedSmall(y.percentage, total, k))),
    }
  }
  return out
}

function cell(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function columnIndex(headers: string[], mapped: string | undefined, guesses: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase())
  if (mapped && lower.includes(mapped.trim().toLowerCase())) return lower.indexOf(mapped.trim().toLowerCase())
  for (const name of guesses) if (lower.includes(name)) return lower.indexOf(name)
  return -1
}

/** `text` with every cell the rule masks rewritten; unchanged when nothing is. */
export function maskSourceConceptsCsv(
  text: string,
  columnMapping?: Partial<FileColumnMapping> | null,
  k: number = exportMinCount,
): string {
  if (k <= 1 || !text || text.startsWith('version https://git-lfs')) return text
  const firstLine = text.split('\n', 1)[0]
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best)
  const parsed = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false })
  const rows = parsed.data
  if (text.endsWith('\n') && rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop()
  }
  if (rows.length === 0) return text
  const mapping = columnMapping ?? {}
  const headers = rows[0]
  const recordIdx = columnIndex(headers, mapping.recordCountColumn, ['record_count', 'rows_count'])
  const patientIdx = columnIndex(headers, mapping.patientCountColumn, ['patient_count', 'patients_count'])
  const jsonIdx = columnIndex(headers, mapping.infoJsonColumn, JSON_HEADERS)
  const countIdx = [recordIdx, patientIdx].filter((i) => i >= 0)
  if (countIdx.length === 0 && jsonIdx < 0) return text

  let changed = false
  for (const cells of rows.slice(1)) {
    const withheld = countIdx.some((i) => i < cells.length && isSmall(cells[i], k))
    for (const i of countIdx) {
      if (i < cells.length && isSmall(cells[i], k)) {
        cells[i] = `<${k}`
        changed = true
      }
    }
    if (jsonIdx >= 0 && jsonIdx < cells.length && cells[jsonIdx].trim()) {
      let profile: unknown
      try {
        profile = JSON.parse(cells[jsonIdx])
      } catch {
        continue
      }
      if (!isObject(profile)) continue
      const masked = withheld ? null : maskProfile(profile, k)
      const next = masked === null ? '' : JSON.stringify(masked)
      if (masked === null || next !== JSON.stringify(profile)) {
        cells[jsonIdx] = next
        changed = true
      }
    }
  }
  if (!changed) return text
  const body = rows.map((cells) => cells.map((c) => cell(c, delimiter)).join(delimiter)).join('\n')
  return text.endsWith('\n') ? `${body}\n` : body
}
