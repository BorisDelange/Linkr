import { describe, expect, it } from 'vitest'
import { buildConceptAncestorCountQuery, buildConceptDescendantCountQuery } from './concept-detail-queries'

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim()

describe('hierarchy count queries', () => {
  // concept_ancestor names concepts of vocabularies that may not be imported; the
  // graph joins the concept table and drops them, so the warning count must too.
  it('counts only ancestors present in the concept table', () => {
    const sql = squash(buildConceptAncestorCountQuery(21600001, 'concept'))
    expect(sql).toContain('JOIN concept c ON c.concept_id = ca.ancestor_concept_id')
    expect(sql).toContain('WHERE ca.descendant_concept_id = 21600001')
  })

  it('counts only descendants present in the concept table', () => {
    const sql = squash(buildConceptDescendantCountQuery(21600001, 'vocab_concept'))
    expect(sql).toContain('JOIN vocab_concept c ON c.concept_id = ca.descendant_concept_id')
    expect(sql).toContain('WHERE ca.ancestor_concept_id = 21600001')
  })
})
