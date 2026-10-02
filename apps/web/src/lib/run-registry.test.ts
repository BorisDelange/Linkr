import { describe, it, expect } from 'vitest'
import { createRunRegistry, type RunSnapshotBase } from './run-registry'

interface Snap extends RunSnapshotBase {
  step: number
}

const IDLE: Snap = { running: false, error: null, step: 0 }

/** A run that waits for `release()` before each of its steps. */
function controllable() {
  let release: () => void = () => {}
  const gate = () => new Promise<void>((r) => { release = r })
  const registry = createRunRegistry<{ steps: number; fail?: boolean }, Snap>({
    idle: IDLE,
    execute: async ({ steps, fail }, signal, emit) => {
      for (let i = 1; i <= steps; i++) {
        await gate()
        if (signal.aborted) return
        emit({ step: i }, true)
      }
      if (fail) throw new Error('boom')
    },
  })
  return { registry, release: () => release() }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('createRunRegistry', () => {
  it('reports progress to a watcher subscribed before the run started', async () => {
    const { registry, release } = controllable()
    const seen: number[] = []
    registry.watch('a', (s) => seen.push(s.step))
    registry.start('a', { steps: 2 })
    expect(registry.get('a').running).toBe(true)
    release(); await tick()
    release(); await tick()
    expect(seen).toContain(1)
    expect(seen).toContain(2)
    expect(registry.get('a')).toMatchObject({ running: false, step: 0, error: null })
  })

  it('runs one at a time per key', async () => {
    const { registry, release } = controllable()
    let runs = 0
    const unwatch = registry.watch('a', (s) => { if (s.running && s.step === 0) runs++ })
    registry.start('a', { steps: 1 })
    registry.start('a', { steps: 1 })
    expect(runs).toBe(1)
    release(); await tick()
    unwatch()
  })

  it('keeps an error for a watcher that comes later, until cleared', async () => {
    const { registry, release } = controllable()
    registry.watch('a', () => {})
    registry.start('a', { steps: 1, fail: true })
    release(); await tick(); await tick()
    expect(registry.get('a')).toMatchObject({ running: false, error: 'boom' })
    registry.clearError('a')
    expect(registry.get('a').error).toBeNull()
  })

  it('stops on pause without reporting an error', async () => {
    const { registry, release } = controllable()
    registry.watch('a', () => {})
    registry.start('a', { steps: 3 })
    registry.pause('a')
    release(); await tick(); await tick()
    expect(registry.get('a')).toMatchObject({ running: false, error: null })
  })
})
