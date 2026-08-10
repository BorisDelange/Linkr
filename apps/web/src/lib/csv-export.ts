/**
 * Writing CSV — the counterpart of lib/csv-preview, which reads it.
 *
 * Quoting is where a hand-rolled export usually breaks: a concept name like
 * "Sodium [Moles/volume] in Serum, Plasma" contains the delimiter, and one
 * unquoted comma shifts every column after it. This escapes on the same rules
 * the parser expects, so a file exported here re-imports unchanged.
 */

/** True when the value cannot be written bare. */
function needsQuoting(value: string, delimiter: string): boolean {
  return (
    value.includes(delimiter)
    || value.includes('"')
    || value.includes('\n')
    || value.includes('\r')
    // Leading/trailing spaces survive only inside quotes.
    || value !== value.trim()
  )
}

/** One field, quoted if it has to be. A `"` is doubled, per RFC 4180. */
export function csvField(value: unknown, delimiter = ','): string {
  if (value == null) return ''
  const text = String(value)
  if (!needsQuoting(text, delimiter)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/** One row of already-stringified-or-not values. */
export function csvRow(values: unknown[], delimiter = ','): string {
  return values.map((v) => csvField(v, delimiter)).join(delimiter)
}

export interface CsvColumn<T> {
  header: string
  value: (row: T) => unknown
}

/**
 * A full CSV document: header line then one line per row, CRLF-terminated.
 *
 * CRLF because that is what RFC 4180 specifies and what Excel expects; the
 * parser accepts either.
 */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[], delimiter = ','): string {
  const lines = [csvRow(columns.map((c) => c.header), delimiter)]
  for (const row of rows) {
    lines.push(csvRow(columns.map((c) => c.value(row)), delimiter))
  }
  return `${lines.join('\r\n')}\r\n`
}

/**
 * A CSV Blob ready to download.
 *
 * Prefixed with a UTF-8 BOM: without it Excel on Windows reads the file as
 * Latin-1 and mangles every accented concept name.
 */
export function csvBlob(text: string): Blob {
  // Written as an escape, not a literal: a raw BOM is invisible in the source and
  // reads as a stray character (lint flags it as irregular whitespace).
  const BOM = '\uFEFF'
  return new Blob([`${BOM}${text}`], { type: 'text/csv;charset=utf-8' })
}
