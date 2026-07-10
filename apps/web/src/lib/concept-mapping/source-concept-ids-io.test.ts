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
    // Compact form is column-oriented, not one object per entry.
    expect(compact.columns).toEqual(['badgeLabel', 'vocabularyId', 'conceptCode', 'sourceConceptId', 'createdAt'])
    expect(compact.entries).toHaveLength(2)

    const restored = parseSourceConceptIdEntries(compact, 'ws1')
    expect(restored.map(e => e.sourceConceptId)).toEqual([2000001, 2000002])
    expect(restored[0]).toEqual(entries[0])
  })

  it('re-keys id + workspaceId when imported into a different workspace', () => {
    const compact = toCompactEntries([entry()])
    const restored = parseSourceConceptIdEntries(compact, 'ws2')
    expect(restored[0].workspaceId).toBe('ws2')
    expect(restored[0].id).toBe('ws2__ICU__LOINC__1234-5')
    // The assigned ID itself is unchanged — it's the payload we must not lose.
    expect(restored[0].sourceConceptId).toBe(2000001)
  })

  it('accepts the legacy array-of-objects format', () => {
    const legacy = [entry()]
    const restored = parseSourceConceptIdEntries(legacy, 'ws1')
    expect(restored).toEqual(legacy)
  })
})
