import { describe, expect, it } from 'vitest'
import { dateMaskFor, digitsFromTyped, digitsOf, formatMasked, isoFromMasked, maskedFromIso, TIME_MASK, timeFromMasked, maskedFromTime } from './date-mask'

const en = dateMaskFor('en')
const fr = dateMaskFor('fr')

describe('dateMaskFor', () => {
  it('gives each language the shape it reads and writes', () => {
    expect(en.placeholder).toBe('YYYY-MM-DD')
    expect(fr.placeholder).toBe('JJ/MM/AAAA')
  })

  it('treats a regional tag as its language', () => {
    expect(dateMaskFor('fr-FR').placeholder).toBe(fr.placeholder)
    expect(dateMaskFor('en-GB').placeholder).toBe(en.placeholder)
  })
})

describe('digitsOf', () => {
  it('keeps only digits, so typed separators are simply ignored', () => {
    // Typing "/" is harmless rather than forbidden: it lands where the mask
    // would have put one anyway.
    expect(digitsOf('04/01/2026')).toBe('04012026')
    expect(digitsOf('2026-01-04')).toBe('20260104')
  })

  it('caps at eight, so a date cannot overrun its mask', () => {
    expect(digitsOf('123456789999')).toBe('12345678')
  })
})

describe('digitsFromTyped', () => {
  it('lets the whole date be typed character by character, separators included', () => {
    // Typing "2026-01-04" one key at a time must render the separator the moment
    // it is pressed, not swallow it.
    let buf = ''
    const seen: string[] = []
    for (const ch of '2026-01-04') {
      buf = digitsFromTyped(formatMasked(buf, en) + ch, en)
      seen.push(formatMasked(buf, en))
    }
    expect(seen[seen.length - 1]).toBe('2026-01-04')
    // The separator shows the moment the group before it is full, whether it was
    // typed or not — so it never looks like a keystroke did nothing.
    expect(seen).toContain('2026-')
    expect(seen).toContain('2026-01-')
  })

  it('closes a short group, so an early separator means what it looks like', () => {
    // The regression: without this the separator was dropped and the digits ran
    // into the group before them — 1-2-2026 became 12/20/26.
    expect(digitsFromTyped('2026-1-2', en)).toBe('2026012')
    expect(isoFromMasked(digitsFromTyped('2026-1-2', en), en)).toBeUndefined()
    expect(isoFromMasked(digitsFromTyped('2026-1-02', en), en)).toBe('2026-01-02')
    expect(isoFromMasked(digitsFromTyped('4/1/2026', fr), fr)).toBe('2026-01-04')
  })

  it('leaves the group still being typed alone', () => {
    // "2026-1" is mid-entry: padding it to "01" now would fight the typing.
    expect(digitsFromTyped('2026-1', en)).toBe('20261')
    expect(formatMasked(digitsFromTyped('2026-1', en), en)).toBe('2026-1')
  })

  it('ignores a separator typed where the mask already put one', () => {
    expect(digitsFromTyped('2026-01-04', en)).toBe('20260104')
    expect(digitsFromTyped('04/01/2026', fr)).toBe('04012026')
  })

  it('falls back to plain digits when nothing was separated', () => {
    expect(digitsFromTyped('20260104', en)).toBe('20260104')
  })
})

describe('formatMasked', () => {
  it('inserts separators as groups fill', () => {
    expect(formatMasked('202', en)).toBe('202')
    expect(formatMasked('20260', en)).toBe('2026-0')
    expect(formatMasked('20260104', en)).toBe('2026-01-04')
  })

  it('follows the French grouping', () => {
    expect(formatMasked('0', fr)).toBe('0')
    expect(formatMasked('040', fr)).toBe('04/0')
    expect(formatMasked('04012026', fr)).toBe('04/01/2026')
  })

  it('keeps the trailing separator once a group is full', () => {
    // So typing the separator yourself puts it on screen instead of appearing to
    // do nothing. The field deletes it together with the digit before it.
    expect(formatMasked('2026', en)).toBe('2026-')
    expect(formatMasked('202601', en)).toBe('2026-01-')
    expect(formatMasked('04', fr)).toBe('04/')
  })

  it('adds no separator after the last group', () => {
    // A complete date ends with a digit; a trailing '-' would invite a ninth.
    expect(formatMasked('20260104', en)).toBe('2026-01-04')
    expect(formatMasked('04012026', fr)).toBe('04/01/2026')
  })

  it('is empty for no digits', () => {
    expect(formatMasked('', en)).toBe('')
  })
})

