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
 * Where the cursor goes after running lines up to `endLine`.
 *
 * The next NON-BLANK line, so pressing Cmd+Enter repeatedly walks statement to
 * statement instead of stopping on every empty line between them. Returns null
 * when nothing runnable is left below, and the caller leaves the cursor alone.
 */
export function nextRunnableLine(
  endLine: number,
  lineCount: number,
  lineContent: (line: number) => string,
): number | null {
  for (let line = endLine + 1; line <= lineCount; line++) {
    if (lineContent(line).trim() !== '') return line
  }
  return null
}

/**
 * Widen a single-line span to the smallest enclosing multi-line block.
 *
 * `candidates` are the expand-selection ranges Monaco offers for the cursor,
 * innermost first. We take the first one that actually spans several lines and
 * contains the cursor line — the innermost block — and ignore same-line ranges
 * (a word, a string, a call's arguments), which would run less than the line.
 *
 * Returns the original span when the cursor is on a standalone statement, so a
 * one-line expression still runs as just that line.
 */
export function widenToBlock(
  cursorLine: number,
  candidates: readonly RunSpan[],
): RunSpan {
  for (const range of candidates) {
    if (
      range.endLine > range.startLine &&
      range.startLine <= cursorLine &&
      range.endLine >= cursorLine
    ) {
      return { startLine: range.startLine, endLine: range.endLine }
    }
  }
  return { startLine: cursorLine, endLine: cursorLine }
}
