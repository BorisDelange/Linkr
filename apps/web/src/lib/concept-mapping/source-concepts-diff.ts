/**
 * Row-level diff of a mapping project's source concept list — pure logic, no I/O.
 *
 * The source list is a whole CSV file, so git only tells us "the blob changed".
 * That is useless to decide whether to pull: a 61 925-row file reads the same
 * whether the remote added two concepts or replaced every one of them. Here we
 * key the rows the way the rest of the app identifies a source concept —
 * (vocabulary_id, concept_code) — and report added / removed / modified counts,
 * the same vocabulary the mappings merge already speaks.
 *
 * A row's identity is the pair; everything else on the row (name, domain, class,
 * counts, extra columns) is content, so a change there is "modified", not a
 * remove + add.
 */
import { parseCsvLine } from '@/lib/entity-io'

/** Column names the export writes for the identity pair (buildSourceConceptsCsvFromRows). */
const VOCAB_COLUMNS = ['vocabulary_id', 'terminology', 'terminology_name']
const CODE_COLUMNS = ['concept_code', 'code']

export interface SourceConceptRow {
  /** `${vocabulary}|${code}` — the cross-instance identity of a source concept. */
  key: string
  vocabulary: string
  code: string
  /** The row's non-identity cells, joined — compared to detect a modification. */
  content: string
}

export interface SourceConceptsDiff {
  added: number
  removed: number
  modified: number
  /** Rows present and identical on both sides. */
  unchanged: number
  localTotal: number
  remoteTotal: number
  /** A side could not be keyed (missing vocabulary/concept_code column, LFS
   *  pointer, unreadable CSV) → the counts are meaningless and the UI must say
   *  "whole file" rather than show a misleading 0/0. */
  keyed: boolean
}

const EMPTY_DIFF: SourceConceptsDiff = {
  added: 0, removed: 0, modified: 0, unchanged: 0, localTotal: 0, remoteTotal: 0, keyed: false,
}

/** Locate a column: the project's declared name first, then the accepted ones. */
function columnIndex(headers: string[], names: string[], declared?: string): number {
  const lower = headers.map((h) => h.trim().toLowerCase())
  if (declared) {
    const i = lower.indexOf(declared.trim().toLowerCase())
    if (i >= 0) return i
  }
  for (const name of names) {
    const i = lower.indexOf(name)
    if (i >= 0) return i
  }
  return -1
}

/** The project's declared identity columns (`fileSourceData.columnMapping`). */
export interface SourceColumnMapping {
  terminologyColumn?: string
  conceptCodeColumn?: string
}

/**
 * Key every row of a source-concepts CSV by (vocabulary_id, concept_code).
 *
 * `mapping` is the project's own `columnMapping`, and takes priority over the
 * guessed names: a source CSV is the user's file, so its headers are whatever
 * they were on import (`terminology_code`, …) and guessing from a fixed list
 * mis-declared real files as uncomparable. Guesses remain the fallback.
 *
 * Returns null when the file can't be keyed — an LFS pointer, an empty file, or
 * a CSV without both identity columns. Callers must degrade to a whole-file
 * choice rather than report a diff computed from nothing.
 */
export function parseSourceConceptsCsv(
  csv: string | null | undefined,
  mapping?: SourceColumnMapping,
): Map<string, SourceConceptRow> | null {
  if (!csv) return null
  // A clone that couldn't smudge LFS hands us the 3-line pointer, not the CSV.
  if (csv.startsWith('version https://git-lfs')) return null
  const lines = csv.split('\n')
  const headerLine = lines[0]?.trim()
  if (!headerLine) return null
  const headers = parseCsvLine(headerLine)
  const vocabIdx = columnIndex(headers, VOCAB_COLUMNS, mapping?.terminologyColumn)
  const codeIdx = columnIndex(headers, CODE_COLUMNS, mapping?.conceptCodeColumn)
  if (vocabIdx < 0 || codeIdx < 0) return null

  const rows = new Map<string, SourceConceptRow>()
  // A (vocabulary, code) pair is NOT unique in a real source file: MIMIC ships
  // "Acetaminophen" and "Acetaminophen " (trailing space) as separate concepts —
  // 345 such pairs in the RiCDC export alone. Keying on the pair alone collapsed
  // them silently: the diff under-counted, and a partial merge would have DROPPED
  // those rows from the rebuilt CSV. A repeat gets an occurrence suffix so every
  // physical row keeps its own identity.
  const seen = new Map<string, number>()
  for (const cells of csvRecords(csv).slice(1)) {
    const vocabulary = (cells[vocabIdx] ?? '').trim()
    const code = (cells[codeIdx] ?? '').trim()
    // A row with no code has no identity — it can only ever count as churn, so
    // skipping it keeps the diff honest rather than inventing a "" bucket.
    if (!code) continue
    const pair = `${vocabulary}|${code}`
    const n = seen.get(pair) ?? 0
    seen.set(pair, n + 1)
    const key = n === 0 ? pair : `${pair}#${n}`
    const content = cells.filter((_, idx) => idx !== vocabIdx && idx !== codeIdx).join('')
    rows.set(key, { key, vocabulary, code, content })
  }
  return rows
}

