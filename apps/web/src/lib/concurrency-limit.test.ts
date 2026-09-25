import { describe, it, expect } from 'vitest'
import { createConcurrencyLimit } from './concurrency-limit'

function deferred() {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('createConcurrencyLimit', () => {
  it('never runs more than the limit at once', async () => {
    const limit = createConcurrencyLimit(2)
    let running = 0
    let peak = 0
    const gates = Array.from({ length: 5 }, deferred)
    const all = gates.map((gate) => limit(async () => {
      running++
      peak = Math.max(peak, running)
      await gate.promise
      running--
    }))

    await flush()
    expect(running).toBe(2)
    for (const gate of gates) { gate.resolve(); await flush() }
    await Promise.all(all)

    expect(peak).toBe(2)
  })

  it('does not let a newcomer take the slot a finishing task hands over', async () => {
    const limit = createConcurrencyLimit(1)
    let running = 0
    let peak = 0
    const track = (gate: Promise<void>) => async () => {
      running++
      peak = Math.max(peak, running)
      await gate
      running--
    }
    const first = deferred()
    let firstTask!: Promise<void>
    const a = limit(() => (firstTask = track(first.promise)()))
    const b = limit(track(Promise.resolve()))
    await flush()

    // Registered after the limiter's own await on the first task, so this
    // newcomer arrives right after that task settles — before the waiting
    // second one has resumed.
    let c!: Promise<void>
    void firstTask.then(() => { c = limit(track(Promise.resolve())) })
    first.resolve()
    await flush()
    await Promise.all([a, b, c])

    expect(peak).toBe(1)
  })

  it('runs waiters in arrival order', async () => {
    const limit = createConcurrencyLimit(1)
    const order: number[] = []
    await Promise.all([1, 2, 3].map((n) => limit(async () => { order.push(n) })))
    expect(order).toEqual([1, 2, 3])
  })

  it('frees the slot when a task fails', async () => {
    const limit = createConcurrencyLimit(1)
    await expect(limit(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(limit(async () => 'ok')).resolves.toBe('ok')
  })
})
