import { describe, it, expect } from 'vitest'
import { toCompactEntries, parseSourceConceptIdEntries, reconcileImportedEntries, compareCodePoints, resolveImportedRange, mergeSourceConceptIdRegistry } from './source-concept-ids-io'
import type { SourceConceptIdEntry, SourceConceptIdRange } from '@/types'

function range(over: Partial<SourceConceptIdRange> = {}): SourceConceptIdRange {
  return {
    workspaceId: 'ws1', badgeLabel: 'Rennes',
    rangeStart: 2000000001, rangeEnd: 2001000000, nextId: 2000050000, totalConcepts: 50000,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as SourceConceptIdRange
}

function entry(over: Partial<SourceConceptIdEntry> = {}): SourceConceptIdEntry {
  return {
    id: 'ws1__ICU__LOINC__1234-5',
    workspaceId: 'ws1',
    badgeLabel: 'ICU',
    vocabularyId: 'LOINC',
    conceptCode: '1234-5',
    sourceConceptId: 2000001,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

describe('source-concept-ids-io — compact round-trip', () => {
  it('preserves the assigned sourceConceptId through compact serialize → parse', () => {
    const entries = [
      entry(),
      entry({ conceptCode: '6789-0', sourceConceptId: 2000002, id: 'ws1__ICU__LOINC__6789-0' }),
    ]
    const compact = toCompactEntries(entries)
    // Compact form is column-oriented, no per-entry timestamp (churn, regenerated on import).
    expect(compact.columns).toEqual(['badgeLabel', 'vocabularyId', 'conceptCode', 'sourceConceptId'])
    expect(compact.entries).toHaveLength(2)
    expect(compact.entries[0]).toHaveLength(4)

    const restored = parseSourceConceptIdEntries(compact, 'ws1')
    expect(restored.map(e => e.sourceConceptId)).toEqual([2000001, 2000002])
    expect(restored[0].badgeLabel).toBe('ICU')
    expect(restored[0].conceptCode).toBe('1234-5')
  })

  it('sorts entries by (badgeLabel, vocabularyId, conceptCode) for a stable diff', () => {
    const compact = toCompactEntries([
      entry({ conceptCode: '9-9', badgeLabel: 'Rennes' }),
      entry({ conceptCode: '1-1', badgeLabel: 'Rennes' }),
      entry({ conceptCode: '5-5', badgeLabel: 'ICU' }),
    ])
    expect(compact.entries.map(e => [e[0], e[2]])).toEqual([
      ['ICU', '5-5'],
      ['Rennes', '1-1'],
      ['Rennes', '9-9'],
    ])
  })

  it('re-keys id + workspaceId when imported into a different workspace', () => {
    const compact = toCompactEntries([entry()])
    const restored = parseSourceConceptIdEntries(compact, 'ws2')
    expect(restored[0].workspaceId).toBe('ws2')
    expect(restored[0].id).toBe('ws2__ICU__LOINC__1234-5')
    // The assigned ID itself is unchanged — it's the payload we must not lose.
    expect(restored[0].sourceConceptId).toBe(2000001)
  })

  it('tolerates an older 5-column compact form (createdAt ignored)', () => {
    const legacyCompact = {
      columns: ['badgeLabel', 'vocabularyId', 'conceptCode', 'sourceConceptId', 'createdAt'],
      entries: [['ICU', 'LOINC', '1234-5', 2000001, '2026-01-01T00:00:00Z']],
    } as unknown as Parameters<typeof parseSourceConceptIdEntries>[0]
    const restored = parseSourceConceptIdEntries(legacyCompact, 'ws1')
    expect(restored[0].sourceConceptId).toBe(2000001)
    expect(restored[0].conceptCode).toBe('1234-5')
  })

  it('accepts the legacy array-of-objects format and re-keys it', () => {
    const restored = parseSourceConceptIdEntries([entry({ workspaceId: 'old', id: 'old__x' })], 'ws1')
    expect(restored[0].workspaceId).toBe('ws1')
    expect(restored[0].id).toBe('ws1__ICU__LOINC__1234-5')
    expect(restored[0].sourceConceptId).toBe(2000001)
  })
})

describe('resolveImportedRange — safe range merge on import', () => {
  const imported = { badgeLabel: 'Rennes', rangeStart: 2000000001, rangeEnd: 2001000000, nextId: 2000030000, totalConcepts: 30000 }

  it('takes the imported range when there is no local one', () => {
    const { range: r, windowDiverged } = resolveImportedRange(undefined, imported)
    expect(r.nextId).toBe(2000030000)
    expect(windowDiverged).toBe(false)
  })

  it('same window: advances nextId to max, never backwards', () => {
    // Local is AHEAD of the imported ZIP (500k assigned locally). nextId must not
    // regress to the ZIP's 30k, or a later assign re-hands-out ids 30k..500k.
    const local = range({ nextId: 2000500000 })
    const { range: r, windowDiverged } = resolveImportedRange(local, imported)
    expect(r.nextId).toBe(2000500000)
    expect(windowDiverged).toBe(false)
  })

  it('same window, imported ahead: advances local to the imported nextId', () => {
    const local = range({ nextId: 2000010000 })
    const { range: r } = resolveImportedRange(local, { ...imported, nextId: 2000040000 })
    expect(r.nextId).toBe(2000040000)
  })

  it('diverged window (moved): local wins, flags divergence', () => {
    const local = range({ rangeStart: 2010000000, rangeEnd: 2011000000, nextId: 2010005000 })
    const { range: r, windowDiverged } = resolveImportedRange(local, imported)
    expect(r.rangeStart).toBe(2010000000)
    expect(r.nextId).toBe(2010005000)
    expect(windowDiverged).toBe(true)
  })
})

describe('reconcileImportedEntries — diverged-window entry handling', () => {
  it('drops a NEW concept on a diverged badge (its id is out of the local window)', () => {
    const imported = [entry({ badgeLabel: 'Rennes', conceptCode: 'new', sourceConceptId: 2020000000 })]
    const out = reconcileImportedEntries(imported, [], new Set(['Rennes']))
    expect(out).toHaveLength(0)
  })

  it('keeps a KNOWN concept on a diverged badge, re-pointed at the local id', () => {
    const imported = [entry({ badgeLabel: 'Rennes', conceptCode: 'known', sourceConceptId: 2020000000 })]
    const existing = [entry({ conceptCode: 'known', sourceConceptId: 2010000042 })]
    const out = reconcileImportedEntries(imported, existing, new Set(['Rennes']))
    expect(out).toHaveLength(1)
    expect(out[0].sourceConceptId).toBe(2010000042)
  })

  it('keeps a NEW concept when its badge is NOT diverged', () => {
    const imported = [entry({ badgeLabel: 'Rennes', conceptCode: 'new', sourceConceptId: 2000030000 })]
    const out = reconcileImportedEntries(imported, [], new Set())
    expect(out).toHaveLength(1)
    expect(out[0].sourceConceptId).toBe(2000030000)
  })
})

describe('compareCodePoints — deterministic, environment-independent order', () => {
  it('orders by code point, NOT locale (the two disagree on _ vs letters)', () => {
    // Real case from a Rennes lab dictionary: localeCompare puts '2INH_' AFTER
    // '2INHF' (it demotes punctuation), code point puts it BEFORE ('F' 0x46 <
    // '_' 0x5F). The versioned export must use code point so the server's Python
    // sorted() reproduces it byte for byte.
    expect(compareCodePoints('2INHF_OBR_2INHF', '2INH_OBR_2INH')).toBe(-1)
    expect('2INH_OBR_2INH'.localeCompare('2INHF_OBR_2INHF')).toBe(-1) // locale disagrees
  })

  it('sorts entries by code point (matches Python sorted())', () => {
    const compact = toCompactEntries([
      entry({ conceptCode: '961400', badgeLabel: 'Rennes' }),
      entry({ conceptCode: '9614+1', badgeLabel: 'Rennes' }),
      entry({ conceptCode: '0000|', badgeLabel: 'Rennes' }),
    ])
    // '+' (0x2B) < '0' (0x30) < '|' (0x7C) by code point.
    expect(compact.entries.map((e) => e[2])).toEqual(['0000|', '9614+1', '961400'])
  })
})

describe('source-concept-ids-io — reconcileImportedEntries (local id preservation)', () => {
  it('keeps the local id when the (vocab, code) already exists locally', () => {
    const imported = [entry({ sourceConceptId: 2000042 })]
    const existing = [entry({ sourceConceptId: 2000099 })]
    const out = reconcileImportedEntries(imported, existing)
    // Local id wins: other local projects referencing 2000099 must not be broken.
    expect(out[0].sourceConceptId).toBe(2000099)
  })

  it('matches across badges — the id is global per (vocab, code), not per badge', () => {
    const imported = [entry({ badgeLabel: 'Rennes', sourceConceptId: 2000042 })]
    const existing = [entry({ badgeLabel: 'ICU', sourceConceptId: 2000099 })]
    const out = reconcileImportedEntries(imported, existing)
    expect(out[0].sourceConceptId).toBe(2000099)
    // The imported entry keeps its own badge — only the id is re-pointed.
    expect(out[0].badgeLabel).toBe('Rennes')
  })

  it("introduces the ZIP's id for concepts the workspace has never seen", () => {
    const imported = [entry({ conceptCode: 'new-1', sourceConceptId: 2000042 })]
    const out = reconcileImportedEntries(imported, [entry({ sourceConceptId: 2000099 })])
    expect(out[0].sourceConceptId).toBe(2000042)
  })

  it('is a no-op passthrough when the workspace has no existing entries', () => {
    const imported = [entry({ sourceConceptId: 2000042 })]
    expect(reconcileImportedEntries(imported, [])[0].sourceConceptId).toBe(2000042)
  })
})

describe('mergeSourceConceptIdRegistry — workspace reconstruction (entries owned by projects, ranges at root)', () => {
  const pr = (over: Partial<{ badgeLabel: string; rangeStart: number; rangeEnd: number; nextId: number; totalConcepts: number }> = {}) =>
    ({ badgeLabel: 'Rennes', rangeStart: 2000000001, rangeEnd: 2001000000, nextId: 2000010000, totalConcepts: 100, ...over })

  it('ranges: takes the MAX nextId across root + project groups (monotone, order-independent)', () => {
    // Root is stale (nextId behind); a project group is ahead. The project must win.
    const root = { ranges: [pr({ nextId: 2000010000 })], entries: [] }
    const projA = { ranges: [pr({ nextId: 2000050000 })], entries: [] }
    const projB = { ranges: [pr({ nextId: 2000030000 })], entries: [] }
    const { ranges } = mergeSourceConceptIdRegistry([projA, projB], root)
    expect(ranges).toHaveLength(1)
    expect(ranges[0].nextId).toBe(2000050000)
  })

  it('ranges: keeps one merged range per badge', () => {
    const root = { ranges: [pr({ badgeLabel: 'Rennes' }), pr({ badgeLabel: 'Paris', rangeStart: 2010000000, rangeEnd: 2011000000, nextId: 2010000005 })], entries: [] }
    const { ranges } = mergeSourceConceptIdRegistry([], root)
    expect(ranges.map(r => r.badgeLabel).sort()).toEqual(['Paris', 'Rennes'])
  })

  it('entries: union of per-project entries, keyed by (badge, vocab, code)', () => {
    const p1 = { ranges: [], entries: [entry({ conceptCode: 'A', sourceConceptId: 1 })] }
    const p2 = { ranges: [], entries: [entry({ conceptCode: 'B', sourceConceptId: 2 })] }
    const { entries } = mergeSourceConceptIdRegistry([p1, p2], { ranges: [], entries: [] })
    expect(entries.map(e => e.conceptCode).sort()).toEqual(['A', 'B'])
  })

  it('entries: a project entry WINS over a stale root entry on the same key (first-writer, projects first)', () => {
    const proj = { ranges: [], entries: [entry({ conceptCode: 'A', sourceConceptId: 999 })] }
    const root = { ranges: [], entries: [entry({ conceptCode: 'A', sourceConceptId: 111 })] }
    const { entries } = mergeSourceConceptIdRegistry([proj], root)
    expect(entries).toHaveLength(1)
    expect(entries[0].sourceConceptId).toBe(999)
  })

  it('entries: a key only in the root (legacy fallback) still survives', () => {
    const proj = { ranges: [], entries: [entry({ conceptCode: 'A', sourceConceptId: 1 })] }
    const root = { ranges: [], entries: [entry({ conceptCode: 'legacy-only', sourceConceptId: 5 })] }
    const { entries } = mergeSourceConceptIdRegistry([proj], root)
    expect(entries.map(e => e.conceptCode).sort()).toEqual(['A', 'legacy-only'])
  })
})
