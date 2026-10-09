import { describe, it, expect } from 'vitest'
import { toNumeric } from './plot-builder-shared'
import { aggregateByEntity } from '@/lib/plugins/shared-styles'

// Expected values are what the server's _linkr_to_num gives (pandas
// to_datetime(format="ISO8601", utc=True)), so a column is plotted alike on both.
describe('toNumeric', () => {
  it('reads blank strings as missing, not zero', () => {
    expect(toNumeric('')).toBeNaN()
    expect(toNumeric('   ')).toBeNaN()
    expect(toNumeric(null)).toBeNaN()
  })

  it('keeps numbers and numeric strings', () => {
    expect(toNumeric(0)).toBe(0)
    expect(toNumeric(' 12.5 ')).toBe(12.5)
  })

  it('reads naive ISO strings as UTC, whatever the host time zone', () => {
    expect(toNumeric('2024-06-30T10:00:00')).toBe(1719741600000)
    expect(toNumeric('2024-06-30 10:00')).toBe(1719741600000)
    expect(toNumeric('2024-06-30')).toBe(1719705600000)
  })

  it('applies an explicit offset', () => {
    expect(toNumeric('2024-06-30T12:00:00+02:00')).toBe(1719741600000)
    expect(toNumeric('2024-06-30T12:00:00+0200')).toBe(1719741600000)
    expect(toNumeric('2024-06-30T05:30:00-04:30')).toBe(1719741600000)
    expect(toNumeric('2024-06-30T10:00:00.250Z')).toBe(1719741600250)
  })

  it('rejects non-ISO and impossible dates, as pandas does', () => {
    expect(toNumeric('30/06/2024')).toBeNaN()
    expect(toNumeric('06/30/2024')).toBeNaN()
    expect(toNumeric('June 30, 2024')).toBeNaN()
    expect(toNumeric('2024-02-30')).toBeNaN()
    expect(toNumeric('2024-06-30T10:00:00junk')).toBeNaN()
  })

  it('reads an entity whose values are all blank as missing after aggregation', () => {
    const rows = [
      { pid: 1, v: '' },
      { pid: 1, v: ' ' },
      { pid: 2, v: '4' },
    ]
    const out = aggregateByEntity(rows, 'pid', 'mean')
    expect(out.map((r) => toNumeric(r.v))).toEqual([NaN, 4])
  })
})
