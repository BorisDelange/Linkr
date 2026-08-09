import { describe, expect, it } from 'vitest'
import { compareTreeNodes, contentSize, type SortableNode } from './file-tree-sort'

const f = (name: string, size?: number): SortableNode => ({ name, type: 'file', size })
const d = (name: string): SortableNode => ({ name, type: 'folder' })

const byName = { key: 'name' as const, desc: false }
const byNameDesc = { key: 'name' as const, desc: true }
const bySize = { key: 'size' as const, desc: true }
const bySizeAsc = { key: 'size' as const, desc: false }

const order = (nodes: SortableNode[], sort: Parameters<typeof compareTreeNodes>[2]) =>
  [...nodes].sort((a, b) => compareTreeNodes(a, b, sort)).map((n) => n.name)

describe('compareTreeNodes', () => {
  it('sorts by name, naturally', () => {
    // 10_ after 2_, which a plain string sort reverses.
    expect(order([f('10_b.sql'), f('2_a.sql')], byName)).toEqual(['2_a.sql', '10_b.sql'])
  })

  it('reverses on a descending name sort', () => {
    expect(order([f('a.sql'), f('b.sql')], byNameDesc)).toEqual(['b.sql', 'a.sql'])
  })

  it('keeps folders first whichever way the sort points', () => {
    // A folder has no size; letting it fall among the files scatters the tree.
    expect(order([f('a.sql', 10), d('zz')], byName)[0]).toBe('zz')
    expect(order([f('a.sql', 10), d('zz')], byNameDesc)[0]).toBe('zz')
    expect(order([f('a.sql', 10), d('zz')], bySize)[0]).toBe('zz')
  })

  it('sorts by size, largest first by default', () => {
    expect(order([f('s', 10), f('l', 9000), f('m', 500)], bySize)).toEqual(['l', 'm', 's'])
  })

  it('sorts by size ascending when asked', () => {
    expect(order([f('s', 10), f('l', 9000)], bySizeAsc)).toEqual(['s', 'l'])
  })

  it('treats an unknown size as zero rather than dropping it out of the way', () => {
    expect(order([f('known', 100), f('unknown')], bySize)).toEqual(['known', 'unknown'])
  })

  it('breaks a size tie on the name, so the order does not shuffle', () => {
    // Two empty files must not swap places between renders.
    expect(order([f('b', 0), f('a', 0)], bySize)).toEqual(['a', 'b'])
  })

  it('is case-insensitive on names', () => {
    expect(order([f('b.sql'), f('A.sql')], byName)).toEqual(['A.sql', 'b.sql'])
  })
})

describe('contentSize', () => {
  it('measures plain text', () => {
    expect(contentSize('hello')).toBe(5)
  })

  it('counts UTF-8 bytes, not characters', () => {
    // The column claims bytes; 'é' is two, and a CJK character three.
    expect(contentSize('é')).toBe(2)
    expect(contentSize('中')).toBe(3)
  })

  it('distinguishes an empty file from one with no content at all', () => {
    expect(contentSize('')).toBe(0)
    expect(contentSize(undefined)).toBeUndefined()
  })
})
