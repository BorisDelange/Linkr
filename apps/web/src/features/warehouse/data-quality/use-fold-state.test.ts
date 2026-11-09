import { describe, expect, it } from 'vitest'
import { foldSteps, type FoldNode } from './use-fold-state'

const levels: FoldNode[][] = [
  [{ key: 'a' }, { key: 'b' }],
  [{ key: 'a/1', parent: 'a' }, { key: 'b/1', parent: 'b' }],
]
const openOnly = (...keys: string[]) => (key: string) => keys.includes(key)

describe('foldSteps', () => {
  it('opens the top level first, then the one below', () => {
    expect(foldSteps(levels, openOnly()).expand).toEqual(['a', 'b'])
    expect(foldSteps(levels, openOnly('a', 'b')).expand).toEqual(['a/1', 'b/1'])
    expect(foldSteps(levels, openOnly('a', 'b', 'a/1', 'b/1')).expand).toBeNull()
  })

  it('folds the deepest open level first, then the one above', () => {
    expect(foldSteps(levels, openOnly('a', 'b', 'a/1', 'b/1')).collapse).toEqual(['a/1', 'b/1'])
    expect(foldSteps(levels, openOnly('a', 'b')).collapse).toEqual(['a', 'b'])
    expect(foldSteps(levels, openOnly()).collapse).toBeNull()
  })

  it('ignores groups hidden under a folded parent', () => {
    // b is folded, so b/1 being open shows nothing: folding starts at a/1's level
    // only because a/1 is shown and open.
    expect(foldSteps(levels, openOnly('a', 'b/1')).collapse).toEqual(['a', 'b'])
    expect(foldSteps(levels, openOnly('a', 'a/1', 'b/1')).collapse).toEqual(['a/1', 'b/1'])
    // The top level is not all open yet: open it before going deeper.
    expect(foldSteps(levels, openOnly('a', 'a/1', 'b/1')).expand).toEqual(['a', 'b'])
  })
})
