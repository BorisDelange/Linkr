import { describe, expect, it } from 'vitest'
import { idListSql, indent, subquerySql } from './sql-layout'

describe('indent', () => {
  it('pushes every line right but those continuing a string literal', () => {
    expect(indent("SELECT 'a\nb' AS x\nFROM t")).toBe("  SELECT 'a\nb' AS x\n  FROM t")
  })

  it('pads the lines of a comment, and leaves blank lines blank', () => {
    expect(indent('-- note\n\nSELECT 1')).toBe('  -- note\n\n  SELECT 1')
  })
})

describe('idListSql', () => {
  it('puts one id per line, the labels aligned after the commas', () => {
    const labels: Record<number, string> = { 7: 'LOINC - Heart rate', 12345: 'Creatinine\n-- injected' }
    expect(idListSql([7, 12345, 9], (id) => labels[id])).toBe([
      '(',
      '  7,     -- LOINC - Heart rate',
      '  12345, -- Creatinine -- injected',
      '  9',
      ')',
    ].join('\n'))
  })
})

describe('subquerySql', () => {
  it('indents the body under its parenthesis, closed at the line it opens on', () => {
    expect(subquerySql('\nSELECT a\nFROM t\n', '  ')).toBe('(\n    SELECT a\n    FROM t\n  )')
  })
})
