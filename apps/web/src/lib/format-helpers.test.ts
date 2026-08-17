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
  formatDateTimeLocale,
  formatTimeLocale,
  formatStayDuration,
} from './format-helpers'
import type { TFunction } from 'i18next'

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

  it('counts in octets in French, which is the local convention', () => {
    // "KB" in a French UI reads as an untranslated string.
    expect(humanBytes(500, 'fr')).toBe('500 o')
    expect(humanBytes(30_000, 'fr')).toBe('29 ko')
    expect(humanBytes(64_500_000, 'fr')).toBe('61.5 Mo')
    expect(humanBytes(2.5 * 1024 ** 3, 'fr')).toBe('2.5 Go')
  })

  it('defaults to English units when no language is given', () => {
    expect(humanBytes(30_000)).toBe('29 KB')
  })

  it('returns an empty string when the size is unknown', () => {
    expect(humanBytes(undefined)).toBe('')
    expect(humanBytes(undefined, 'fr')).toBe('')
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

// A stay label sits in a fixed-width column of the visit list, so a long
// admission must coarsen to months rather than print "152 days".
describe('formatStayDuration', () => {
  // Echoes the key and count so the unit chosen is visible in the assertion.
  const t = ((key: string, opts?: { count?: number }) =>
    `${opts?.count}:${key}`) as unknown as TFunction

  it('counts days for a short stay', () => {
    expect(formatStayDuration('2026-01-01', '2026-01-14', t)).toBe(
      '13:patient_data.days_count',
    )
  })

  it('switches to months past two', () => {
    // 2006-01-03 → 2006-07-08 is ~186 days, i.e. 6 months.
    expect(formatStayDuration('2006-01-03', '2006-07-08', t)).toBe(
      '6:patient_data.months_count',
    )
  })

  it('keeps days right up to the 60-day boundary', () => {
    expect(formatStayDuration('2026-01-01', '2026-03-01', t)).toBe(
      '59:patient_data.days_count',
    )
  })

  it('renders a same-day stay as zero days, not as nothing', () => {
    expect(formatStayDuration('2026-01-01', '2026-01-01', t)).toBe(
      '0:patient_data.days_count',
    )
  })

  it('returns null when an ongoing stay has no end date', () => {
    expect(formatStayDuration('2026-01-01', undefined, t)).toBeNull()
  })

  it('returns null on inverted bounds rather than a negative label', () => {
    expect(formatStayDuration('2026-03-01', '2026-01-01', t)).toBeNull()
  })
})


// The app's language, NOT the browser's: a French browser kept printing French
// dates after the user switched the app to English.
describe('formatDateTimeLocale', () => {
  const ISO = '2026-08-10T14:05:00Z'

  it('follows the app language, not the host locale', () => {
    const en = formatDateTimeLocale(ISO, 'en')
    const fr = formatDateTimeLocale(ISO, 'fr')
    expect(en).not.toBe(fr)
    // English puts the month name first; French leads with the day number.
    expect(en).toMatch(/Aug/)
    expect(fr).toMatch(/10/)
    expect(fr).not.toMatch(/Aug/)
  })

  it('accepts a regional tag like fr-CA', () => {
    expect(formatDateTimeLocale(ISO, 'fr-CA')).toBe(formatDateTimeLocale(ISO, 'fr'))
  })

  it('shows a dash for a missing date and echoes an unparseable one', () => {
    expect(formatDateTimeLocale(undefined, 'en')).toBe('—')
    expect(formatDateTimeLocale('not-a-date', 'en')).toBe('Invalid Date')
  })
})

describe('formatTimeLocale', () => {
  it('formats an epoch number as well as an ISO string', () => {
    const ms = Date.parse('2026-08-10T14:05:09Z')
    expect(formatTimeLocale(ms, 'fr')).toBe(formatTimeLocale('2026-08-10T14:05:09Z', 'fr'))
  })

  it('uses a 24-hour clock in French and 12-hour in English', () => {
    const ISO = '2026-08-10T14:05:09Z'
    expect(formatTimeLocale(ISO, 'en')).toMatch(/(AM|PM)/)
    expect(formatTimeLocale(ISO, 'fr')).not.toMatch(/(AM|PM)/)
  })

  it('shows a dash for a missing value', () => {
    expect(formatTimeLocale(undefined, 'en')).toBe('—')
  })
})

describe('humanBytes unit boundaries', () => {
  // The unit has to be decided AFTER rounding: testing the raw byte count while
  // printing the rounded one produced "1024 KB", a label wider than the unit it
  // shortens, for every value in a 512-byte window below 1 MiB.
  it('promotes to MB rather than printing 1024 KB', () => {
    expect(humanBytes(1048575)).toBe('1.0 MB')
    expect(humanBytes(1048064)).toBe('1.0 MB')
    expect(humanBytes(1048576)).toBe('1.0 MB')
  })

  it('promotes to GB rather than printing 1024.0 MB', () => {
    expect(humanBytes(1024 * 1024 * 1024 - 1)).toBe('1.0 GB')
  })

  it('still prints the units below the boundary', () => {
    expect(humanBytes(1047552)).toBe('1023 KB')
    expect(humanBytes(512)).toBe('512 B')
    expect(humanBytes(2048)).toBe('2 KB')
  })

  it('counts in octets in French', () => {
    expect(humanBytes(1048575, 'fr')).toBe('1.0 Mo')
    expect(humanBytes(512, 'fr')).toBe('512 o')
  })
})
