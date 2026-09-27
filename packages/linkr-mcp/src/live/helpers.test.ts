import { describe, expect, it } from 'vitest'
import { clip, pointerRows, subtreeIds } from './helpers'

describe('clip', () => {
  it('keeps short text and says how much it cut from long text', () => {
    expect(clip('abc', 3)).toBe('abc')
    expect(clip('abcdef', 2)).toBe('ab\n… (4 more characters cut)')
  })
})

describe('subtreeIds', () => {
  it('lists a node after everything under it, a missing parent read as the root', () => {
    const nodes = [{ id: 'f' }, { id: 'a', parentId: 'f' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: null }]
    expect(subtreeIds(nodes, 'f')).toEqual(['b', 'a', 'f'])
    expect(subtreeIds(nodes, 'c')).toEqual(['c'])
  })
})

describe('pointerRows', () => {
  it('drops null identity fields, as buildPointer expects', () => {
    expect(pointerRows([{ id: 'd', entityId: null, lineageId: 'l', name: 'DB' }]))
      .toEqual([{ id: 'd', entityId: undefined, lineageId: 'l', name: 'DB' }])
  })
})
