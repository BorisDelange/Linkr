import { describe, it, expect } from 'vitest'
import { LruMap } from './lru-map'

describe('LruMap', () => {
  it('drops the least recently used entry past its size', () => {
    const m = new LruMap<string, number>(2)
    m.set('a', 1).set('b', 2)
    m.get('a')
    m.set('c', 3)
    expect(m.size).toBe(2)
    expect(m.get('b')).toBeUndefined()
    expect(m.get('a')).toBe(1)
    expect(m.get('c')).toBe(3)
  })

  it('refreshes an entry set again', () => {
    const m = new LruMap<string, number>(2)
    m.set('a', 1).set('b', 2).set('a', 10).set('c', 3)
    expect(m.get('a')).toBe(10)
    expect(m.get('b')).toBeUndefined()
  })

  it('keeps an undefined value apart from a missing key', () => {
    const m = new LruMap<string, number | undefined>(1)
    m.set('a', undefined)
    expect(m.size).toBe(1)
    expect(m.delete('a')).toBe(true)
    expect(m.size).toBe(0)
  })
})
