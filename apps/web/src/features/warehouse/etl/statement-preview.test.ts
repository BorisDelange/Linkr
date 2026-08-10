import { describe, expect, it } from 'vitest'
import { currentStatementNumber, statementLineAt, statementPreview, statementTooltip } from './statement-preview'
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

describe('statementTooltip', () => {
  const SQL = 'TRUNCATE target.concept;\nINSERT INTO target.concept SELECT 1;'

  it('leads with the line, so the tooltip says where to look', () => {
    expect(statementTooltip(SQL, 1, 'INSERT INTO target.concept SELECT 1'))
      .toBe('Line 2: INSERT INTO target.concept SELECT 1')
  })

  it('falls back to the bare statement when the line cannot be resolved', () => {
    // Rather than print a line the jump would not honour.
    expect(statementTooltip(undefined, 0, 'TRUNCATE target.concept')).toBe('TRUNCATE target.concept')
    expect(statementTooltip(SQL, 99, 'TRUNCATE target.concept')).toBe('TRUNCATE target.concept')
  })

  it('returns null when there is no statement to describe', () => {
    expect(statementTooltip(SQL, 0, undefined)).toBeNull()
    expect(statementTooltip(SQL, 0, '-- comment only')).toBeNull()
  })
})

describe('statementLineAt', () => {
  const SQL = [
    '-- header comment',            // 1
    '',                             // 2
    'DELETE FROM target.concept;',  // 3
    '',                             // 4
    '-- 2a. Target concepts',       // 5
    'INSERT INTO target.concept',   // 6
    'SELECT c.concept_id',          // 7
    'FROM vocab.concept c;',        // 8
  ].join('\n')

  it('finds a single-line statement', () => {
    expect(statementLineAt(SQL, 0)).toBe(3)
  })

  it('skips the comments a statement carries, landing on its code', () => {
    // The splitter hands back the leading comments with the statement; anchoring
    // on them would put the cursor above the SQL.
    expect(statementLineAt(SQL, 1)).toBe(6)
  })

  it('distinguishes statements that start with the same line', () => {
    // The regression that motivated resolving by index: a generated vocabulary
    // script has four `INSERT INTO "target".concept` statements. Text search
    // matched the first every time, so Query 4/4 jumped to the line of Query 2.
    const dup = [
      'TRUNCATE target.concept;',            // 1
      'INSERT INTO target.concept',          // 2
      'SELECT 1;',                           // 3
      'INSERT INTO target.concept',          // 4
      'SELECT 2;',                           // 5
      'INSERT INTO target.concept',          // 6
      'SELECT 3;',                           // 7
    ].join('\n')
    expect(statementLineAt(dup, 0)).toBe(1)
    expect(statementLineAt(dup, 1)).toBe(2)
    expect(statementLineAt(dup, 2)).toBe(4)
    expect(statementLineAt(dup, 3)).toBe(6)
  })

  it('ignores a semicolon inside a string or comment', () => {
    // Must agree with the splitter, or every later index is off by one.
    const tricky = [
      "SELECT 'a;b' AS x;",   // 1
      '/* drop; me */',       // 2
      'SELECT 2;',            // 3
    ].join('\n')
    expect(statementLineAt(tricky, 0)).toBe(1)
    expect(statementLineAt(tricky, 1)).toBe(3)
  })

  it('agrees with the splitter on which statement each index is', () => {
    const statements = splitSqlStatements(SQL)
    statements.forEach((stmt, i) => {
      const line = statementLineAt(SQL, i)!
      const firstCode = stmt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('--'))
      // The splitter drops the terminating `;`; the file line still has it.
      expect(SQL.split('\n')[line - 1].trim().replace(/;$/, '')).toBe(firstCode)
    })
  })

  it('handles a final statement with no trailing semicolon', () => {
    expect(statementLineAt('SELECT 1;\nSELECT 2', 1)).toBe(2)
  })

  it('returns null past the end, and for missing input', () => {
    expect(statementLineAt(SQL, 2)).toBeNull()
    expect(statementLineAt(SQL, undefined)).toBeNull()
    expect(statementLineAt(SQL, -1)).toBeNull()
    expect(statementLineAt('', 0)).toBeNull()
  })
})
