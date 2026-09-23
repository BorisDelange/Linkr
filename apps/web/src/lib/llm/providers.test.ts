import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAvailableModels, providerName } from './providers'
import type { LlmProvider } from '@/lib/api/llm'

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
