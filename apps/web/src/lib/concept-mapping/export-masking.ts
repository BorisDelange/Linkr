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

/** Thrown when source-concepts bytes cannot be read, hence cannot be masked:
 *  the file is then not exported at all rather than exported as it is. */
export class SourceConceptsUnreadableError extends Error {
  constructor() {
    super('The source concepts file is neither UTF-8 nor Windows-1252 text nor readable Parquet: it cannot be masked, so it is not exported.')
    this.name = 'SourceConceptsUnreadableError'
  }
}

// The five bytes Windows-1252 leaves undefined: TextDecoder maps them to C1
// controls where Python's cp1252 codec refuses them, so both sides refuse them.
const CP1252_UNDEFINED = /[\x81\x8d\x8f\x90\x9d]/

/** Source bytes as text — UTF-8, else Windows-1252 (the usual export of a French
 *  hospital's spreadsheet) — or null when they are not text at all. */
export function decodeSourceText(buf: Uint8Array): string | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    text = new TextDecoder('windows-1252').decode(buf)
    if (CP1252_UNDEFINED.test(text)) return null
  }
  return text.includes('\0') ? null : text
}

// Plain decimal only, read alike by both sides: Number() also takes "0x5" and
// Python's float() "1_0", so a looser parse masked a cell on one side only.
const NUMBER_TEXT = /^[0-9]+(\.[0-9]+)?$/

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return NaN
  const text = value.replace(/^[ \t]+|[ \t]+$/g, '')
  return NUMBER_TEXT.test(text) ? Number(text) : NaN
}

function isSmall(value: unknown, k: number): boolean {
  const n = toNumber(value)
  return Number.isFinite(n) && n > 0 && n < k
}

/** Percentages are rounded to one decimal, so the count is taken at the lowest
 *  the rounding allows — and 0.0% may still hide a few records. */
function impliedCount(percentage: unknown, total: unknown): number {
  return (Math.max(0, toNumber(percentage) - 0.05) / 100) * toNumber(total)
}

/** A mapping's source frequency as it may leave the instance: a small one is
 *  unknown (null) — the field is a number, so it cannot read "<k". */
export function maskFrequency<T>(value: T, k: number = exportMinCount): T | null {
  return isSmall(value, k) ? null : value
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * `entries` without the small ones. When what was dropped totals under k, the
 * total minus the kept entries would give it back, so the smallest kept entries
 * go too until the dropped mass reaches k (secondary suppression).
 */
function suppress(entries: unknown[], small: (e: Json) => boolean, mass: (e: Json) => number, k: number): unknown[] {
  const dropped = (e: unknown) => isObject(e) && small(e)
  const weight = (e: unknown) => {
    const m = isObject(e) ? mass(e) : NaN
    return Number.isFinite(m) ? m : 0
  }
  const kept = entries.filter((e) => !dropped(e))
  if (kept.length === entries.length) return kept
  let droppedMass = 0
  for (const e of entries) if (dropped(e)) droppedMass += weight(e)
  while (droppedMass < k && kept.length > 0) {
    let smallest = 0
    for (let i = 1; i < kept.length; i++) if (weight(kept[i]) < weight(kept[smallest])) smallest = i
    droppedMass += weight(kept.splice(smallest, 1)[0])
  }
  return kept
}

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
  const counted = (e: Json) => toNumber(e.count)
  const implied = (e: Json) => impliedCount(e.percentage, total)
  if (Array.isArray(out.histogram)) {
    out.histogram = suppress(out.histogram, (b) => isSmall(b.count, k), counted, k)
  }
  if (Array.isArray(out.categorical_data)) {
    const mass = (c: Json) => ('count' in c ? counted(c) : implied(c))
    out.categorical_data = suppress(out.categorical_data, (c) => ('count' in c ? isSmall(c.count, k) : mass(c) < k), mass, k)
  }
  if (Array.isArray(out.hospital_units)) {
    out.hospital_units = suppress(out.hospital_units, (u) => implied(u) < k, implied, k)
  }
  const temporal = out.temporal_distribution
  if (isObject(temporal)) {
    // The first and last dates are one patient's event each.
    const { start_date: _start, end_date: _end, ...rest } = temporal
    out.temporal_distribution = Array.isArray(rest.by_year)
      ? { ...rest, by_year: suppress(rest.by_year, (y) => implied(y) < k, implied, k) }
      : rest
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
  if (text.startsWith('\uFEFF')) text = text.slice(1)
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
      let profile: unknown = null
      try {
        profile = JSON.parse(cells[jsonIdx])
      } catch {
        // Unreadable here may be readable elsewhere (Python takes NaN): withheld.
      }
      const masked = withheld || !isObject(profile) ? null : maskProfile(profile, k)
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
