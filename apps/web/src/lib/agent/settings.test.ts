import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAgentSettings,
  endpointFromProvider,
  fetchAvailableModels,
  loadAgentSettings,
  providerName,
  resolveAgentEndpoint,
  saveAgentSettings,
} from './settings'
import type { LlmProvider } from '@/lib/api/llm'

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

describe('fetchAvailableModels', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
    const spy = vi.fn().mockResolvedValue({ ok: true, ...response })
    globalThis.fetch = spy as unknown as typeof fetch
    return spy
  }

  it('lists model ids sorted, from the OpenAI /models shape', async () => {
    mockFetch({
      json: async () => ({
        data: [{ id: 'qwen3.5:4b' }, { id: 'gemma3:1b' }, { id: 'llama3.1:8b' }],
      }),
    })
    await expect(fetchAvailableModels('http://localhost:11434/v1')).resolves.toEqual([
      'gemma3:1b',
      'llama3.1:8b',
      'qwen3.5:4b',
    ])
  })

  it('builds the /models URL without doubling slashes', async () => {
    const spy = mockFetch({ json: async () => ({ data: [] }) })
    await fetchAvailableModels('http://localhost:11434/v1/')
    expect(spy).toHaveBeenCalledWith('http://localhost:11434/v1/models', expect.anything())
  })

  it('sends the API key when one is set', async () => {
    const spy = mockFetch({ json: async () => ({ data: [] }) })
    await fetchAvailableModels('https://api.openai.com/v1', 'sk-test')
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-test' } })
    )
  })

  it('throws on a non-OK response so the caller can hint at a bad URL', async () => {
    mockFetch({ ok: false, status: 404 })
    await expect(fetchAvailableModels('http://localhost:1/v1')).rejects.toThrow('404')
  })

  it('tolerates a payload with no data array', async () => {
    mockFetch({ json: async () => ({}) })
    await expect(fetchAvailableModels('http://localhost:11434/v1')).resolves.toEqual([])
  })
})

describe('endpointFromProvider', () => {
  function provider(overrides: Partial<LlmProvider> = {}): LlmProvider {
    return {
      id: 'p1',
      workspaceId: 'ws1',
      name: { en: 'Ollama' },
      kind: 'local-openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3.5:4b',
      hasApiKey: false,
      isLocal: true,
      enabled: true,
      surfaces: ['dashboard'],
      acknowledgedById: null,
      acknowledgedAt: null,
      createdById: 1,
      createdAt: '2026-08-07T10:00:00Z',
      updatedAt: '2026-08-07T10:00:00Z',
      ...overrides,
    }
  }

  it('uses a local provider without any acknowledgement', () => {
    const { endpoint, isRemote } = endpointFromProvider(provider())
    expect(isRemote).toBe(false)
    expect(endpoint?.model).toBe('qwen3.5:4b')
  })

  it('refuses an unacknowledged remote provider', () => {
    // Same rule as the localStorage path: forgetting to confirm disables the
    // assistant rather than silently shipping clinical context to a third party.
    const { endpoint, isRemote } = endpointFromProvider(
      provider({ isLocal: false, baseUrl: 'https://api.openai.com/v1' })
    )
    expect(endpoint).toBeNull()
    expect(isRemote).toBe(true)
  })

  it('allows a remote provider once acknowledged', () => {
    const { endpoint, isRemote } = endpointFromProvider(
      provider({
        isLocal: false,
        baseUrl: 'https://api.openai.com/v1',
        acknowledgedAt: '2026-08-07T10:00:00Z',
      })
    )
    expect(isRemote).toBe(true)
    expect(endpoint?.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('never carries an API key, because the server does not return one', () => {
    const { endpoint } = endpointFromProvider(
      provider({ hasApiKey: true, acknowledgedAt: '2026-08-07T10:00:00Z' })
    )
    expect(endpoint).not.toBeNull()
    expect(endpoint?.apiKey).toBeUndefined()
  })

  it('trusts the server-derived isLocal, not the URL shape', () => {
    // The server decides locality; a provider flagged remote stays remote even
    // if its URL looks local, so a crafted row cannot bypass the gate.
    const { endpoint, isRemote } = endpointFromProvider(
      provider({ isLocal: false, baseUrl: 'http://localhost:11434/v1' })
    )
    expect(isRemote).toBe(true)
    expect(endpoint).toBeNull()
  })
})

describe('providerName', () => {
  function provider(overrides: Partial<LlmProvider> = {}): LlmProvider {
    return {
      id: 'p1',
      workspaceId: 'ws1',
      name: {},
      kind: 'local-openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'gemma3:4b',
      hasApiKey: false,
      isLocal: true,
      enabled: true,
      surfaces: [],
      acknowledgedById: null,
      acknowledgedAt: null,
      createdById: 1,
      createdAt: '2026-08-07T10:00:00Z',
      updatedAt: '2026-08-07T10:00:00Z',
      ...overrides,
    }
  }

  it('prefers the custom name an admin gave', () => {
    expect(providerName(provider({ name: { en: 'Ollama Gemma 4B' } }))).toBe('Ollama Gemma 4B')
  })

  it('falls back to the model id when no name was given', () => {
    expect(providerName(provider())).toBe('gemma3:4b')
    expect(providerName(provider({ name: { en: '' } }))).toBe('gemma3:4b')
  })

  it('returns an empty string for no provider', () => {
    expect(providerName(null)).toBe('')
  })
})
