/**
 * A Map that keeps at most `max` entries, dropping the least recently used —
 * for module-level memos whose keys (a concept set, a query) are unbounded.
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>()
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  get size(): number {
    return this.entries.size
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key) as V
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: K, value: V): this {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.max) {
      this.entries.delete(this.entries.keys().next().value as K)
    }
    return this
  }

  delete(key: K): boolean {
    return this.entries.delete(key)
  }
}
