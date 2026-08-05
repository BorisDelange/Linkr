import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAgentSettings,
  loadAgentSettings,
  resolveAgentEndpoint,
  saveAgentSettings,
} from './settings'

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
})

describe('resolveAgentEndpoint', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveAgentEndpoint()).toEqual({ endpoint: null, isRemote: false })
  })

  it('uses a local endpoint without any acknowledgement', () => {
    saveAgentSettings({ baseUrl: 'http://localhost:11434/v1', model: 'qwen3.5:4b' })
    const { endpoint, isRemote } = resolveAgentEndpoint()
    expect(isRemote).toBe(false)
    expect(endpoint?.model).toBe('qwen3.5:4b')
  })

  it('refuses an unacknowledged remote endpoint', () => {
    // The safety rule: forgetting to confirm disables the assistant rather than
    // silently shipping clinical context to a third party.
    saveAgentSettings({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' })
    const { endpoint, isRemote } = resolveAgentEndpoint()
    expect(endpoint).toBeNull()
    expect(isRemote).toBe(true)
  })

  it('allows a remote endpoint once acknowledged', () => {
    saveAgentSettings({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      acknowledgedAt: '2026-08-05T10:00:00Z',
    })
    const { endpoint, isRemote } = resolveAgentEndpoint()
    expect(isRemote).toBe(true)
    expect(endpoint?.apiKey).toBe('sk-test')
  })

  it('ignores malformed stored settings', () => {
    localStorage.setItem('linkr.agent.endpoint', '{ not json')
    expect(resolveAgentEndpoint().endpoint).toBeNull()
  })

  it('ignores settings missing a model', () => {
    localStorage.setItem(
      'linkr.agent.endpoint',
      JSON.stringify({ baseUrl: 'http://localhost:11434/v1' })
    )
    expect(loadAgentSettings()).toBeNull()
  })

  it('clears settings', () => {
    saveAgentSettings({ baseUrl: 'http://localhost:11434/v1', model: 'm' })
    clearAgentSettings()
    expect(loadAgentSettings()).toBeNull()
  })
})
