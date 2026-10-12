import { describe, expect, it } from 'vitest'
import { placeEvents } from './spc-events'

const ev = (id: string, date: string) => ({ id, date })
const months = ['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01'].map(date => ({ date }))

describe('placeEvents — periodic charts', () => {
  it('snaps an event to the month that contains it', () => {
    const out = placeEvents(months, [ev('a', '2025-02-17')], 'month', 'p')
    expect(out).toEqual([{ pointDate: '2025-02-01', events: [ev('a', '2025-02-17')] }])
  })

  it('keeps a time of day on the same day', () => {
    const out = placeEvents(months, [ev('a', '2025-03-31T23:59')], 'month', 'u')
    expect(out[0].pointDate).toBe('2025-03-01')
  })

  it('places the first and last day of a period in it', () => {
    const out = placeEvents(months, [ev('a', '2025-01-01'), ev('b', '2025-04-30')], 'month', 'p')
    expect(out.map(m => m.pointDate)).toEqual(['2025-01-01', '2025-04-01'])
  })

  it('groups events that fall in the same period', () => {
    const out = placeEvents(months, [ev('a', '2025-02-03'), ev('b', '2025-02-20')], 'month', 'p')
    expect(out).toHaveLength(1)
    expect(out[0].events.map(e => e.id)).toEqual(['a', 'b'])
  })

  it('does not draw an event outside the plotted periods', () => {
    expect(placeEvents(months, [ev('a', '2024-12-31'), ev('b', '2025-05-01')], 'month', 'p')).toEqual([])
  })

  it('passes an event in an unplotted period on to the next point', () => {
    const gappy = [{ date: '2025-01-01' }, { date: '2025-03-01' }]
    expect(placeEvents(gappy, [ev('a', '2025-02-10')], 'month', 'i-mr')[0].pointDate).toBe('2025-03-01')
  })

  it('uses quarter boundaries', () => {
    const quarters = [{ date: '2025-01-01' }, { date: '2025-04-01' }]
    const out = placeEvents(quarters, [ev('a', '2025-03-31'), ev('b', '2025-06-30')], 'quarter', 'p')
    expect(out.map(m => m.pointDate)).toEqual(['2025-01-01', '2025-04-01'])
  })

  it('uses ISO weeks starting on Monday', () => {
    // 2025-03-03 is a Monday; Sunday 2025-03-09 still belongs to that week.
    const weeks = [{ date: '2025-03-03' }, { date: '2025-03-10' }]
    expect(placeEvents(weeks, [ev('a', '2025-03-09')], 'week', 'c')[0].pointDate).toBe('2025-03-03')
  })

  it('skips an event whose date cannot be read', () => {
    expect(placeEvents(months, [ev('a', 'soon')], 'month', 'p')).toEqual([])
  })
})

describe('placeEvents — g and t charts', () => {
  const intervals = [{ date: '2025-01-10' }, { date: '2025-02-20' }, { date: '2025-05-02' }]

  it('snaps to the interval that ends on or after the event', () => {
    const out = placeEvents(intervals, [ev('a', '2025-03-01'), ev('b', '2025-02-20')], 'month', 'g')
    expect(out.map(m => [m.pointDate, m.events.map(e => e.id)])).toEqual([
      ['2025-02-20', ['b']],
      ['2025-05-02', ['a']],
    ])
  })

  it('ignores the period setting, which g and t charts do not use', () => {
    expect(placeEvents(intervals, [ev('a', '2025-03-01')], 'year', 't')[0].pointDate).toBe('2025-05-02')
  })

  it('does not draw before the first or after the last interval', () => {
    expect(placeEvents(intervals, [ev('a', '2025-01-09'), ev('b', '2025-05-03')], 'month', 'g')).toEqual([])
  })
})
