/**
 * Turning delimited text into a table for the output panel.
 *
 * Quote-aware on purpose: the mapping export's `source_code_description` holds
 * concept names like "Sodium [Moles/volume] in Serum, Plasma", and splitting on
 * the delimiter alone tears that into two cells and shifts every column after it.
 */

/** Rows past this are dropped: the panel is a preview, not a viewer. */
export const CSV_PREVIEW_ROWS = 1000

export interface CsvPreview {
  headers: string[]
  rows: string[][]
  /** True when the file held more rows than the preview shows. */
  truncated: boolean
}

/** Delimiter for a file name, or undefined when it is not delimited text. */
export function csvDelimiterFor(fileName: string): string | undefined {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'csv') return ','
  if (ext === 'tsv') return '\t'
  return undefined
}

/**
 * Split one delimited line, honouring double quotes and the doubled-quote escape
 * ("" inside a quoted field).
 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++ } else { quoted = false }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out.map((f) => f.trim())
}

/**
 * Parse delimited text into a preview table, or null when there is nothing to
 * show. A quoted field may span lines, so the text is walked rather than split
 * on newlines first.
 */
export function parseCsvPreview(
  text: string,
  delimiter: string,
  maxRows = CSV_PREVIEW_ROWS,
): CsvPreview | null {
  if (!text.trim()) return null

  const lines = splitCsvRecords(text)
  if (lines.length === 0) return null

  const headers = splitCsvLine(lines[0], delimiter)
  const body = lines.slice(1)
  return {
    headers,
    rows: body.slice(0, maxRows).map((l) => splitCsvLine(l, delimiter)),
    truncated: body.length > maxRows,
  }
}

/**
 * Split text into records, treating a newline inside quotes as part of the field
 * rather than a record boundary.
 */
function splitCsvRecords(text: string): string[] {
  const records: string[] = []
  let current = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      // A doubled quote stays inside the field and does not flip the state.
      if (quoted && text[i + 1] === '"') { current += '""'; i++; continue }
      quoted = !quoted
      current += ch
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (current.trim()) records.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) records.push(current)
  return records
}
