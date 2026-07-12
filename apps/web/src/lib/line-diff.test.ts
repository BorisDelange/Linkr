import { describe, it, expect } from 'vitest'
import { computeLineDiff } from './line-diff'

// The versioning diff viewer relies on this to show what changed in an export file
// before committing. A wrong diff either hides real changes or invents fake ones.
describe('computeLineDiff', () => {
  it('returns no rows for two empty inputs', () => {
    expect(computeLineDiff('', '')).toEqual([])
  })

  it('marks every line as context when unchanged', () => {
    expect(computeLineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'context', text: 'b' },
    ])
  })

  it('reports a pure addition (empty → content) as all adds', () => {
    expect(computeLineDiff('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ])
  })

  it('reports a pure deletion (content → empty) as all dels', () => {
    expect(computeLineDiff('x\ny', '')).toEqual([
      { type: 'del', text: 'x' },
      { type: 'del', text: 'y' },
    ])
  })

  it('keeps common lines as context and surfaces the changed middle line', () => {
    const rows = computeLineDiff('a\nb\nc', 'a\nB\nc')
    expect(rows).toEqual([
      { type: 'context', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'context', text: 'c' },
    ])
  })

  it('handles an inserted line without touching surrounding context', () => {
    const rows = computeLineDiff('a\nc', 'a\nb\nc')
    expect(rows).toEqual([
      { type: 'context', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'context', text: 'c' },
    ])
  })

  it('preserves every original line across add + del (no line lost)', () => {
    const oldText = 'one\ntwo\nthree'
    const newText = 'one\nTWO\nthree\nfour'
    const rows = computeLineDiff(oldText, newText)
    const kept = rows.filter((r) => r.type !== 'add').map((r) => r.text)
    expect(kept).toEqual(['one', 'two', 'three'])
    const result = rows.filter((r) => r.type !== 'del').map((r) => r.text)
    expect(result).toEqual(['one', 'TWO', 'three', 'four'])
  })
})
