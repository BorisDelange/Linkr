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

/** The threshold a server instance applies by default (LINKR_EXPORT_MIN_COUNT),
 *  and the one a client-only (WASM) deployment always uses. */
export const EXPORT_MIN_COUNT = 11

let exportMinCount = EXPORT_MIN_COUNT

/** The instance's threshold, read from the server at boot: the exports the
 *  browser builds must mask like the ones the server builds — k ≤ 1 masking
 *  nothing on both sides. */
export function setExportMinCount(k: number): void {
  if (Number.isInteger(k)) exportMinCount = k
}

const JSON_HEADERS = ['info_json', 'metadata_json', 'json_metadata']
const EXTREMES = new Set(['min', 'max'])
// Under this many values, a 1st/5th percentile sits on one patient's value.
const NEAR_EXTREMES_MIN_COUNT = 100
const NEAR_EXTREMES = new Set(['p1', 'p5', 'p95', 'p99'])

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

function isAtLeast(value: unknown, k: number): boolean {
  const n = toNumber(value)
  return Number.isInteger(n) && n >= k
}

/** A mapping's source frequency as it may leave the instance: a small one is
 *  unknown (null) — the field is a number, so it cannot read "<k". */
export function maskFrequency<T>(value: T, k: number = exportMinCount): T | null {
  return isSmall(value, k) ? null : value
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A bin width of m × 10^e, m in {1, 2, 5}: the smallest one not under `width`. */
export function niceStep(width: number): [number, number] {
  for (let e = Math.floor(Math.log10(width)) - 1; ; e++) {
    for (const m of [1, 2, 5]) if (stepWidth(m, e) >= width * (1 - 1e-9)) return [m, e]
  }
}

function stepWidth(m: number, e: number): number {
  return e >= 0 ? m * 10 ** e : m / 10 ** -e
}

/** Index of the bin of width m × 10^e holding `x`, bins starting at multiples of the width. */
export function binIndex(x: number, m: number, e: number): number {
  return Math.floor(e >= 0 ? x / (m * 10 ** e) : (x * 10 ** -e) / m)
}

/** Centre of bin `i` of width m × 10^e, written as the decimal it is. */
export function binCentre(i: number, m: number, e: number): number {
  return e >= 0 ? ((2 * i + 1) * m * 10 ** e) / 2 : ((2 * i + 1) * m) / (2 * 10 ** -e)
}

/**
 * The histogram moved onto a grid of round widths whose edges are multiples of
 * the width, or null when it cannot be (under two bins, a bin that is not
 * {x, count}). A profile built before such grids anchored its bins on the
 * minimum — centre = min + (i + ½)·(max − min)/bins — so its first and last
 * centres gave the minimum and the maximum back. Each old bin joins the round
 * bin its centre falls in; a histogram already on the grid keeps its bins.
 */
function regrid(histogram: unknown[]): Json[] | null {
  const bins = histogram.map((b) => (isObject(b)
    ? { x: toNumber(b.x), count: toNumber(b.count), patients: toNumber(b.patients_count) }
    : null))
  if (bins.length < 2 || bins.some((b) => b === null || !Number.isFinite(b.x) || !Number.isFinite(b.count))) return null
  const xs = bins.map((b) => b!.x).sort((a, b) => a - b)
  let width = Infinity
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 0 && xs[i] - xs[i - 1] < width) width = xs[i] - xs[i - 1]
  if (!Number.isFinite(width)) return null
  const [m, e] = niceStep(width)
  const counts = new Map<number, number>()
  // Distinct patients do not add up across merged bins: the largest is a floor.
  const patients = new Map<number, number>()
  for (const b of bins) {
    const i = binIndex(b!.x, m, e)
    counts.set(i, (counts.get(i) ?? 0) + b!.count)
    if (Number.isFinite(b!.patients)) patients.set(i, Math.max(patients.get(i) ?? b!.patients, b!.patients))
  }
  return [...counts.keys()].sort((a, b) => a - b).map((i) => ({
    x: binCentre(i, m, e),
    count: counts.get(i)!,
    ...(patients.has(i) ? { patients_count: patients.get(i)! } : {}),
  }))
}

