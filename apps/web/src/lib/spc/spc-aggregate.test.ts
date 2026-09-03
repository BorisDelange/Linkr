import { describe, it, expect } from 'vitest'
import {
  aggregate,
  eventIntervals,
  floorToPeriod,
  isoDate,
  nextPeriod,
  overlapDaysByPeriod,
  parseDate,
  periodGrid,
  toNumber,
} from './spc-aggregate'

const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`)

describe('parseDate', () => {
  it('reads plain dates, timestamps and Date objects alike', () => {
    expect(parseDate('2024-03-15')).toBe(d('2024-03-15'))
    expect(parseDate('2024-03-15 08:12:00')).toBe(d('2024-03-15'))
    expect(parseDate('2024-03-15T22:45:00Z')).toBe(d('2024-03-15'))
    expect(parseDate(new Date('2024-03-15T22:45:00Z'))).toBe(d('2024-03-15'))
  })

  it('returns null rather than an epoch date for unusable input', () => {
    expect(parseDate(null)).toBeNull()
    expect(parseDate('')).toBeNull()
    expect(parseDate('not a date')).toBeNull()
  })

  it('truncates to the day, so a late-evening event lands in its own day', () => {
    // A timestamp near midnight must not roll into the next day through a
    // timezone offset — the whole series would shift by one period.
    expect(parseDate('2024-03-15T23:59:59Z')).toBe(d('2024-03-15'))
  })
})

describe('floorToPeriod', () => {
  it('buckets to the start of the calendar period', () => {
    const ms = d('2024-05-17')
    expect(isoDate(floorToPeriod(ms, 'day'))).toBe('2024-05-17')
    expect(isoDate(floorToPeriod(ms, 'month'))).toBe('2024-05-01')
    expect(isoDate(floorToPeriod(ms, 'quarter'))).toBe('2024-04-01')
    expect(isoDate(floorToPeriod(ms, 'year'))).toBe('2024-01-01')
  })

  it('starts weeks on Monday', () => {
    // 2024-05-17 is a Friday; 2024-05-19 a Sunday, still the same ISO week.
    expect(isoDate(floorToPeriod(d('2024-05-17'), 'week'))).toBe('2024-05-13')
    expect(isoDate(floorToPeriod(d('2024-05-19'), 'week'))).toBe('2024-05-13')
    expect(isoDate(floorToPeriod(d('2024-05-20'), 'week'))).toBe('2024-05-20')
  })
})

describe('nextPeriod and periodGrid', () => {
  it('crosses year boundaries', () => {
    expect(isoDate(nextPeriod(d('2024-12-10'), 'month'))).toBe('2025-01-01')
    expect(isoDate(nextPeriod(d('2024-11-10'), 'quarter'))).toBe('2025-01-01')
  })

  it('emits a gapless grid, including periods with no data', () => {
    const grid = periodGrid(d('2024-01-15'), d('2024-04-02'), 'month')
    expect(grid.map(isoDate)).toEqual(['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01'])
  })
})

describe('overlapDaysByPeriod', () => {
  it('splits a long stay across every period it touches', () => {
    // A stay from 15 Jan to 20 Mar: 17 days in January, 29 in February, 20 in March.
    const grid = periodGrid(d('2024-01-01'), d('2024-03-01'), 'month')
    const days = overlapDaysByPeriod([{ start: d('2024-01-15'), end: d('2024-03-20') }], grid, 'month', d('2024-03-31'))
    expect(days.get(d('2024-01-01'))).toBe(17)
    expect(days.get(d('2024-02-01'))).toBe(29) // 2024 is a leap year
    expect(days.get(d('2024-03-01'))).toBe(20)
  })

  it('counts a same-day stay as one day, not zero', () => {
    const grid = periodGrid(d('2024-01-01'), d('2024-01-01'), 'month')
    const days = overlapDaysByPeriod([{ start: d('2024-01-10'), end: d('2024-01-10') }], grid, 'month', d('2024-01-31'))
    expect(days.get(d('2024-01-01'))).toBe(1)
  })

  it('clips an ongoing stay to the end of observation rather than dropping it', () => {
    const grid = periodGrid(d('2024-01-01'), d('2024-02-01'), 'month')
    const days = overlapDaysByPeriod([{ start: d('2024-01-20'), end: null }], grid, 'month', d('2024-02-10'))
    expect(days.get(d('2024-01-01'))).toBe(12)
    expect(days.get(d('2024-02-01'))).toBe(10)
  })

  it('gives a period no stay touches a denominator of 0', () => {
    const grid = periodGrid(d('2024-01-01'), d('2024-03-01'), 'month')
    const days = overlapDaysByPeriod([{ start: d('2024-03-05'), end: d('2024-03-10') }], grid, 'month', d('2024-03-31'))
    expect(days.get(d('2024-01-01'))).toBe(0)
    expect(days.get(d('2024-03-01'))).toBe(6)
  })
})

describe('aggregate — proportions', () => {
  const rows = [
    { visit_id: 'a', date: '2024-01-05', vap: 'Oui' },
    { visit_id: 'b', date: '2024-01-20', vap: 'Non' },
    { visit_id: 'c', date: '2024-02-10', vap: 'Oui' },
    { visit_id: 'd', date: '2024-02-14', vap: 'Oui' },
    { visit_id: 'e', date: '2024-02-28', vap: 'Non' },
  ]

  it('counts events over cases per period', () => {
    const pts = aggregate({
      rows,
      statisticType: 'proportion',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'vap',
      eventValues: ['Oui'],
      denominatorMode: 'cases',
    })
    expect(pts).toEqual([
      { date: '2024-01-01', y: 1, n: 2 },
      { date: '2024-02-01', y: 2, n: 3 },
    ])
  })

  it('de-duplicates to one row per stay before counting', () => {
    const withDupes = [...rows, { visit_id: 'a', date: '2024-01-06', vap: 'Oui' }]
    const pts = aggregate({
      rows: withDupes,
      statisticType: 'proportion',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'vap',
      eventValues: ['Oui'],
      denominatorMode: 'cases',
      deduplicateBy: 'visit_id',
    })
    expect(pts[0]).toEqual({ date: '2024-01-01', y: 1, n: 2 })
  })

  it('accepts several modalities as the event', () => {
    const growth = [
      { date: '2024-01-05', g: 'RCIU' },
      { date: '2024-01-06', g: 'Macrosome' },
      { date: '2024-01-07', g: 'Normal' },
    ]
    const pts = aggregate({
      rows: growth,
      statisticType: 'proportion',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'g',
      eventValues: ['RCIU', 'Macrosome'],
      denominatorMode: 'cases',
    })
    expect(pts[0]).toEqual({ date: '2024-01-01', y: 2, n: 3 })
  })

  it('treats a 0/1 flag as an event when no modality is given', () => {
    const flags = [
      { date: '2024-01-05', died: 1 },
      { date: '2024-01-06', died: 0 },
      { date: '2024-01-07', died: 1 },
    ]
    const pts = aggregate({
      rows: flags,
      statisticType: 'proportion',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'died',
      denominatorMode: 'cases',
    })
    expect(pts[0]).toEqual({ date: '2024-01-01', y: 2, n: 3 })
  })
})

describe('aggregate — rates', () => {
  const stays = [
    { visit_id: 'a', adm: '2024-01-10', dis: '2024-01-20', date: '2024-01-15', vap: 'Oui' },
    { visit_id: 'b', adm: '2024-01-25', dis: '2024-02-05', date: '2024-01-25', vap: 'Non' },
    { visit_id: 'c', adm: '2024-02-01', dis: '2024-02-15', date: '2024-02-08', vap: 'Oui' },
  ]

  it('uses clipped patient-days as the denominator', () => {
    const pts = aggregate({
      rows: stays,
      statisticType: 'rate',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'vap',
      eventValues: ['Oui'],
      denominatorMode: 'patient-days',
      admissionColumn: 'adm',
      dischargeColumn: 'dis',
    })
    // January: stay a 11 days (10-20), stay b 7 days (25-31) = 18
    // February: stay b 5 days (1-5), stay c 15 days (1-15) = 20
    expect(pts).toEqual([
      { date: '2024-01-01', y: 1, n: 18 },
      { date: '2024-02-01', y: 1, n: 20 },
    ])
  })

  it('sums an exposure column when one is given', () => {
    const pts = aggregate({
      rows: [
        { date: '2024-01-05', vap: 'Oui', vent_days: 4 },
        { date: '2024-01-15', vap: 'Non', vent_days: 6 },
      ],
      statisticType: 'rate',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'vap',
      eventValues: ['Oui'],
      denominatorMode: 'exposure-column',
      exposureColumn: 'vent_days',
    })
    expect(pts).toEqual([{ date: '2024-01-01', y: 1, n: 10 }])
  })

  it('uses device boundaries for a device-days denominator', () => {
    const pts = aggregate({
      rows: [{ date: '2024-01-15', clabsi: 'Oui', line_in: '2024-01-10', line_out: '2024-01-20' }],
      statisticType: 'rate',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'clabsi',
      eventValues: ['Oui'],
      denominatorMode: 'device-days',
      deviceStartColumn: 'line_in',
      deviceEndColumn: 'line_out',
    })
    expect(pts).toEqual([{ date: '2024-01-01', y: 1, n: 11 }])
  })

  it('takes the denominator from unfiltered rows when they are supplied', () => {
    // The numerator is the infected stays; the denominator must be every stay.
    const infected = [{ visit_id: 'a', adm: '2024-01-01', dis: '2024-01-10', date: '2024-01-05', vap: 'Oui' }]
    const all = [
      ...infected,
      { visit_id: 'b', adm: '2024-01-01', dis: '2024-01-10', date: '2024-01-05', vap: 'Non' },
    ]
    const pts = aggregate({
      rows: infected,
      denominatorRows: all,
      statisticType: 'rate',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'vap',
      eventValues: ['Oui'],
      denominatorMode: 'patient-days',
      admissionColumn: 'adm',
      dischargeColumn: 'dis',
    })
    expect(pts[0].n).toBe(20) // both stays, not just the infected one
    expect(pts[0].y).toBe(1)
  })

  it('keeps a period with exposure but no event, as a real zero', () => {
    const pts = aggregate({
      rows: [
        { adm: '2024-01-01', dis: '2024-01-05', date: '2024-01-02', vap: 'Non' },
        { adm: '2024-02-01', dis: '2024-02-05', date: '2024-02-02', vap: 'Oui' },
      ],
      statisticType: 'rate',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'vap',
      eventValues: ['Oui'],
      denominatorMode: 'patient-days',
      admissionColumn: 'adm',
      dischargeColumn: 'dis',
    })
    expect(pts.map(p => p.y)).toEqual([0, 1])
    expect(pts.every(p => p.n > 0)).toBe(true)
  })
})

describe('aggregate — measurements', () => {
  const rows = [
    { date: '2024-01-05', los: 3 },
    { date: '2024-01-15', los: 7 },
    { date: '2024-01-25', los: 5 },
    { date: '2024-02-05', los: 10 },
  ]

  it('aggregates with the requested function', () => {
    const med = aggregate({
      rows,
      statisticType: 'measurement',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'los',
      denominatorMode: 'cases',
      aggregation: 'median',
    })
    expect(med[0].y).toBe(5)

    const mean = aggregate({
      rows,
      statisticType: 'measurement',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'los',
      denominatorMode: 'cases',
      aggregation: 'mean',
    })
    expect(mean[0].y).toBe(5)
  })

  it('carries the within-period variance and count for staircase limits', () => {
    const pts = aggregate({
      rows,
      statisticType: 'measurement',
      dateColumn: 'date',
      period: 'month',
      valueColumn: 'los',
      denominatorMode: 'cases',
    })
    expect(pts[0].n).toBe(3)
    expect(pts[0].variance).toBeCloseTo(4, 10) // var of [3,7,5] = 4
    // A single observation has no variance to report.
    expect(pts[1].variance).toBeUndefined()
  })
})

describe('eventIntervals', () => {
  it('returns the days between consecutive events', () => {
    const pts = eventIntervals(
      [
        { date: '2024-01-01', ev: 'Oui' },
        { date: '2024-01-15', ev: 'Oui' },
        { date: '2024-02-01', ev: 'Oui' },
        { date: '2024-01-20', ev: 'Non' },
      ],
      'date',
      'ev',
      ['Oui'],
    )
    expect(pts.map(p => p.y)).toEqual([14, 17])
  })

  it('yields nothing below two events — an interval needs a pair', () => {
    expect(eventIntervals([{ date: '2024-01-01', ev: 'Oui' }], 'date', 'ev', ['Oui'])).toEqual([])
  })

  it('keeps a same-day repeat as a zero interval, which is a real cluster', () => {
    const pts = eventIntervals(
      [
        { date: '2024-01-01', ev: 'Oui' },
        { date: '2024-01-01', ev: 'Oui' },
      ],
      'date',
      'ev',
      ['Oui'],
    )
    expect(pts.map(p => p.y)).toEqual([0])
  })
})

describe('toNumber', () => {
  it('accepts a comma decimal separator', () => {
    expect(toNumber('3,5')).toBe(3.5)
  })

  it('rejects blanks and non-numbers rather than coercing them to 0', () => {
    expect(toNumber('')).toBeNull()
    expect(toNumber(null)).toBeNull()
    expect(toNumber('abc')).toBeNull()
  })
})
