/**
 * Writing CSV — the counterpart of lib/csv-preview, which reads it.
 *
 * Quoting is where a hand-rolled export usually breaks: a concept name like
 * "Sodium [Moles/volume] in Serum, Plasma" contains the delimiter, and one
 * unquoted comma shifts every column after it. This escapes on the same rules
 * the parser expects, so a file exported here re-imports unchanged.
 *
 * Two writers, by who reads the file. A machine (`csvField`: an OMOP load, a
 * re-import) gets the value as it is. A person (`csvHumanField`, `toCsv`) opens it
 * in a spreadsheet, which runs a text starting with a formula character whether it
 * is quoted or not, so such a text gets a leading `'` there.
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
    // Not a defence against formulas, see the top: kept so existing machine exports
    // do not change a byte.
    || /^[=+\-@\t\r]/.test(value)
  )
}

/** One field, quoted if it has to be. A `"` is doubled, per RFC 4180. */
export function csvField(value: unknown, delimiter = ','): string {
  if (value == null) return ''
  const text = String(value)
  if (!needsQuoting(text, delimiter)) return text
  return `"${text.replace(/"/g, '""')}"`
}

const FORMULA_START = /^[=+\-@\t\r\n]/
const PLAIN_NUMBER = /^[+-]?[\d.,]+(?:[eE][+-]?\d+)?$/

/** `value` as a spreadsheet will show it, never run it. A signed number and a lone
 *  character can hold no formula, and stay as they are. */
export function spreadsheetText(value: string): string {
  return value.length > 1 && FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value
}

/** One field of a CSV meant to be opened by a person. */
export function csvHumanField(value: unknown, delimiter = ','): string {
  return csvField(typeof value === 'string' ? spreadsheetText(value) : value, delimiter)
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
 * A full CSV document meant for a person: header line then one line per row,
 * CRLF-terminated.
 *
 * CRLF because that is what RFC 4180 specifies and what Excel expects; the
 * parser accepts either.
 */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[], delimiter = ','): string {
  const humanRow = (values: unknown[]) => values.map((v) => csvHumanField(v, delimiter)).join(delimiter)
  const lines = [humanRow(columns.map((c) => c.header))]
  for (const row of rows) {
    lines.push(humanRow(columns.map((c) => c.value(row))))
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
