import { describe, it, expect } from 'vitest'
import { diffPushMappings } from './push-mappings-diff'
import type { ConceptMapping } from '@/types'

const m = (over: Partial<ConceptMapping> = {}): ConceptMapping => ({
  id: 'local-id',
  projectId: 'p1',
  sourceConceptId: 0,
  sourceVocabularyId: 'mimic_chartevents',
  sourceConceptCode: '220045',
  sourceConceptName: 'Heart Rate',
  targetConceptId: 3027018,
  targetVocabularyId: 'LOINC',
  targetConceptCode: '8867-4',
  targetConceptName: 'Heart rate',
  ...over,
} as ConceptMapping)

const json = (list: ConceptMapping[]) => JSON.stringify(list, null, 2)

describe('diffPushMappings', () => {
  it('reports a mapping we hold and the repo does not as an add', () => {
    const out = diffPushMappings(json([]), json([m()]))!
    expect(out.changes).toHaveLength(1)
    expect(out.changes[0].type).toBe('add')
    // The incoming side fills `remote`, which is the slot the table renders —
    // pushing means our content becomes theirs.
    expect(out.changes[0].remote?.sourceConceptName).toBe('Heart Rate')
  })

  it('reports a mapping the repo holds and we no longer do as a delete', () => {
    const out = diffPushMappings(json([m()]), json([]))!
    expect(out.changes).toHaveLength(1)
    expect(out.changes[0].type).toBe('delete')
    expect(out.changes[0].local?.sourceConceptName).toBe('Heart Rate')
  })

  it('reports a changed field as an update, carrying both sides', () => {
    const out = diffPushMappings(
      json([m({ targetConceptName: 'Heart rate' })]),
      json([m({ targetConceptName: 'Heart rate (renamed)' })]),
    )!
    expect(out.changes).toHaveLength(1)
    expect(out.changes[0].type).toBe('update')
    expect(out.changes[0].remote?.targetConceptName).toBe('Heart rate (renamed)')
    expect(out.changes[0].local?.targetConceptName).toBe('Heart rate')
  })

  it('ignores id/projectId churn — they are not content', () => {
    // Ids are regenerated on every import, so treating them as a change would
    // report the whole file as modified after a round-trip.
    const out = diffPushMappings(
      json([m({ id: 'aaa', projectId: 'p1' })]),
      json([m({ id: 'bbb', projectId: 'p2' })]),
    )!
    expect(out.changes).toHaveLength(0)
    expect(out.unchanged).toBe(1)
  })

  it('counts identical rows as unchanged rather than listing them', () => {
    const out = diffPushMappings(json([m()]), json([m()]))!
    expect(out.changes).toHaveLength(0)
    expect(out.unchanged).toBe(1)
  })

  it('treats an empty side as an empty list, not a failure', () => {
    // The file is being added: everything is new, which is exactly the case
    // worth showing.
    const out = diffPushMappings('', json([m()]))!
    expect(out.changes).toHaveLength(1)
    expect(out.changes[0].type).toBe('add')
  })

  it('returns null on a truncated payload rather than a diff of half a file', () => {
    // The server condenses an oversized file to hunks; that is not JSON. Callers
    // must show "cannot itemise", never "nothing changed".
    expect(diffPushMappings(json([m()]), '@@ -1,6 +1,6 @@\n  {')).toBeNull()
  })

  it('returns null when the payload is not an array', () => {
    expect(diffPushMappings('{}', json([m()]))).toBeNull()
  })

  it('separates mappings that differ only by target — the key covers both ends', () => {
    // Same source, different target: two distinct units, not one modification.
    const out = diffPushMappings(
      json([m({ targetConceptId: 1, targetConceptCode: 'A' })]),
      json([m({ targetConceptId: 2, targetConceptCode: 'B' })]),
    )!
    expect(out.changes.map((c) => c.type).sort()).toEqual(['add', 'delete'])
  })
})
