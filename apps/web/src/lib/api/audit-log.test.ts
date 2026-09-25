import { describe, expect, it } from 'vitest'
import { auditEntriesToCsv, type AuditEntry } from './audit-log'

const entry = (patch: Partial<AuditEntry>): AuditEntry => ({
  seq: 1, at: '2026-09-25T10:00:00.000+00:00', userId: 1, username: 'alice', via: 'web', client: null,
  method: 'POST', route: '/api/v1/data-sources/x/query', status: 200, durationMs: 12, clientIp: '127.0.0.1',
  action: 'query', workspaceId: null, projectUid: null, dataSourceId: 'x', detail: 'SELECT 1', rowCount: 1, error: null,
  ...patch,
})

describe('auditEntriesToCsv', () => {
  it('writes a header and one line per entry', () => {
    const lines = auditEntriesToCsv([entry({}), entry({ seq: 2 })]).split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].startsWith('seq,at,username')).toBe(true)
  })

  it('quotes SQL holding commas, quotes and newlines', () => {
    const csv = auditEntriesToCsv([entry({ detail: 'SELECT a, "b"\nFROM t' })])
    expect(csv).toContain('"SELECT a, ""b""\nFROM t"')
  })

  it('leaves missing values empty', () => {
    const [, line] = auditEntriesToCsv([entry({ client: null, error: null })]).split('\r\n')
    expect(line).toContain(',,')
  })
})
