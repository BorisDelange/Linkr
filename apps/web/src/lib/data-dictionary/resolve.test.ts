import { describe, it, expect } from 'vitest'
import type { ConceptSetItem } from '@/types'
import { resolutionSql } from './resolve'

const item = (id: number, over: Partial<ConceptSetItem> = {}): ConceptSetItem => ({
  concept: { conceptId: id } as ConceptSetItem['concept'],
  isExcluded: false,
  includeDescendants: false,
  includeMapped: false,
  ...over,
})

// The SQL was checked against DuckDB on a small hierarchy: 1 with descendants
// {2,3,4}, minus 3 excluded with its descendants, plus 10 mapped to 11 →
// [1, 2, 10, 11]. What is pinned here is how it is built.
describe('resolutionSql', () => {
  it('expands descendants and mapped concepts for included and excluded items alike', () => {
    const sql = resolutionSql([item(1, { includeDescendants: true }), item(3, { isExcluded: true, includeMapped: true })],
      new Set(['concept_ancestor', 'concept_relationship']))!
    expect(sql).toContain('VALUES (1, FALSE, TRUE, FALSE), (3, TRUE, FALSE, TRUE)')
    expect(sql.match(/FROM concept_ancestor/g)).toHaveLength(2)
    expect(sql.match(/relationship_id IN \('Maps to', 'Mapped from'\)/g)).toHaveLength(2)
    expect(sql).toContain('WHERE concept_id NOT IN (SELECT concept_id FROM excluded)')
  })

  it('leaves out an expansion whose table the library lacks', () => {
    const sql = resolutionSql([item(1, { includeDescendants: true, includeMapped: true })], new Set(['concept']))!
    expect(sql).not.toContain('concept_ancestor')
    expect(sql).not.toContain('concept_relationship')
  })

  it('has nothing to resolve without items', () => {
    expect(resolutionSql([], new Set())).toBeNull()
  })
})
