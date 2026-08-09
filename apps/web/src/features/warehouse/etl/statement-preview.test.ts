import { describe, expect, it } from 'vitest'
import { statementPreview } from './RunProgressBar'

describe('statementPreview', () => {
  it('shows the start of the statement being waited on', () => {
    expect(statementPreview('DELETE FROM target.concept;')).toBe('DELETE FROM target.concept;')
  })

  it('drops leading comments, which a generated script has plenty of', () => {
    const sql = `-- 2e. Source concepts (concept_id > 2 000 000 000)
-- The ids below come from the mapping project
INSERT INTO target.concept VALUES (1);`
    expect(statementPreview(sql)).toBe('INSERT INTO target.concept VALUES (1);')
  })

  it('collapses whitespace so a multi-line statement stays on one line', () => {
    expect(statementPreview('SELECT\n  a,\n  b\nFROM t;')).toBe('SELECT a, b FROM t;')
  })

  it('truncates a long statement with an ellipsis', () => {
    const long = `SELECT ${'x'.repeat(500)} FROM t;`
    const out = statementPreview(long)!
    expect(out.length).toBeLessThanOrEqual(221)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns null when there is nothing to show', () => {
    expect(statementPreview(undefined)).toBeNull()
    expect(statementPreview('')).toBeNull()
    // Comment-only: the caller falls back to the plain counter.
    expect(statementPreview('-- just a comment')).toBeNull()
  })
})
