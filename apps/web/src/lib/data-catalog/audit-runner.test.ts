import { describe, expect, it } from 'vitest'
import type { ServerRun } from '@/lib/api/server-runs'
import type { AnonymizationAudit, CatalogResultCache, DataCatalog } from '@/types'
import { auditRunApplies, type AuditRunState } from './audit-runner'

const catalog = { anonymization: { threshold: 10, mode: 'replace', noise: 3 } } as Pick<DataCatalog, 'anonymization'>
const meta = { threshold: 10, mode: 'replace' as const, noise: 3, resultsComputedAt: 'r1' }
const run = (state: AuditRunState, status: ServerRun['status'] = 'done') => ({ id: 'run', status, state } as ServerRun<AuditRunState>)
const cache = (audit?: Partial<AnonymizationAudit>) => ({ computedAt: 'r1', anonymizationAudit: audit } as CatalogResultCache)

describe('auditRunApplies', () => {
  it('keeps a finished audit of these results and settings', () => {
    expect(auditRunApplies(run({ meta, computedAt: '2026-11-08T10:00:00.000Z' }), catalog, cache())).toBe(true)
  })

  it('keeps it once: an audit kept with the same stamp, after a reload, is not kept again', () => {
    const kept = cache({ computedAt: '2026-11-08T10:00:00.000Z' })
    expect(auditRunApplies(run({ meta, computedAt: '2026-11-08T10:00:00.000Z' }), catalog, kept)).toBe(false)
    expect(auditRunApplies(run({ meta, computedAt: '2026-11-08T11:00:00.000Z' }), catalog, kept)).toBe(true)
  })

  it('leaves a run of other results or settings, or not done', () => {
    const at = '2026-11-08T10:00:00.000Z'
    expect(auditRunApplies(run({ meta: { ...meta, resultsComputedAt: 'r0' }, computedAt: at }), catalog, cache())).toBe(false)
    expect(auditRunApplies(run({ meta: { ...meta, noise: 0 }, computedAt: at }), catalog, cache())).toBe(false)
    expect(auditRunApplies(run({ meta, next: 3, total: 9 }, 'paused'), catalog, cache())).toBe(false)
  })
})
