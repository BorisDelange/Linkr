import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkrApi, withV2Mapping, type DataSource } from './api'

describe('withV2Mapping', () => {
  it('reads malformed overrides as none, as the app does', () => {
    const base = { knownTables: ['person'] }
    const ds = { id: 'db', schemaMapping: base, schemaOverrides: { relations: { 'events.Lab': null }, removed: [3] } } as unknown as DataSource
    expect(withV2Mapping(ds).schemaMapping).toMatchObject(base)
  })
})

describe('LinkrApi.request', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const refusal = async (detail: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ detail }, { status: 428 })))
    const client = new LinkrApi({ LINKR_API_URL: 'http://linkr.test', LINKR_TOKEN: 'tok' })
    return await client.request('POST', '/data-sources/x/derive').then(() => null, (e: Error) => e.message)
  }

  it('sends the user to Linkr for a missing write login, never asking for the password', async () => {
    const message = await refusal({ code: 'database_credential_required', purpose: 'write' })
    expect(message).toMatch(/write account/)
    expect(message).toMatch(/Cohorts → Derive/)
    expect(message).toMatch(/Never ask them for the password/)
  })

  it('sends the user to Linkr for a missing read login', async () => {
    const message = await refusal({ code: 'database_credential_required' })
    expect(message).toMatch(/Profile → Database accounts/)
    expect(message).not.toMatch(/write account/)
    expect(message).toMatch(/Never ask them for the password/)
  })
})
