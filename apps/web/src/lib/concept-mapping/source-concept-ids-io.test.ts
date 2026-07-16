import { describe, it, expect } from 'vitest'
import { toCompactEntries, parseSourceConceptIdEntries } from './source-concept-ids-io'
import type { SourceConceptIdEntry } from '@/types'

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
