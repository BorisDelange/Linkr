/** A concept queued into the "copy list" of the mapping editor. */
export interface ClipboardListItem {
  concept_code?: string
  concept_name?: string
  vocabulary_id?: string
  terminology_name?: string
}

export type ClipboardCopyFormat = 'sql' | 'r' | 'python'

export const CLIPBOARD_COPY_FORMATS: ClipboardCopyFormat[] = ['sql', 'r', 'python']

/** Display labels — the languages' own capitalisation, not blanket uppercase. */
export const CLIPBOARD_COPY_FORMAT_LABELS: Record<ClipboardCopyFormat, string> = {
  sql: 'SQL',
  r: 'R',
  python: 'Python',
}

/** Comment marker per target language (what precedes the human-readable label). */
const COMMENT_MARKER: Record<ClipboardCopyFormat, string> = {
  sql: '--',
  r: '#',
  python: '#',
}

/** "Vocabulary - Concept name" trailing comment for one item. Newlines are
 * collapsed to spaces — a raw `\n` in an imported concept_name would otherwise
 * split the comment across lines, turning the continuation into live code. */
function labelComment(item: ClipboardListItem): string {
  const vocab = item.terminology_name || item.vocabulary_id || ''
  const name = item.concept_name || ''
  return [vocab, name]
    .filter(Boolean)
    .join(' - ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A code is bare-emittable (unquoted) only if it's a plain integer — the OMOP
 * concept_id case, where an unquoted IN-list is the clean, intended output. */
function isNumericCode(code: string): boolean {
  return /^-?\d+$/.test(code)
}

/** Render one code for the target language: bare when the whole list is numeric,
 * otherwise a properly-escaped string literal so the pasted snippet is valid. */
function renderCode(code: string, format: ClipboardCopyFormat, allNumeric: boolean): string {
  if (allNumeric) return code
  if (format === 'sql') return `'${code.replace(/'/g, "''")}'`
  // R and Python: double-quoted with backslash + quote + newline escaping.
  const esc = code.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')
  return `"${esc}"`
}

/**
 * Format a list of concept codes into a copy-pasteable snippet for SQL / R /
 * Python. Codes are emitted verbatim (leading `      ` then `    , ` for the
 * rest, matching a hand-aligned IN-list), each followed by a
 * `<marker> Vocabulary - Concept name` comment.
 *
 * SQL     → `IN (\n      code -- Vocab - Name\n    , code2 -- ...\n)`
 * R       → `c(\n      code # Vocab - Name\n    , code2 # ...\n)`
 * Python  → `[\n      code, # Vocab - Name\n    code2, # ...\n]`
 */
export function formatClipboardList(items: ClipboardListItem[], format: ClipboardCopyFormat): string {
  const marker = COMMENT_MARKER[format]
  const open = format === 'sql' ? 'IN (' : format === 'r' ? 'c(' : '['
  const close = format === 'sql' ? ')' : format === 'r' ? ')' : ']'

  // Bare (unquoted) only when EVERY code is a plain integer; otherwise every code
  // is quoted+escaped, so the pasted SQL/R/Python is valid rather than a syntax
  // error (`IN (E11.9)`) or a silent wrong value (`718-7` → subtraction).
  const allNumeric = items.every((it) => isNumericCode((it.concept_code ?? '').trim()))
  const entries = items.map((it) => {
    const raw = (it.concept_code ?? '').trim()
    return { code: renderCode(raw, format, allNumeric), item: it }
  })

  if (entries.length === 0) return `${open}${close}`

  // Python: trailing-comma style (final comma is legal), comments right after the
  // comma. Codes are padded so all comments line up in a column.
  if (format === 'python') {
    const width = Math.max(...entries.map((e) => e.code.length))
    const lines = entries.map(({ code, item }) => {
      const comment = labelComment(item)
      const codeCol = `${code},`.padEnd(width + 1)
      return comment ? `    ${codeCol} ${marker} ${comment}` : `    ${code},`
    })
    return `${open}\n${lines.join('\n')}\n${close}`
  }

  // SQL / R: leading-comma style. The first item is shifted 2 extra spaces so its
  // code aligns under the following items' code, and the commas sit in a column
  // just under the opening paren. Commenting/uncommenting any but the first line
  // never leaves a dangling comma. Codes are padded so comments align.
  const width = Math.max(...entries.map((e) => e.code.length))
  const lines = entries.map(({ code, item }, i) => {
    const lead = i === 0 ? '      ' : '    , '
    const comment = labelComment(item)
    if (!comment) return `${lead}${code}`
    return `${lead}${code.padEnd(width)} ${marker} ${comment}`
  })

  return `${open}\n${lines.join('\n')}\n${close}`
}
