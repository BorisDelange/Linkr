import { describe, expect, it } from 'vitest'
import { apiTokenStatus, type ApiToken } from './api-tokens'

const base: ApiToken = {
  id: 't1',
  name: 'mcp',
  prefix: 'abcdefgh',
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}
const now = new Date('2026-06-01T00:00:00Z')

describe('apiTokenStatus', () => {
  it('is active with no expiry', () => {
    expect(apiTokenStatus(base, now)).toBe('active')
  })

  it('is active before its expiry', () => {
    expect(apiTokenStatus({ ...base, expiresAt: '2026-06-02T00:00:00Z' }, now)).toBe('active')
  })

  it('is expired at or after its expiry', () => {
    expect(apiTokenStatus({ ...base, expiresAt: '2026-06-01T00:00:00Z' }, now)).toBe('expired')
  })

  it('reports revoked over expired', () => {
    expect(
      apiTokenStatus({ ...base, expiresAt: '2026-01-02T00:00:00Z', revokedAt: '2026-01-01T12:00:00Z' }, now),
    ).toBe('revoked')
  })
})
