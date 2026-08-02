import { describe, expect, it } from 'vitest'
import { formatDuration } from './OutputPanel'

describe('formatDuration', () => {
  it('sub-second stays in milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(820)).toBe('820ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('seconds keep one decimal of precision', () => {
    expect(formatDuration(1000)).toBe('1.0s')
    expect(formatDuration(6600)).toBe('6.6s')
    expect(formatDuration(59_900)).toBe('59.9s')
  })

  it('minutes keep the seconds (1min30s is more precise than 1min)', () => {
    expect(formatDuration(60_000)).toBe('1min00s')
    expect(formatDuration(90_000)).toBe('1min30s')
    expect(formatDuration(125_000)).toBe('2min05s')
  })

  it('hours keep the minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h00min')
    expect(formatDuration(3_600_000 + 5 * 60_000)).toBe('1h05min')
    expect(formatDuration(2 * 3_600_000 + 30 * 60_000)).toBe('2h30min')
  })
})
