import { describe, it, expect } from 'vitest'
import { widenToBlock, nextRunnableLine, firstRunnableLine, isSkippableLine, bracketProbeColumn, opensBlockAtEol, type RunSpan } from './editor-run-block'

describe('widenToBlock', () => {
  it('keeps a standalone statement on its own line', () => {
    // Expanding a one-line statement only ever yields same-line ranges.
    const candidates: RunSpan[] = [
      { startLine: 3, endLine: 3 },
      { startLine: 3, endLine: 3 },
    ]
    expect(widenToBlock(3, candidates)).toEqual({ startLine: 3, endLine: 3 })
  })

  it('widens to the enclosing multi-line block', () => {
    // Cursor on line 2 of `f <- function() {` (1) … `}` (3).
    const candidates: RunSpan[] = [
      { startLine: 2, endLine: 2 },   // the word
      { startLine: 1, endLine: 3 },   // the block, declaration line included
    ]
    expect(widenToBlock(2, candidates)).toEqual({ startLine: 1, endLine: 3 })
  })

  it('takes the INNERMOST block when several enclose the cursor', () => {
    const candidates: RunSpan[] = [
      { startLine: 5, endLine: 5 },
      { startLine: 4, endLine: 6 },   // inner block
      { startLine: 1, endLine: 10 },  // outer block
    ]
    expect(widenToBlock(5, candidates)).toEqual({ startLine: 4, endLine: 6 })
  })

  it('ignores same-line ranges that would run less than the whole line', () => {
    // A word or a string inside the line must never win over the block.
    const candidates: RunSpan[] = [
      { startLine: 7, endLine: 7 },
      { startLine: 7, endLine: 7 },
      { startLine: 6, endLine: 9 },
    ]
    expect(widenToBlock(7, candidates)).toEqual({ startLine: 6, endLine: 9 })
  })

  it('ignores a multi-line range that does not contain the cursor', () => {
    const candidates: RunSpan[] = [{ startLine: 20, endLine: 30 }]
    expect(widenToBlock(5, candidates)).toEqual({ startLine: 5, endLine: 5 })
  })

  it('falls back to the cursor line when there are no candidates', () => {
    expect(widenToBlock(4, [])).toEqual({ startLine: 4, endLine: 4 })
  })

  it('NEVER accepts the whole document as a block', () => {
    // Monaco's word provider unconditionally contributes the full model range,
    // so on a top-level statement with no enclosing bracket it is the first
    // multi-line candidate offered. Accepting it runs the entire script.
    const candidates: RunSpan[] = [
      { startLine: 5, endLine: 5 },   // the word
      { startLine: 1, endLine: 40 },  // the whole file
    ]
    expect(widenToBlock(5, candidates, 40)).toEqual({ startLine: 5, endLine: 5 })
  })

  it('still finds a real block when the whole-document range follows it', () => {
    const candidates: RunSpan[] = [
      { startLine: 5, endLine: 5 },
      { startLine: 4, endLine: 6 },   // the real block
      { startLine: 1, endLine: 40 },  // the whole file
    ]
    expect(widenToBlock(5, candidates, 40)).toEqual({ startLine: 4, endLine: 6 })
  })

  it('does not mistake a block that happens to reach the last line for the document', () => {
    // Starts at 3, so it is a genuine block even though it ends at EOF.
    const candidates: RunSpan[] = [{ startLine: 3, endLine: 10 }]
    expect(widenToBlock(5, candidates, 10)).toEqual({ startLine: 3, endLine: 10 })
  })

  it('runs the whole block from the closing brace too', () => {
    // Cursor on `}` (line 3): running just that line is a syntax error.
    const candidates: RunSpan[] = [
      { startLine: 3, endLine: 3 },
      { startLine: 1, endLine: 3 },
    ]
    expect(widenToBlock(3, candidates)).toEqual({ startLine: 1, endLine: 3 })
  })
})

describe('nextRunnableLine', () => {
  const lines = (arr: string[]) => (line: number) => arr[line - 1] ?? ''

  it('advances to the next line', () => {
    expect(nextRunnableLine(1, 3, lines(['a', 'b', 'c']))).toBe(2)
  })

  it('SKIPS blank lines so repeated presses walk statement to statement', () => {
    expect(nextRunnableLine(1, 5, lines(['a', '', '   ', 'd', 'e']))).toBe(4)
  })

  it('returns null at the end of the file', () => {
    expect(nextRunnableLine(3, 3, lines(['a', 'b', 'c']))).toBeNull()
  })

  it('returns null when only blank lines remain', () => {
    expect(nextRunnableLine(1, 4, lines(['a', '', '  ', '']))).toBeNull()
  })

  it('advances past the end of a multi-line block', () => {
    // Block spans 1-3; the cursor must land on 5, not inside the block.
    expect(nextRunnableLine(3, 6, lines(['f <- function() {', '  1', '}', '', 'g()', '']))).toBe(5)
  })
})

