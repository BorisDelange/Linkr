import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_DATA_ENTRY_ID,
  fetchDefaultDataState,
  findDefaultDataEntry,
  recordDefaultDataDecision,
} from './default-data'
import type { CatalogEntry } from './types'

const { apiRequest, isServerMode } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  isServerMode: vi.fn(() => true),
}))

vi.mock('@/lib/api-client', () => ({ apiRequest, isServerMode }))

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'e1',
    type: 'workspace',
    git: { url: 'https://framagit.org/g/repo', branch: 'main' },
    name: { en: 'Entry' },
    description: {},
    ...over,
  }
}

beforeEach(() => {
  apiRequest.mockReset()
  isServerMode.mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('findDefaultDataEntry', () => {
  it('picks the entry whose id is the configured default-data id', () => {
    const target = entry({ id: DEFAULT_DATA_ENTRY_ID })
    const found = findDefaultDataEntry([entry({ id: 'other' }), target])
    expect(found).toBe(target)
  })

  // A catalog that doesn't publish the entry is a normal state (a mirror, an
  // instance pointed at a private index), not an error: the wizard says so and
  // lets setup finish.
  it('returns null when the catalog does not publish it', () => {
    expect(findDefaultDataEntry([entry({ id: 'other' })])).toBeNull()
    expect(findDefaultDataEntry([])).toBeNull()
  })

  it('matches on the id, not the type — a second workspace entry is not it', () => {
    const entries = [entry({ id: 'someone-elses-workspace', type: 'workspace' })]
    expect(findDefaultDataEntry(entries)).toBeNull()
  })
})

describe('fetchDefaultDataState', () => {
  it('maps the snake_case payload to the client shape', async () => {
    apiRequest.mockResolvedValue({
      entry_id: 'demo-workspace',
      decided_at: '2026-08-27T10:00:00Z',
      installed: true,
      workspace_id: 'ws-1',
    })
    await expect(fetchDefaultDataState()).resolves.toEqual({
      entryId: 'demo-workspace',
      decidedAt: '2026-08-27T10:00:00Z',
      installed: true,
      workspaceId: 'ws-1',
    })
  })

  // The distinction that matters: "unknown" must never be mistaken for "never
  // asked", since the latter is what would let a caller re-seed over instance data.
  it('returns null when the server cannot be reached', async () => {
    apiRequest.mockRejectedValue(new Error('offline'))
    await expect(fetchDefaultDataState()).resolves.toBeNull()
  })

  it('makes no request in front-only mode', async () => {
    isServerMode.mockReturnValue(false)
    await expect(fetchDefaultDataState()).resolves.toBeNull()
    expect(apiRequest).not.toHaveBeenCalled()
  })
})

describe('recordDefaultDataDecision', () => {
  it('posts the decision, including "start empty"', async () => {
    apiRequest.mockResolvedValue({})
    await recordDefaultDataDecision('demo-workspace', false)
    const [path, init] = apiRequest.mock.calls[0]
    expect(path).toBe('/setup/default-data')
    expect(init).toMatchObject({ method: 'POST' })
    expect(JSON.parse(init.body)).toEqual({
      entry_id: 'demo-workspace',
      installed: false,
      workspace_id: null,
    })
  })

  it('carries the workspace the install created', async () => {
    apiRequest.mockResolvedValue({})
    await recordDefaultDataDecision('demo-workspace', true, 'ws-1')
    expect(JSON.parse(apiRequest.mock.calls[0][1].body).workspace_id).toBe('ws-1')
  })

  // The install already happened; failing to write the note must not fail setup.
  it('swallows a failed write', async () => {
    apiRequest.mockRejectedValue(new Error('500'))
    await expect(recordDefaultDataDecision('demo-workspace', true, 'ws-1')).resolves.toBeUndefined()
  })

  it('does nothing in front-only mode', async () => {
    isServerMode.mockReturnValue(false)
    await recordDefaultDataDecision('demo-workspace', true, 'ws-1')
    expect(apiRequest).not.toHaveBeenCalled()
  })
})
