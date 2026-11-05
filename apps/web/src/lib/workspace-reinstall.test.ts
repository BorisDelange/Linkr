import { describe, expect, it } from 'vitest'
import { unlandedIds } from './workspace-reinstall'

describe('unlandedIds', () => {
  it('lists the rows the import did not write', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(unlandedIds(rows, new Set(['b']))).toEqual(['a', 'c'])
  })

  it('keeps everything a full import wrote', () => {
    expect(unlandedIds([{ id: 'a' }], new Set(['a', 'z']))).toEqual([])
  })

  it('deletes everything when the repository carries none of the kind', () => {
    expect(unlandedIds([{ id: 'a' }, { id: 'b' }], new Set())).toEqual(['a', 'b'])
  })
})