/**
 * `entries` without the small ones (and without what is not an object). When
 * what was dropped totals under k, the total minus the kept entries would give
 * it back, so the smallest kept entries go too until the dropped mass reaches k
 * (secondary suppression).
 */
function suppress(entries: unknown[], small: (e: Json) => boolean, mass: (e: Json) => number, k: number): Json[] {
  const dropped = (e: unknown) => !isObject(e) || small(e)
  const weight = (e: unknown) => {
    const m = isObject(e) ? mass(e) : NaN
    return Number.isFinite(m) ? m : 0
  }
  const kept = entries.filter((e): e is Json => !dropped(e))
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

/** The profile as it may leave the instance, or null to withhold it. It leaves
 *  only over a total known to reach k: `counted` (a count cell of its row does)
 *  or its own `patients_count`/`rows_count` — a total that cannot be read could
 *  be one patient's. */
export function maskProfile(profile: Json, k: number, counted = false): Json | null {
  if (isSmall(profile.patients_count, k) || isSmall(profile.rows_count, k)) return null
  if (!(counted || isAtLeast(profile.patients_count, k) || isAtLeast(profile.rows_count, k))) return null
  const out: Json = { ...profile }
  delete out.range
  for (const key of ['numeric_data', 'records_per_patient']) {
    const block = out[key]
    if (isObject(block)) {
      out[key] = Object.fromEntries(Object.entries(block).filter(([name]) => !EXTREMES.has(name)))
    }
  }
  const total = profile.rows_count
  const records = (e: Json) => ('count' in e ? toNumber(e.count) : NaN)
  const smallCell = (e: Json) => {
    const n = records(e)
    return !Number.isFinite(n) || isSmall(n, k) || isSmall(e.patients_count, k)
  }
  const cells = (entries: unknown[], small: (e: Json) => boolean = smallCell) =>
    suppress(entries, small, records, k).map(({ patients_count: _patients, ...rest }) => rest)
  const numeric = out.numeric_data
  if (isObject(numeric)) {
    const sizes = [toNumber(numeric.numeric_count), toNumber(total)]
    if (Array.isArray(profile.histogram)) {
      let sum = 0
      for (const b of profile.histogram) sum += isObject(b) ? toNumber(b.count) : NaN
      sizes.push(sum)
    }
    const known = sizes.filter(Number.isFinite)
    if (known.length === 0 || Math.min(...known) < NEAR_EXTREMES_MIN_COUNT) {
      out.numeric_data = Object.fromEntries(Object.entries(numeric).filter(([name]) => !NEAR_EXTREMES.has(name)))
    }
  }
  if (Array.isArray(out.histogram)) {
    const grid = regrid(out.histogram)
    if (grid === null) delete out.histogram
    else {
      const [first, last] = [grid[0], grid[grid.length - 1]]
      out.histogram = cells(grid, (b) => b === first || b === last || smallCell(b))
    }
  }
  for (const key of ['categorical_data', 'hospital_units']) {
    const list = out[key]
    if (Array.isArray(list)) out[key] = cells(list)
  }
  const temporal = out.temporal_distribution
  if (isObject(temporal)) {
    // The first and last dates are one patient's event each.
    const { start_date: _start, end_date: _end, ...rest } = temporal
    out.temporal_distribution = Array.isArray(rest.by_year)
      ? { ...rest, by_year: cells(rest.by_year) }
      : rest
  }
  return out
}

/** A profile is three levels deep. Python's parser fails around a thousand
 *  levels where JSON.parse goes much further, so both sides withhold past this. */
export const MAX_PROFILE_DEPTH = 20

function tooDeep(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 1]]
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!
    if (typeof node !== 'object' || node === null) continue
    if (depth > MAX_PROFILE_DEPTH) return true
    for (const child of Object.values(node)) stack.push([child, depth + 1])
  }
  return false
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
    const counted = countIdx.some((i) => i < cells.length && isAtLeast(cells[i], k))
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
      const masked = withheld || !isObject(profile) || tooDeep(profile) ? null : maskProfile(profile, k, counted)
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