describe('bracketProbeColumn', () => {
  it('pulls a caret at end of line back ONTO the closing brace', () => {
    // "        }" — caret at end of line is column 10, the `}` is at column 9.
    // Monaco scans rightwards for a bracket, so probing from 10 finds none and
    // the whole block is missed. This is the reported bug.
    expect(bracketProbeColumn('        }', 10)).toBe(9)
  })

  it('leaves a caret already on the brace alone', () => {
    expect(bracketProbeColumn('        }', 9)).toBe(9)
  })

  it('leaves a caret inside the line alone', () => {
    expect(bracketProbeColumn('  x <- 42', 5)).toBe(5)
  })

  it('steps back over trailing whitespace', () => {
    expect(bracketProbeColumn('f() {   ', 9)).toBe(5)
  })

  it('handles a caret at end of a normal statement', () => {
    // "f()" — caret past the last char (column 4) lands on `)` at column 3.
    expect(bracketProbeColumn('f()', 4)).toBe(3)
  })

  it('leaves a blank line untouched', () => {
    expect(bracketProbeColumn('    ', 3)).toBe(3)
    expect(bracketProbeColumn('', 1)).toBe(1)
  })
})

describe('isSkippableLine', () => {
  it('treats a blank line as skippable in any language', () => {
    expect(isSkippableLine('', 'r')).toBe(true)
    expect(isSkippableLine('   ', 'python')).toBe(true)
  })

  it('treats a # comment as skippable in R and Python', () => {
    expect(isSkippableLine('# a comment', 'r')).toBe(true)
    expect(isSkippableLine('    # indented', 'python')).toBe(true)
  })

  it('treats a -- comment as skippable in SQL', () => {
    expect(isSkippableLine('-- a comment', 'sql')).toBe(true)
    // ...but # is not a SQL comment, so that line IS code.
    expect(isSkippableLine('# not sql', 'sql')).toBe(false)
  })

  it('never skips a real statement', () => {
    expect(isSkippableLine('f <- function() {', 'r')).toBe(false)
    expect(isSkippableLine('x <- 1  # trailing comment', 'r')).toBe(false)
  })

  it('only skips blanks when the language is unknown', () => {
    expect(isSkippableLine('# comment', undefined)).toBe(false)
    expect(isSkippableLine('   ', undefined)).toBe(true)
  })
})

describe('firstRunnableLine', () => {
  const lines = (arr: string[]) => (line: number) => arr[line - 1] ?? ''

  it('skips a comment block to reach the code below it', () => {
    // The reported case: cursor on the comment above `f <- function() {`.
    const src = [
      '# ------- ORANGE',
      '# warning() : le code continue',
      'f <- function() {',
      '  warning("x"); 123',
      '}',
    ]
    expect(firstRunnableLine(1, src.length, lines(src), 'r')).toBe(3)
    expect(firstRunnableLine(2, src.length, lines(src), 'r')).toBe(3)
  })

  it('stays put when already on a statement', () => {
    const src = ['x <- 1', '# c', 'y <- 2']
    expect(firstRunnableLine(1, src.length, lines(src), 'r')).toBe(1)
  })

  it('returns null when only comments and blanks remain', () => {
    const src = ['x <- 1', '# c', '   ', '# d']
    expect(firstRunnableLine(2, src.length, lines(src), 'r')).toBeNull()
  })
})

describe('nextRunnableLine with comments', () => {
  const lines = (arr: string[]) => (line: number) => arr[line - 1] ?? ''

  it('skips the comment header before the next statement', () => {
    const src = ['f()', '', '# ---- header', '# more', 'g()']
    expect(nextRunnableLine(1, src.length, lines(src), 'r')).toBe(5)
  })
})

describe('opensBlockAtEol', () => {
  it('detects a line that ends by opening a brace', () => {
    // The reported case: cursor on line 1 ran only line 1, because Monaco finds
    // no ENCLOSING bracket from a position that sits before the block opens.
    expect(opensBlockAtEol('f <- function() {')).toBe(true)
    expect(opensBlockAtEol('if (x) {   ')).toBe(true)
  })

  it('detects paren and bracket continuations too', () => {
    expect(opensBlockAtEol('df <- data.frame(')).toBe(true)
    expect(opensBlockAtEol('x <- c[')).toBe(true)
  })

  it('is false for a complete statement', () => {
    expect(opensBlockAtEol('x <- 42')).toBe(false)
    expect(opensBlockAtEol('f()')).toBe(false)
    expect(opensBlockAtEol('}')).toBe(false)
  })

  it('is false for a single-line block that already closes', () => {
    expect(opensBlockAtEol('f <- function() { 1 }')).toBe(false)
  })

  it('is false for a blank line', () => {
    expect(opensBlockAtEol('')).toBe(false)
    expect(opensBlockAtEol('    ')).toBe(false)
  })
})
