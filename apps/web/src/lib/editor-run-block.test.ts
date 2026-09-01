import { describe, it, expect } from 'vitest'
import { widenToBlock, nextRunnableLine, type RunSpan } from './editor-run-block'

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
