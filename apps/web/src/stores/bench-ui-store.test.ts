import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SELECTION, useBenchUiStore } from './bench-ui-store'

// Tests run in a Node environment by design (docs/conventions.md), so stub the
// bit of Web Storage this module uses rather than pulling in jsdom.
beforeAll(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
})

beforeEach(() => {
  localStorage.clear()
  useBenchUiStore.setState({ byWorkspace: {} })
})

describe('bench selection', () => {
  it('starts from the default for an unknown workspace', () => {
    expect(useBenchUiStore.getState().get('ws1')).toEqual(DEFAULT_SELECTION)
  })

  it('keeps a selection across unmounts by living outside the component', () => {
    useBenchUiStore.getState().update('ws1', { models: ['gemma3:4b'], mode: 'full' })
    const kept = useBenchUiStore.getState().get('ws1')
    expect(kept.models).toEqual(['gemma3:4b'])
    expect(kept.mode).toBe('full')
    // Untouched fields survive a partial update.
    expect(kept.surfaces).toEqual(['dashboard'])
  })

  it('keeps workspaces separate, since each configures its own models', () => {
    useBenchUiStore.getState().update('ws1', { models: ['a'] })
    useBenchUiStore.getState().update('ws2', { models: ['b'] })
    expect(useBenchUiStore.getState().get('ws1').models).toEqual(['a'])
    expect(useBenchUiStore.getState().get('ws2').models).toEqual(['b'])
  })

  it('persists to localStorage so a reload keeps the selection', () => {
    useBenchUiStore.getState().update('ws1', { models: ['gemma3:4b'] })
    const raw = localStorage.getItem('linkr.agent.bench.ui')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string).ws1.models).toEqual(['gemma3:4b'])
  })

  it('marks a workspace touched only on a user change, not a reconcile', () => {
    // The distinction is what stops "I deselected everything" from being
    // refilled on the next visit, since both look like an empty list.
    useBenchUiStore.getState().reconcile('ws1', { models: ['a', 'b'] })
    expect(useBenchUiStore.getState().get('ws1').touched).toBe(false)

    useBenchUiStore.getState().update('ws1', { models: [] })
    expect(useBenchUiStore.getState().get('ws1').touched).toBe(true)

    // Once touched, a later reconcile must not clear the flag.
    useBenchUiStore.getState().reconcile('ws1', { models: ['a'] })
    expect(useBenchUiStore.getState().get('ws1').touched).toBe(true)
  })

  it('tolerates unreadable stored state', () => {
    localStorage.setItem('linkr.agent.bench.ui', '{ not json')
    // The store reads at module load, so just prove a bad value cannot throw
    // on write either.
    expect(() => useBenchUiStore.getState().update('ws1', { mode: 'full' })).not.toThrow()
  })
})