describe('isoFromMasked', () => {
  it('reads each language in its own order — the same day either way', () => {
    expect(isoFromMasked('20260104', en)).toBe('2026-01-04')
    expect(isoFromMasked('04012026', fr)).toBe('2026-01-04')
  })

  it('waits for all eight digits', () => {
    for (const partial of ['', '2026', '202601', '2026010']) {
      expect(isoFromMasked(partial, en), partial).toBeUndefined()
    }
  })

  it('rejects a day that does not exist', () => {
    expect(isoFromMasked('20260231', en)).toBeUndefined()
    expect(isoFromMasked('20261301', en)).toBeUndefined()
    expect(isoFromMasked('20260100', en)).toBeUndefined()
  })

  it('accepts a leap day only in a leap year', () => {
    expect(isoFromMasked('20240229', en)).toBe('2024-02-29')
    expect(isoFromMasked('20260229', en)).toBeUndefined()
  })
})

describe('maskedFromIso', () => {
  it('round-trips a stored value back into the mask', () => {
    expect(maskedFromIso('2026-01-04', en)).toBe('20260104')
    expect(maskedFromIso('2026-01-04', fr)).toBe('04012026')
    for (const mask of [en, fr]) {
      expect(isoFromMasked(maskedFromIso('2026-01-04', mask), mask)).toBe('2026-01-04')
    }
  })

  it('is empty for nothing stored', () => {
    expect(maskedFromIso(undefined, en)).toBe('')
    expect(maskedFromIso('', en)).toBe('')
    expect(maskedFromIso('garbage', en)).toBe('')
  })
})

// The time half of a datetime field. It used to be a native `<input type="time">`,
// whose shadow-DOM clock button cannot be taken out of the tab order from script —
// Tab stopped on the icon instead of moving on. A masked input has no internal
// controls, and types like the date beside it.
describe('TIME_MASK', () => {
  it('lays digits out as HH:MM:SS', () => {
    expect(formatMasked('2137', TIME_MASK)).toBe('21:37:')
    expect(formatMasked('213700', TIME_MASK)).toBe('21:37:00')
  })

  it('completes a bare hour, because that is a real answer', () => {
    // Someone who types "21" and tabs away meant 21:00:00. The native input
    // reported nothing at all until every segment was filled, so the entry was
    // silently dropped.
    expect(timeFromMasked('21')).toBe('21:00:00')
    expect(timeFromMasked('2137')).toBe('21:37:00')
    expect(timeFromMasked('213745')).toBe('21:37:45')
  })

  it('pads a single digit hour', () => {
    expect(timeFromMasked('9')).toBe('09:00:00')
  })

  it('refuses an impossible time rather than rolling it over', () => {
    expect(timeFromMasked('25')).toBeUndefined()
    expect(timeFromMasked('2170')).toBeUndefined()
    expect(timeFromMasked('213799')).toBeUndefined()
  })

  it('has nothing to commit for an empty field', () => {
    expect(timeFromMasked('')).toBeUndefined()
  })

  it('round-trips a stored time back into the mask', () => {
    expect(maskedFromTime('21:37:00')).toBe('213700')
    // A stored value may carry only hours and minutes.
    expect(maskedFromTime('21:37')).toBe('2137')
    expect(maskedFromTime(undefined)).toBe('')
  })

  it('typing the separator shows it, as on the date half', () => {
    expect(digitsFromTyped('21:', TIME_MASK)).toBe('21')
    expect(digitsFromTyped('21:3', TIME_MASK)).toBe('213')
  })
})
