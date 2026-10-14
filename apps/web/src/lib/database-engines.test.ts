import { describe, expect, it } from 'vitest'
import { parsePort } from './database-engines'

describe('parsePort', () => {
  it('accepts a port in 1..65535, trimming whitespace', () => {
    expect(parsePort('5432')).toBe(5432)
    expect(parsePort(' 1 ')).toBe(1)
    expect(parsePort('65535')).toBe(65535)
  })

  it('rejects blank, non-numeric, fractional, zero and out-of-range values', () => {
    for (const v of ['', '  ', 'abc', '80 80', '1.5', '-1', '0', '65536', '1e3', '0x50']) {
      expect(parsePort(v), v).toBeNull()
    }
  })
})
