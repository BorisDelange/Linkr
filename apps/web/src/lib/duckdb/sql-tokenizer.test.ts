import { describe, expect, it } from 'vitest'
import { splitSqlStatements } from './sql-tokenizer'

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('ignores a trailing empty statement and blank input', () => {
    expect(splitSqlStatements('SELECT 1;')).toEqual(['SELECT 1'])
    expect(splitSqlStatements('   ;  ;')).toEqual([])
  })

  it('does not split inside a single-quoted literal', () => {
    expect(splitSqlStatements("SELECT 'a;b'")).toEqual(["SELECT 'a;b'"])
    expect(splitSqlStatements("SELECT 'Sodium Chloride 23.4%;30ML'")).toEqual([
      "SELECT 'Sodium Chloride 23.4%;30ML'",
    ])
  })

  it('handles doubled-quote escapes', () => {
    expect(splitSqlStatements("SELECT 'it''s; fine'; SELECT 2")).toEqual([
      "SELECT 'it''s; fine'",
      'SELECT 2',
    ])
  })

  it('handles backslash escapes inside single quotes', () => {
    // An escaped quote must not end the literal early and expose the `;`.
    expect(splitSqlStatements("SELECT 'a\\'; b'; SELECT 2")).toEqual([
      "SELECT 'a\\'; b'",
      'SELECT 2',
    ])
  })

  it('does not split inside a block comment', () => {
    expect(splitSqlStatements('/* drop; this */ SELECT 1')).toEqual(['/* drop; this */ SELECT 1'])
  })

  it('does not split inside a line comment', () => {
    expect(splitSqlStatements('SELECT 1 -- a; b\n; SELECT 2')).toEqual([
      'SELECT 1 -- a; b',
      'SELECT 2',
    ])
  })

  it('ends a line comment at a bare carriage return, like DuckDB', () => {
    // DuckDB stops a `--` comment at \r, so the `;` after it IS a boundary.
    // Treating only \n as the terminator swallowed the rest of the line as
    // comment — the same divergence that let the backend's extension guard be
    // bypassed with `--\rINSTALL httpfs;`.
    expect(splitSqlStatements('-- a\rSELECT 1; SELECT 2')).toEqual([
      '-- a\rSELECT 1',
      'SELECT 2',
    ])
    // CRLF must consume both characters, not leave a stray \n.
    expect(splitSqlStatements('-- a\r\nSELECT 1; SELECT 2')).toEqual([
      '-- a\r\nSELECT 1',
      'SELECT 2',
    ])
  })

  it('does not split inside a quoted identifier', () => {
    expect(splitSqlStatements('SELECT 1 AS "a;b"; SELECT 2')).toEqual([
      'SELECT 1 AS "a;b"',
      'SELECT 2',
    ])
  })

  it('does not split inside a dollar-quoted block', () => {
    expect(splitSqlStatements('SELECT $$a;b$$; SELECT 2')).toEqual(['SELECT $$a;b$$', 'SELECT 2'])
    expect(splitSqlStatements('SELECT $tag$a;b$tag$')).toEqual(['SELECT $tag$a;b$tag$'])
  })

  it('does not split an unterminated literal', () => {
    expect(splitSqlStatements("SELECT 'unterminated; still one")).toEqual([
      "SELECT 'unterminated; still one",
    ])
  })
})
