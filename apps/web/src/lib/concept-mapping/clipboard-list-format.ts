/** A concept queued into the "copy list" of the mapping editor. */
export interface ClipboardListItem {
  concept_code?: string
  concept_name?: string
  vocabulary_id?: string
  terminology_name?: string
}

export type ClipboardCopyFormat = 'sql' | 'r' | 'python'

export const CLIPBOARD_COPY_FORMATS: ClipboardCopyFormat[] = ['sql', 'r', 'python']

/** Comment marker per target language (what precedes the human-readable label). */
const COMMENT_MARKER: Record<ClipboardCopyFormat, string> = {
  sql: '--',
  r: '#',
  python: '#',
}

/** "Vocabulary - Concept name" trailing comment for one item. */
function labelComment(item: ClipboardListItem): string {
  const vocab = item.terminology_name || item.vocabulary_id || ''
  const name = item.concept_name || ''
  return [vocab, name].filter(Boolean).join(' - ')
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

  const entries = items.map((it) => ({ code: (it.concept_code ?? '').trim(), item: it }))

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
