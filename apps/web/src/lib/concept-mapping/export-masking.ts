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
// Under this many values, a 1st/5th percentile sits on one patient's value.
const NEAR_EXTREMES_MIN_COUNT = 100
const NEAR_EXTREMES = new Set(['p1', 'p5', 'p95', 'p99'])

type Json = Record<string, unknown>

/** Thrown when source-concepts bytes cannot be read, hence cannot be masked:
 *  the file is then not exported at all rather than exported as it is. */
export class SourceConceptsUnreadableError extends Error {
  constructor() {
    super('The source concepts file is not UTF-8 or Windows-1252 text with well-formed rows of one width, nor readable Parquet: it cannot be masked, so it is not exported.')
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

/** Whether the totals known for a concept reach k. Every patient total given
 *  must read as at least k; records vouch only when no patient total is given at
 *  all — many records can still be one patient's. */
function vouched(patients: unknown[], records: unknown[], k: number): boolean {
  const given = patients.filter((v) => v !== undefined && v !== null)
  if (given.length > 0) return given.every((v) => isAtLeast(v, k))
  return records.some((v) => v !== undefined && v !== null && isAtLeast(v, k))
}

/** Whether the values a numeric block is computed on are known to come from at
 *  least k patients — the concept's own totals do not say. */
function numericVouched(numeric: unknown, k: number): boolean {
  if (!isObject(numeric) || !isAtLeast(numeric.numeric_patients_count, k)) return false
  return numeric.numeric_count === undefined || numeric.numeric_count === null || isAtLeast(numeric.numeric_count, k)
}

/** Whether a missing rate, over its records, gives back a count under k — of the
 *  records with a value or of those without — or cannot be read at all. */
function rateGivesSmallCount(rate: unknown, records: unknown, k: number): boolean {
  const [r, n] = [toNumber(rate), toNumber(records)]
  if (!Number.isFinite(r) || !Number.isFinite(n)) return true
  const missing = (n * r) / 100
  return (missing > 0 && missing < k) || (n - missing > 0 && n - missing < k)
}

// Only what was judged leaves (server module doc). Text a profile may carry: what
// names the concept, not what was recorded for it.
const PROFILE_TEXT_FIELDS = new Set(['full_name', 'data_source', 'unit'])
const PROFILE_NUMBER_FIELDS = new Set(['rows_count', 'patients_count', 'missing_rate', 'masked_k'])
const PROFILE_BLOCKS = new Set([
  'data_types', 'measurement_frequency', 'numeric_data', 'histogram', 'categorical_data',
  'records_per_patient', 'temporal_distribution', 'hospital_units',
])
const NUMERIC_FIELDS = new Set([
  'p1', 'p5', 'p25', 'median', 'mean', 'p75', 'p95', 'p99', 'sd', 'numeric_count', 'numeric_patients_count',
])
const PER_PATIENT_FIELDS = new Set(['mean', 'median'])
const CELL_NUMBERS = new Set(['count', 'percentage'])
const HISTOGRAM_NUMBERS = new Set(['x', 'count'])
const YEAR_NUMBERS = new Set(['year', 'count', 'percentage'])
const NAMED_CELLS: [string, string][] = [['categorical_data', 'category'], ['hospital_units', 'unit']]

const isNumberField = (v: unknown) => v === null || v === undefined || Number.isFinite(toNumber(v))
const isTextField = (v: unknown) => typeof v === 'string' || typeof v === 'number'

function numbersOnly(block: Json, fields: Set<string>): Json {
  return Object.fromEntries(Object.entries(block).filter(([name, v]) => fields.has(name) && isNumberField(v)))
}

function judgedCell(cell: Json, numbers: Set<string>, text: string | null = null): Json {
  return Object.fromEntries(Object.entries(cell).filter(
    ([name, v]) => (numbers.has(name) && isNumberField(v)) || (name === text && isTextField(v)),
  ))
}

/** Whether its stamp can be what a pass left: at k or more, over a profile holding
 *  nothing a pass removes. */
function wentThroughAPass(profile: Json, k: number): boolean {
  const isProfileField = (key: string) => PROFILE_TEXT_FIELDS.has(key) || PROFILE_NUMBER_FIELDS.has(key) || PROFILE_BLOCKS.has(key)
  if (!(toNumber(profile.masked_k) >= k) || Object.keys(profile).some((key) => !isProfileField(key))) return false
  const blocks: [string, Set<string>][] = [['numeric_data', NUMERIC_FIELDS], ['records_per_patient', PER_PATIENT_FIELDS]]
  for (const [key, fields] of blocks) {
    const block = profile[key]
    if (isObject(block) && Object.keys(block).some((name) => !fields.has(name))) return false
  }
  const temporal = profile.temporal_distribution
  if (isObject(temporal) && Object.keys(temporal).some((name) => name !== 'by_year')) return false
  const histogram = profile.histogram
  return !(Array.isArray(histogram) && histogram.some((b) => isObject(b) && 'patients_count' in b))
}

function dataTypes(value: unknown): string | string[] | null {
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null
}

/** What of `profile` the rule has a judgement on, in its order. */
function judgedFields(profile: Json): Json {
  const out: Json = Object.fromEntries(Object.entries(profile).filter(([key, value]) =>
    PROFILE_BLOCKS.has(key)
    || (PROFILE_NUMBER_FIELDS.has(key) && isNumberField(value))
    || (PROFILE_TEXT_FIELDS.has(key) && typeof value === 'string')))
  if ('data_types' in out) {
    const types = dataTypes(out.data_types)
    if (types !== null && types.length > 0) out.data_types = types
    else delete out.data_types
  }
  if ('measurement_frequency' in out) {
    const frequency = out.measurement_frequency
    const interval = isObject(frequency) ? frequency.typical_interval : null
    if (typeof interval === 'string') out.measurement_frequency = { typical_interval: interval }
    else delete out.measurement_frequency
  }
  return out
}

/** The profile as it may leave the instance, or null to withhold it. It leaves
 *  only over totals known to reach k (see `vouched`): the count cells of its row
 *  (`rowPatients`, `rowRecords`; null when absent) and its own
 *  `patients_count`/`rows_count` — a total that cannot be read could be one
 *  patient's. */
export function maskProfile(profile: Json, k: number, rowPatients: string | null = null, rowRecords: string | null = null): Json | null {
  if (isSmall(profile.patients_count, k) || isSmall(profile.rows_count, k)) return null
  if (!vouched([rowPatients, profile.patients_count], [rowRecords, profile.rows_count], k)) return null
  const stamped = wentThroughAPass(profile, k)
  const out = judgedFields(profile)
  if ('numeric_data' in out && !numericVouched(out.numeric_data, k)) {
    delete out.numeric_data
    delete out.histogram
  }
  if ('records_per_patient' in out && !isObject(out.records_per_patient)) delete out.records_per_patient
  if (isObject(out.numeric_data)) out.numeric_data = numbersOnly(out.numeric_data, NUMERIC_FIELDS)
  if (isObject(out.records_per_patient)) out.records_per_patient = numbersOnly(out.records_per_patient, PER_PATIENT_FIELDS)
  const total = profile.rows_count
  if ('missing_rate' in out && rateGivesSmallCount(out.missing_rate, total ?? rowRecords, k)) delete out.missing_rate
  const records = (e: Json) => ('count' in e ? toNumber(e.count) : NaN)
  const smallCell = (e: Json) => {
    const n = records(e)
    return !Number.isFinite(n) || isSmall(n, k) || isSmall(e.patients_count, k)
  }
  const cells = (entries: unknown[], numbers: Set<string>, text: string | null = null, small: (e: Json) => boolean = smallCell) =>
    suppress(entries, small, records, k).map((e) => judgedCell(e, numbers, text))
  const numeric = out.numeric_data
  if (isObject(numeric)) {
    const sizes = [toNumber(numeric.numeric_count), toNumber(total)]
    // Counted before a pass only: it has lost bins since.
    if (!stamped && Array.isArray(profile.histogram)) {
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
    if (stamped) {
      // On its grid already, edges gone (see `masked_k` in the server module doc).
      out.histogram = cells(out.histogram, HISTOGRAM_NUMBERS)
    } else {
      const grid = regrid(out.histogram)
      if (grid === null) delete out.histogram
      else {
        const [first, last] = [grid[0], grid[grid.length - 1]]
        out.histogram = cells(grid, HISTOGRAM_NUMBERS, null, (b) => b === first || b === last || smallCell(b))
      }
    }
  }

  for (const [key, text] of NAMED_CELLS) {
    const list = out[key]
    if (Array.isArray(list)) out[key] = cells(list, CELL_NUMBERS, text)
  }
  for (const key of ['histogram', 'categorical_data', 'hospital_units']) {
    if (key in out && !Array.isArray(out[key])) delete out[key]
  }
  const temporal = out.temporal_distribution
  if (isObject(temporal)) {
    // The first and last dates are one patient's event each, and any other field
    // of this block is judged by nothing.
    out.temporal_distribution = Array.isArray(temporal.by_year) ? { by_year: cells(temporal.by_year, YEAR_NUMBERS) } : {}
  } else if ('temporal_distribution' in out) {
    delete out.temporal_distribution
  }
  out.masked_k = k
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

/** How the app reads a mapping project's source file (FileSourceData.parseOptions). */
export interface SourceParseOptions {
  delimiter?: string
  skipRows?: number
  hasHeader?: boolean
}

/** The names DuckDB gives the columns of a file read with header=false — what a
 *  headerless project's column mapping refers to. */
function positionalHeaders(width: number): string[] {
  const digits = String(Math.max(width - 1, 0)).length
  return Array.from({ length: width }, (_, i) => `column${String(i).padStart(digits, '0')}`)
}

// A real pointer, not a file that merely starts like one.
const LFS_POINTER = /^version https:\/\/git-lfs\S*\noid sha256:[0-9a-f]+\nsize [0-9]+\n?$/
const MASKED_CELL = /^<[0-9]+$/
const STARTS_AS_NUMBER = /^[^0-9A-Za-z]*[0-9]/
const DIGIT = /[0-9]/

// Headers are compared as `slug` writes them, so `minValue`, `MIN VALUE` and
// `min_value` read alike, and `début` as `debut`.
const CONCEPT_ROLES = [
  'terminologyColumn', 'conceptCodeColumn', 'conceptIdColumn', 'conceptNameColumn', 'domainColumn',
  'conceptClassColumn', 'categoryColumn', 'subcategoryColumn', 'targetConceptIdColumn',
] as const
const CONCEPT_HEADERS = new Set([
  'terminology', 'terminology_id', 'vocabulary', 'vocabulary_id', 'code', 'concept_code', 'source_code', 'id',
  'concept', 'concept_id', 'target_concept_id', 'name', 'concept_name', 'label', 'description', 'domain',
  'domain_id', 'concept_class', 'concept_class_id', 'category', 'subcategory', 'unit',
])
const COUNT_HEADER = /(^|_)(n|nb|nbr|num|number|nombre|count|counts|cnt|freq|frequency|frequence|total|effectifs?|recs?|records?|enregistrements?|rows?|lignes?|patients?|pts|subjects?|persons?|stays?|sejours?|visits?|occurrences?)(_|$)/
const VALUE_HEADER = /(^|_)(samples?|examples?|exemples?|echantillons?|values?|valeurs?|min|max|minimum|maximum|range|first|last|premier|premiere|dernier|derniere|start|end|debut|fin|earliest|latest|oldest|newest|top|mode|mean|avg|average|moyenne|median|mediane|sd|std|stddev|percentiles?|p[0-9]{1,2}|q[0-9])(_|$)/

function slug(header: string): string {
  return header.normalize('NFD').replace(/\p{M}/gu, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

const stripBlanks = (cell: string) => cell.replace(/^[ \t]+|[ \t]+$/g, '')

/** Whether a count cell says or may say a count under k: one that cannot be read
 *  as a plain number, if it holds a digit, could be any. */
function countHidden(cell: string, k: number): boolean {
  const text = stripBlanks(cell)
  if (!text || (NUMBER_TEXT.test(text) && !isSmall(text, k))) return false
  return DIGIT.test(text)
}

function maskedJson(cell: string, k: number, withheld: boolean, rowPatients: string | null, rowRecords: string | null): string {
  let profile: unknown = null
  try {
    profile = JSON.parse(cell)
  } catch {
    // Unreadable here may be readable elsewhere (Python takes NaN): withheld.
  }
  const masked = withheld || !isObject(profile) || tooDeep(profile) ? null : maskProfile(profile, k, rowPatients, rowRecords)
  if (masked === null) return ''
  const next = JSON.stringify(masked)
  return next === JSON.stringify(profile) ? cell : next
}

function maskedOther(cell: string, k: number, chosen: boolean, withheld: boolean): string {
  const text = stripBlanks(cell)
  if (isSmall(text, k) || (!NUMBER_TEXT.test(text) && STARTS_AS_NUMBER.test(text))) return `<${k}`
  if (NUMBER_TEXT.test(text)) return withheld ? '' : cell
  return chosen && !withheld ? cell : ''
}

/**
 * The rows of `table` (whose line endings are all \n), every one of the same
 * width — a blank line aside — or SourceConceptsUnreadableError: a row read
 * otherwise than the app reads it would go unmasked, its counts in the wrong
 * column or inside a field. Read by hand, as the server's csv module in strict
 * mode reads it, so that both sides refuse the same files.
 */
function readRows(table: string, delimiter: string, hasHeader: boolean): string[][] {
  if (delimiter === '"' || delimiter === '\n' || delimiter === '\r') throw new SourceConceptsUnreadableError()
  const rows: string[][] = []
  let row: string[] = []
  let at = 0
  while (at < table.length) {
    let field = ''
    const quoted = table[at] === '"'
    if (quoted) {
      at++
      for (;;) {
        const quote = table.indexOf('"', at)
        if (quote < 0) throw new SourceConceptsUnreadableError()
        field += table.slice(at, quote)
        at = quote + 1
        if (table[at] !== '"') break
        field += '"'
        at++
      }
      if (at < table.length && table[at] !== delimiter && table[at] !== '\n') throw new SourceConceptsUnreadableError()
    } else {
      let end = at
      while (end < table.length && table[end] !== delimiter && table[end] !== '\n') end++
      field = table.slice(at, end)
      at = end
    }
    if (table[at] === delimiter) {
      row.push(field)
      at++
      if (at === table.length) row.push('')
      continue
    }
    at++
    if (field !== '' || row.length > 0 || quoted) row.push(field)
    rows.push(row)
    row = []
  }
  if (row.length > 0) rows.push(row)
  const filled = rows.filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ''))
  const width = filled.length > 0 ? filled[0].length : 0
  if (filled.some((r) => r.length !== width) || (hasHeader && rows.length > 0 && rows[0].length === 0)) {
    throw new SourceConceptsUnreadableError()
  }
  return rows
}

/**
 * `text` with every cell the rule masks rewritten; unchanged when nothing is.
 *
 * The file is read as the app reads it (`parseOptions`: skipRows lines kept as
 * they are, the chosen delimiter, a header or positional names). A count or
 * profile column the mapping names but the file does not have means the file was
 * not read as it should be: it throws rather than leaves unmasked.
 */
export function maskSourceConceptsCsv(
  text: string,
  columnMapping?: Partial<FileColumnMapping> | null,
  k: number = exportMinCount,
  parseOptions?: SourceParseOptions | null,
): string {
  if (text.startsWith('﻿')) text = text.slice(1)
  if (k <= 1 || !text || LFS_POINTER.test(text)) return text
  const opts = parseOptions ?? {}
  const skip = Math.max(0, Math.trunc(Number(opts.skipRows ?? 0)))
  if (!Number.isFinite(skip)) throw new SourceConceptsUnreadableError()
  let preamble = ''
  let table = text.replace(/\r\n?/g, '\n')
  for (let i = 0; i < skip; i++) {
    const nl = table.indexOf('\n')
    if (nl < 0) throw new SourceConceptsUnreadableError()
    preamble += table.slice(0, nl + 1)
    table = table.slice(nl + 1)
  }
  if (!table) return text
  const firstLine = table.split('\n', 1)[0]
  const delimiter = opts.delimiter || [',', ';', '\t', '|'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best)
  if (delimiter.length !== 1) throw new SourceConceptsUnreadableError()
  const hasHeader = opts.hasHeader !== false
  const rows = readRows(table, delimiter, hasHeader)
  if (rows.length === 0) return text
  const mapping = columnMapping ?? {}
  const headers = hasHeader ? rows[0] : positionalHeaders(Math.max(...rows.map((r) => r.length)))
  const data = hasHeader ? rows.slice(1) : rows
  const recordIdx = columnIndex(headers, mapping.recordCountColumn, ['record_count', 'rows_count'])
  const patientIdx = columnIndex(headers, mapping.patientCountColumn, ['patient_count', 'patients_count'])
  const jsonIdx = columnIndex(headers, mapping.infoJsonColumn, JSON_HEADERS)
  const roles: [string | undefined, number][] = [
    [mapping.recordCountColumn, recordIdx], [mapping.patientCountColumn, patientIdx], [mapping.infoJsonColumn, jsonIdx],
  ]
  if (roles.some(([name, idx]) => name && idx < 0)) throw new SourceConceptsUnreadableError()

  const lower = headers.map((h) => h.trim().toLowerCase())
  const slugs = headers.map((h) => slug(h.trim()))
  const conceptNames = new Set(CONCEPT_ROLES.flatMap((role) => (mapping[role] ? [String(mapping[role]).trim().toLowerCase()] : [])))
  const chosenNames = new Set(Array.isArray(mapping.extraColumns) ? mapping.extraColumns.map((c) => String(c).trim().toLowerCase()) : [])
  const roleCounts = new Set([recordIdx, patientIdx].filter((i) => i >= 0))
  const columns = headers.map((_, i) => i)
  const conceptCols = new Set(columns.filter((i) =>
    !roleCounts.has(i) && i !== jsonIdx && (conceptNames.has(lower[i]) || CONCEPT_HEADERS.has(slugs[i]))))
  const judged = columns.filter((i) => !conceptCols.has(i) && i !== jsonIdx)
  const valueCols = new Set(judged.filter((i) => !roleCounts.has(i) && VALUE_HEADER.test(slugs[i])))
  const countCols = new Set([...roleCounts, ...judged.filter((i) => !valueCols.has(i) && COUNT_HEADER.test(slugs[i]))])

  let changed = false
  for (const cells of data) {
    if (cells.length === 0 || (cells.length === 1 && cells[0] === '')) continue
    const withheld = [...countCols].some((i) => countHidden(cells[i], k))
    const [rowPatients, rowRecords] = [patientIdx, recordIdx].map((i) => (i >= 0 && cells[i].trim() ? cells[i] : null))
    cells.forEach((cell, i) => {
      const textCell = stripBlanks(cell)
      if (conceptCols.has(i) || !cell.trim()) return
      let next: string
      if (i === jsonIdx || (!roleCounts.has(i) && (textCell[0] === '{' || textCell[0] === '['))) {
        next = maskedJson(cell, k, withheld, rowPatients, rowRecords)
      } else if (MASKED_CELL.test(textCell)) {
        return
      } else if (valueCols.has(i)) {
        next = ''
      } else if (countCols.has(i)) {
        if (countHidden(cell, k)) next = `<${k}`
        else if (NUMBER_TEXT.test(textCell) || roleCounts.has(i)) next = cell
        else next = maskedOther(cell, k, chosenNames.has(lower[i]), withheld)
      } else {
        next = maskedOther(cell, k, chosenNames.has(lower[i]), withheld)
      }
      if (next !== cell) {
        cells[i] = next
        changed = true
      }
    })
  }
  if (!changed) return text
  const body = rows.map((cells) => cells.map((c) => cell(c, delimiter)).join(delimiter)).join('\n')
  return preamble + (table.endsWith('\n') ? `${body}\n` : body)
}