/**
 * Split a CSV into records, honouring quoted fields that span several lines.
 *
 * `split('\n')` is wrong here: this project's `metadata_json` column holds JSON
 * that can contain newlines, so a naive split cuts one concept into several
 * half-rows and every column index after the break lands on the wrong cell.
 */
function csvRecords(text: string): string[][] {
  const records: string[][] = []
  let cells: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }
        else inQuotes = false
      } else cell += ch
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ',') { cells.push(cell); cell = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') {
      cells.push(cell)
      // Skip blank lines rather than emit a phantom one-empty-cell record.
      if (cells.length > 1 || cells[0] !== '') records.push(cells)
      cells = []
      cell = ''
      continue
    }
    cell += ch
  }
  cells.push(cell)
  if (cells.length > 1 || cells[0] !== '') records.push(cells)
  return records
}

/** Compare two keyed source lists. Either side absent → not keyed (whole-file). */
export function diffSourceConcepts(
  local: Map<string, SourceConceptRow> | null,
  remote: Map<string, SourceConceptRow> | null,
): SourceConceptsDiff {
  if (!local || !remote) return { ...EMPTY_DIFF, localTotal: local?.size ?? 0, remoteTotal: remote?.size ?? 0 }
  let added = 0
  let removed = 0
  let modified = 0
  let unchanged = 0
  for (const [key, remoteRow] of remote) {
    const localRow = local.get(key)
    if (!localRow) added++
    else if (localRow.content !== remoteRow.content) modified++
    else unchanged++
  }
  for (const key of local.keys()) {
    if (!remote.has(key)) removed++
  }
  return { added, removed, modified, unchanged, localTotal: local.size, remoteTotal: remote.size, keyed: true }
}

/** Nothing to take from the remote list. */
export function sourceConceptsDiffIsEmpty(d: SourceConceptsDiff): boolean {
  return d.keyed && d.added === 0 && d.removed === 0 && d.modified === 0
}

/**
 * Build the CSV that results from taking the remote list EXCEPT the declined rows.
 *
 * The source list is written as one blob, but that does not force us to take the
 * remote file verbatim: rebuilding it here is what lets a per-row refusal actually
 * hold. For each declined `vocab|code`, the local row wins — kept if we have it,
 * dropped if the remote was adding it.
 *
 * Returns null when either side cannot be keyed; the caller must then refuse the
 * partial apply rather than silently take everything.
 *
 * The remote header is kept: it is the shape the rest of the list is in, and a
 * kept local row is re-emitted under it (columns are matched by name, so a local
 * column the remote dropped is dropped too — the file must stay rectangular).
 */
export function mergeSourceConceptsCsv(
  localCsv: string | null | undefined,
  remoteCsv: string,
  declinedKeys: ReadonlySet<string>,
  mapping?: SourceColumnMapping,
): string | null {
  if (declinedKeys.size === 0) return remoteCsv
  if (!parseSourceConceptsCsv(remoteCsv, mapping) || !parseSourceConceptsCsv(localCsv, mapping)) return null

  const remoteRecords = csvRecords(remoteCsv)
  const localRecords = csvRecords(localCsv ?? '')
  const remoteHeaders = remoteRecords[0] ?? []
  const localHeaders = localRecords[0] ?? []

  /** Per-side occurrence counter, so a repeated pair keys as `pair#1`, `pair#2`… */
  const keyer = (headers: string[]) => {
    const v = columnIndex(headers, VOCAB_COLUMNS, mapping?.terminologyColumn)
    const c = columnIndex(headers, CODE_COLUMNS, mapping?.conceptCodeColumn)
    const seen = new Map<string, number>()
    return (cells: string[]): string | null => {
      if (v < 0 || c < 0) return null
      const code = (cells[c] ?? '').trim()
      if (!code) return null
      const pair = `${(cells[v] ?? '').trim()}|${code}`
      const n = seen.get(pair) ?? 0
      seen.set(pair, n + 1)
      return n === 0 ? pair : `${pair}#${n}`
    }
  }

  const out: string[][] = [remoteHeaders]
  // Remote rows, minus the ones the user refused.
  const remoteKey = keyer(remoteHeaders)
  for (const cells of remoteRecords.slice(1)) {
    const key = remoteKey(cells)
    if (key && declinedKeys.has(key)) continue
    out.push(cells)
  }
  // Local rows the refusal preserves: a declined removal, or a declined change.
  // Re-emitted under the REMOTE header so every record has the same columns.
  const localKey = keyer(localHeaders)
  const localByName = localHeaders.map((h) => h.trim().toLowerCase())
  for (const cells of localRecords.slice(1)) {
    const key = localKey(cells)
    if (!key || !declinedKeys.has(key)) continue
    const byName = new Map(localByName.map((h, idx) => [h, cells[idx] ?? '']))
    out.push(remoteHeaders.map((h) => byName.get(h.trim().toLowerCase()) ?? ''))
  }
  return `${out.map((cells) => cells.map(csvCell).join(',')).join('\n')}\n`
}

/** Re-quote a cell for CSV output (quotes doubled, wrapped when it needs it). */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}
