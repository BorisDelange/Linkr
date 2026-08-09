import { describe, it, expect } from 'vitest'
import {
  escSql,
  isSafeIdentifier,
  validateIntegerIds,
  columnLabel,
  capitalize,
  daysBetween,
  humanBytes,
  compactCount,
} from './format-helpers'

// These are security-critical: escSql / isSafeIdentifier / validateIntegerIds
// guard the SQL boundary (user data + user-authored SQL meet DuckDB here).
describe('escSql', () => {
  it('doubles single quotes', () => {
    expect(escSql("O'Brien")).toBe("O''Brien")
  })

  it('escapes backslashes', () => {
    expect(escSql('a\\b')).toBe('a\\\\b')
  })

  it('strips NUL bytes', () => {
    expect(escSql('a\0b')).toBe('ab')
  })

  it('neutralises a classic injection payload', () => {
    const payload = "'; DROP TABLE person; --"
    const escaped = escSql(payload)
    // The opening quote must be doubled so it cannot terminate the literal.
    expect(escaped).toBe("''; DROP TABLE person; --")
    expect(escaped.startsWith("''")).toBe(true)
  })

  it('leaves a plain string untouched', () => {
    expect(escSql('plaquettes')).toBe('plaquettes')
  })
})

describe('isSafeIdentifier', () => {
  it('accepts valid column/table names', () => {
    expect(isSafeIdentifier('concept_id')).toBe(true)
    expect(isSafeIdentifier('schema.table')).toBe(true)
    expect(isSafeIdentifier('_private')).toBe(true)
  })

  it('rejects names starting with a digit', () => {
    expect(isSafeIdentifier('1col')).toBe(false)
  })

  it('rejects injection characters', () => {
    expect(isSafeIdentifier('col; DROP TABLE x')).toBe(false)
    expect(isSafeIdentifier("col'")).toBe(false)
    expect(isSafeIdentifier('col name')).toBe(false)
    expect(isSafeIdentifier('col-name')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isSafeIdentifier('')).toBe(false)
  })
})

describe('validateIntegerIds', () => {
  it('accepts a list of integers', () => {
    expect(validateIntegerIds([1, 2, 3])).toBe(true)
  })

  it('accepts an empty list', () => {
    expect(validateIntegerIds([])).toBe(true)
  })

  it('rejects floats', () => {
    expect(validateIntegerIds([1, 2.5])).toBe(false)
  })

  it('rejects NaN and Infinity', () => {
    expect(validateIntegerIds([NaN])).toBe(false)
    expect(validateIntegerIds([Infinity])).toBe(false)
  })
})

describe('columnLabel', () => {
  it('turns a leading-underscore snake_case key into a label', () => {
    expect(columnLabel('_concept_name')).toBe('Concept Name')
  })

  it('capitalises each word', () => {
    expect(columnLabel('person_id')).toBe('Person Id')
  })
})

describe('capitalize', () => {
  it('uppercases the first letter only', () => {
    expect(capitalize('hello')).toBe('Hello')
  })

  it('handles empty string', () => {
    expect(capitalize('')).toBe('')
  })
})

describe('compactCount', () => {
  it('leaves small counts alone', () => {
    expect(compactCount(0)).toBe('0')
    expect(compactCount(999)).toBe('999')
  })

  it('abbreviates thousands, keeping a decimal below 10k', () => {
    expect(compactCount(1_234)).toBe('1.2k')
    expect(compactCount(37_100)).toBe('37k')
  })

  it('abbreviates millions', () => {
    expect(compactCount(3_860_220)).toBe('3.9M')
    expect(compactCount(33_278_686)).toBe('33M')
  })

  it('rounds up across the unit boundary instead of widening', () => {
    // Was "1000k" (wider than the number it shortens) — must roll into millions.
    expect(compactCount(999_500)).toBe('1.0M')
    expect(compactCount(999_999)).toBe('1.0M')
    expect(compactCount(999_500_000)).toBe('1000M')
    // Was "10.0k": the decimal path was chosen on the un-rounded 9.999.
    expect(compactCount(9_999)).toBe('10k')
  })

  it('stays narrow enough for a sidebar column', () => {
    for (const n of [0, 999, 1_234, 9_999, 37_100, 999_500, 999_999, 3_860_220, 33_278_686, 999_999_999]) {
      expect(compactCount(n).length).toBeLessThanOrEqual(5)
    }
  })
})

describe('humanBytes', () => {
  it('scales the unit so a small file does not read as empty', () => {
    // The OMOP metadata tables are tens of KB; in MB they showed "0.0 MB".
    expect(humanBytes(30_000)).toBe('29 KB')
    expect(humanBytes(1_000)).toBe('1000 B')
  })

  it('uses MB from a megabyte up', () => {
    expect(humanBytes(64_500_000)).toBe('61.5 MB')
  })

  it('uses GB past a gigabyte, so a big export does not read as 5000 MB', () => {
    expect(humanBytes(2.5 * 1024 ** 3)).toBe('2.5 GB')
  })

  it('drops the decimal on large GB values, where a tenth means nothing', () => {
    expect(humanBytes(42 * 1024 ** 3)).toBe('42 GB')
  })

  it('returns an empty string when the size is unknown', () => {
    expect(humanBytes(undefined)).toBe('')
  })

  it('distinguishes a genuinely empty file from an unknown size', () => {
    expect(humanBytes(0)).toBe('0 B')
  })
})

describe('daysBetween', () => {
  it('counts whole days between two dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-08')).toBe(7)
  })

  it('returns null when a bound is missing', () => {
    expect(daysBetween(undefined, '2026-01-08')).toBeNull()
    expect(daysBetween('2026-01-01', undefined)).toBeNull()
  })
})
