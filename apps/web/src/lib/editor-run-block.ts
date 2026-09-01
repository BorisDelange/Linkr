/**
 * What Cmd+Enter runs, and where it leaves the cursor.
 *
 * Two RStudio behaviours the editor was missing:
 *  - a cursor inside a multi-line block runs the WHOLE block, not the one line
 *    under the cursor (which on its own is usually a syntax error);
 *  - after running, the cursor advances past what ran, so repeated presses walk
 *    down the file.
 *
 * The block is found with Monaco's own bracket-pair selection — the same
 * "expand selection" the editor already ships — so there is no R/Python parser
 * here to drift out of sync with the language.
 */

/** The 1-based, inclusive line span of the code to run. */
export interface RunSpan {
  startLine: number
  endLine: number
}

/**
 * The column to ask Monaco about, given where the cursor actually is.
 *
 * Monaco's bracket provider pairs by scanning RIGHT from the position first, so
 * a cursor sitting AFTER a line's closing brace (`        }` with the caret at
 * end of line) sees no bracket to its right and reports no block at all — the
 * caret has to be ON the brace, not past it.
 *
 * So step back over trailing whitespace and, when the caret is past the last
 * non-blank character, onto that character. Returns a 1-based column.
 */
export function bracketProbeColumn(lineText: string, column: number): number {
  const lastNonBlank = lineText.trimEnd().length // 0 when the line is blank
  if (lastNonBlank === 0) return column
  // `column` is 1-based and may be lastNonBlank + 1 when the caret is just past
  // the final character — pull it back onto that character.
  return Math.min(column, lastNonBlank)
}

/**
 * Does this line END by opening a block (`… {`, `… (`, `… [`)?
 *
 * Monaco's bracket provider only records a pair once its scan meets an
 * UNMATCHED closing bracket — i.e. one that encloses the probe position. Probing
 * from the `{` of `f <- function() {` meets its own opening first, so the pair
 * balances out and no block is ever reported. Probing from the next line down is
 * inside the block, where the closer is unmatched and the block is found.
 */
export function opensBlockAtEol(lineText: string): boolean {
  const trimmed = lineText.trimEnd()
  return /[{([]$/.test(trimmed)
}

/** Line comment prefix per editor language; '' when the language has none. */
const LINE_COMMENT: Record<string, string> = {
  r: '#',
  python: '#',
  shell: '#',
  sql: '--',
}

/** Is this line blank, or nothing but a comment? Neither is worth running. */
export function isSkippableLine(lineText: string, language?: string): boolean {
  const trimmed = lineText.trim()
  if (trimmed === '') return true
  const prefix = language ? LINE_COMMENT[language] : undefined
  return prefix !== undefined && prefix !== '' && trimmed.startsWith(prefix)
}

/**
 * The first line worth running at or below `fromLine`.
 *
 * Comments and blank lines are skipped: a comment is not a statement, so
 * Cmd+Enter on one runs the next real line — and if that line opens a block,
 * the caller widens to the whole block from there. Returns null when nothing
 * runnable is left below.
 */
export function firstRunnableLine(
  fromLine: number,
  lineCount: number,
  lineContent: (line: number) => string,
  language?: string,
): number | null {
  for (let line = fromLine; line <= lineCount; line++) {
    if (!isSkippableLine(lineContent(line), language)) return line
  }
  return null
}

/**
 * Where the cursor goes after running lines up to `endLine`.
 *
 * The next line worth running, so pressing Cmd+Enter repeatedly walks statement
 * to statement instead of stopping on every blank line or comment between them.
 * Returns null when nothing runnable is left below, and the caller leaves the
 * cursor alone.
 */
export function nextRunnableLine(
  endLine: number,
  lineCount: number,
  lineContent: (line: number) => string,
  language?: string,
): number | null {
  return firstRunnableLine(endLine + 1, lineCount, lineContent, language)
}

/**
 * Widen a single-line span to the smallest enclosing multi-line block.
 *
 * `candidates` are the expand-selection ranges Monaco offers for the cursor,
 * innermost first. We take the first one that actually spans several lines and
 * contains the cursor line — the innermost block — and ignore same-line ranges
 * (a word, a string, a call's arguments), which would run less than the line.
 *
 * `lineCount` is the document's length, and ranges covering ALL of it are
 * rejected: Monaco's word provider unconditionally contributes the full model
 * range as its outermost candidate, so on a line with no enclosing bracket
 * (a top-level statement) the first multi-line range offered is the whole file
 * — which would silently turn Cmd+Enter into "run the entire script".
 *
 * Returns the original span when the cursor is on a standalone statement, so a
 * one-line expression still runs as just that line.
 */
export function widenToBlock(
  cursorLine: number,
  candidates: readonly RunSpan[],
  lineCount?: number,
): RunSpan {
  for (const range of candidates) {
    if (range.endLine <= range.startLine) continue
    if (range.startLine > cursorLine || range.endLine < cursorLine) continue
    // The whole document is never a "block" worth running as one statement.
    if (lineCount !== undefined && range.startLine <= 1 && range.endLine >= lineCount) continue
    return { startLine: range.startLine, endLine: range.endLine }
  }
  return { startLine: cursorLine, endLine: cursorLine }
}
