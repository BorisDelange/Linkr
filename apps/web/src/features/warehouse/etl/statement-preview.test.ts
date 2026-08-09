import { describe, expect, it } from 'vitest'
import { currentStatementNumber, statementPreview } from './RunProgressBar'
import { splitSqlStatements } from '@/lib/duckdb/engine'

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

describe('currentStatementNumber', () => {
  it('names the statement in flight, not the last one finished', () => {
    // While statement 3 runs, two have finished. Reporting "2/26" put the label
    // one behind the tooltip beside it.
    expect(currentStatementNumber({
      statementsDone: 2, statementsTotal: 26, currentStatement: 'DELETE FROM target.concept',
    })).toBe(3)
  })

  it('does not overshoot once nothing is pending', () => {
    // The final report clears currentStatement; adding one would read "27/26".
    expect(currentStatementNumber({ statementsDone: 26, statementsTotal: 26 })).toBe(26)
  })

  it('starts at 1, before anything has finished', () => {
    expect(currentStatementNumber({
      statementsDone: 0, statementsTotal: 26, currentStatement: 'DELETE FROM x',
    })).toBe(1)
  })

  it('agrees with the tooltip for every statement of a real run', () => {
    // The invariant the display depends on: whatever progress the runner reports,
    // the number shown and the statement shown are the same one. Mirrors the
    // reporting in run-pipeline-sql.runStatements.
    const statements = splitSqlStatements(
      'DELETE FROM a; INSERT INTO a VALUES (1); DELETE FROM b; INSERT INTO b VALUES (2);',
    )
    const total = statements.length
    statements.forEach((stmt, i) => {
      const log = { statementsDone: i, statementsTotal: total, currentStatement: stmt }
      expect(currentStatementNumber(log)).toBe(i + 1)
      expect(statementPreview(log.currentStatement)).toBe(statements[currentStatementNumber(log) - 1])
    })
  })
})
