import { describe, it, expect } from 'vitest'
import { computeSpc, detectStatisticType, suggestChartType } from './spc-compute'
import type { SpcConfig } from './spc-compute'
import type { PeriodPoint } from './spc-types'

/** One row per month, `count` months running from 2024-01. */
function monthlyRows(count: number, make: (i: number) => Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    const month = String((i % 12) + 1).padStart(2, '0')
    const year = 2024 + Math.floor(i / 12)
    out.push({ date: `${year}-${month}-15`, ...make(i) })
  }
  return out
}

/** `perMonth` rows in each of `months` consecutive months from 2024-01. */
function monthlyCohorts(
  months: number,
  perMonth: number,
  make: (monthIndex: number, k: number) => Record<string, unknown>,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let m = 0; m < months; m++) {
    const year = 2024 + Math.floor(m / 12)
    const month = String((m % 12) + 1).padStart(2, '0')
    for (let k = 0; k < perMonth; k++) {
      out.push({ date: `${year}-${month}-15`, ...make(m, k) })
    }
  }
  return out
}

const BASE: SpcConfig = {
  statisticType: 'auto',
  chartType: 'auto',
  dateColumn: 'date',
  valueColumn: 'flag',
  period: 'month',
  denominatorMode: 'cases',
}

describe('detectStatisticType', () => {
  it('reads a many-valued numeric column as a measurement', () => {
    const rows = monthlyRows(20, i => ({ los: 3 + (i % 9) }))
    expect(detectStatisticType(rows, 'los', 'cases')).toBe('measurement')
  })

  it('reads a 0/1 flag as a proportion, not a measurement', () => {
    // The trap: a flag parses as numeric, but charting its monthly mean as an
    // x-bar chart is a different statistic from the proportion it really is.
    const rows = monthlyRows(20, i => ({ died: i % 3 === 0 ? 1 : 0 }))
    expect(detectStatisticType(rows, 'died', 'cases')).toBe('proportion')
  })

  it('reads a categorical column as a proportion or a rate, per the denominator', () => {
    const rows = monthlyRows(20, i => ({ vap: i % 4 === 0 ? 'Oui' : 'Non' }))
    expect(detectStatisticType(rows, 'vap', 'cases')).toBe('proportion')
    expect(detectStatisticType(rows, 'vap', 'patient-days')).toBe('rate')
  })

  it('falls back to a proportion on an empty column rather than throwing', () => {
    expect(detectStatisticType([{ x: null }], 'x', 'cases')).toBe('proportion')
  })
})

describe('suggestChartType', () => {
  const pts = (n: number, y: number, denom: number): PeriodPoint[] =>
    Array.from({ length: n }, (_, i) => ({ date: `2024-${String(i + 1).padStart(2, '0')}-01`, y, n: denom }))

  it('sends a measurement to an individuals chart', () => {
    expect(suggestChartType('measurement', pts(12, 5, 1))).toBe('i-mr')
  })

  it('prefers a prime chart when denominators are large enough to overdisperse', () => {
    expect(suggestChartType('proportion', pts(12, 30, 1000))).toBe('p-prime')
    expect(suggestChartType('proportion', pts(12, 3, 50))).toBe('p')
  })

  it('sends a rare event to a g-chart', () => {
    expect(suggestChartType('rare-event', pts(12, 30, 1))).toBe('g')
  })
})

describe('computeSpc — the silent-option bug', () => {
  // The regression this plugin exists to prevent. The hand-written R script
  // branched on "is the column numeric?" BEFORE consulting the configured
  // denominator, so 18 of NeoCLIP's 20 EWMA widgets set
  // denominator = "patient_days_overlap" on a numeric column and silently got an
  // x-bar chart of the median instead of the rate their title promised.
  const rows = monthlyRows(24, i => ({
    vent_days: 4 + (i % 7),
    adm: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
    dis: `2024-${String((i % 12) + 1).padStart(2, '0')}-10`,
  }))

  it('warns instead of silently ignoring a denominator that cannot apply', () => {
    const result = computeSpc(rows, {
      ...BASE,
      valueColumn: 'vent_days',
      denominatorMode: 'patient-days',
      admissionColumn: 'adm',
      dischargeColumn: 'dis',
    })
    expect(result).not.toBeNull()
    // It still charts something sensible — a measurement — but says so.
    expect(result!.chartType).toBe('i-mr')
    const ignored = result!.warnings.find(w => w.code === 'option-ignored')
    expect(ignored).toBeDefined()
    expect(ignored!.detail).toBe('patient-days')
  })

  it('honours an explicit statistic type over auto-detection', () => {
    const result = computeSpc(rows, {
      ...BASE,
      statisticType: 'rate',
      valueColumn: 'vent_days',
      denominatorMode: 'patient-days',
      admissionColumn: 'adm',
      dischargeColumn: 'dis',
    })
    // Forced to a rate, it computes the rate — no silent fallback to x-bar.
    expect(result!.chartType).toMatch(/^u/)
    expect(result!.warnings.some(w => w.code === 'option-ignored')).toBe(false)
  })
})

describe('computeSpc — end to end', () => {
  it('charts a monthly proportion with staircase limits', () => {
    // 12 months of 20 patients, 2 events each month.
    const rows = monthlyCohorts(12, 20, (_m, k) => ({ flag: k < 2 ? 'Oui' : 'Non' }))
    const result = computeSpc(rows, { ...BASE, statisticType: 'proportion', eventValues: ['Oui'] })
    expect(result).not.toBeNull()
    expect(result!.points.length).toBe(12)
    expect(result!.points[0].denominator).toBe(20)
    expect(result!.centre).toBeCloseTo(0.1, 10)
    expect(result!.points.every(p => p.ucl !== null && p.lcl !== null)).toBe(true)
  })

  it('widens the limits for a month with fewer patients', () => {
    const rows = [
      ...monthlyCohorts(1, 200, (_m, k) => ({ flag: k < 20 ? 'Oui' : 'Non' })),
      ...Array.from({ length: 50 }, (_, k) => ({ date: '2024-02-15', flag: k < 5 ? 'Oui' : 'Non' })),
    ]
    const result = computeSpc(rows, { ...BASE, statisticType: 'proportion', chartType: 'p', eventValues: ['Oui'] })
    const [january, february] = result!.points
    expect(january.denominator).toBe(200)
    expect(february.denominator).toBe(50)
    expect(february.ucl!).toBeGreaterThan(january.ucl!)
  })

  it('freezes the limits on the baseline so a later shift signals', () => {
    // Stable at 10% for a year, then 60% for a year.
    const rows: Record<string, unknown>[] = []
    for (let m = 0; m < 24; m++) {
      const year = 2024 + Math.floor(m / 12)
      const month = String((m % 12) + 1).padStart(2, '0')
      const rate = m < 12 ? 1 : 6
      for (let k = 0; k < 10; k++) {
        rows.push({ date: `${year}-${month}-15`, flag: k < rate ? 'Oui' : 'Non' })
      }
    }
    const frozen = computeSpc(rows, {
      ...BASE,
      statisticType: 'proportion',
      chartType: 'p',
      eventValues: ['Oui'],
      baselineUntil: '2024-12-31',
    })
    expect(frozen!.baselineCount).toBe(12)
    expect(frozen!.centre).toBeCloseTo(0.1, 6)
    // Every post-shift point is out of control against the frozen limits.
    const after = frozen!.points.slice(12)
    expect(after.every(p => p.signals.includes('beyond-limits'))).toBe(true)
  })

  it('flags a baseline too short to fit limits on, and falls back to all data', () => {
    const rows = monthlyRows(120, i => ({ flag: i % 10 === 0 ? 'Oui' : 'Non' }))
    const result = computeSpc(rows, {
      ...BASE,
      statisticType: 'proportion',
      eventValues: ['Oui'],
      baselineUntil: '2024-01-05', // before the first period ends
    })
    expect(result!.warnings.some(w => w.code === 'baseline-too-short')).toBe(true)
    expect(result!.baselineCount).toBe(result!.points.length)
  })

  it('suggests a g-chart when a rate rests on too few events', () => {
    const rows = monthlyRows(120, i => ({
      flag: i === 3 || i === 60 ? 'Oui' : 'Non',
      adm: '2024-01-01',
      dis: '2024-01-20',
    }))
    const result = computeSpc(rows, {
      ...BASE,
      statisticType: 'rate',
      chartType: 'u',
      eventValues: ['Oui'],
      denominatorMode: 'patient-days',
      admissionColumn: 'adm',
      dischargeColumn: 'dis',
    })
    expect(result!.warnings.some(w => w.code === 'rare-events-prefer-g')).toBe(true)
  })

  it('charts intervals between rare events on a g-chart', () => {
    const rows = [
      { date: '2024-01-01', flag: 'Oui' },
      { date: '2024-02-10', flag: 'Oui' },
      { date: '2024-04-01', flag: 'Oui' },
      { date: '2024-07-15', flag: 'Oui' },
      { date: '2024-03-01', flag: 'Non' },
    ]
    const result = computeSpc(rows, { ...BASE, statisticType: 'rare-event', eventValues: ['Oui'] })
    expect(result!.chartType).toBe('g')
    expect(result!.points.map(p => p.value)).toEqual([40, 51, 105])
  })

  it('warns when there is too little history for the limits to mean anything', () => {
    const rows = monthlyCohorts(4, 20, (_m, k) => ({ flag: k < 2 ? 'Oui' : 'Non' }))
    const result = computeSpc(rows, { ...BASE, statisticType: 'proportion', eventValues: ['Oui'] })
    expect(result!.points.length).toBe(4)
    expect(result!.warnings.some(w => w.code === 'too-few-periods')).toBe(true)
  })

  it('stays quiet about history once there are enough periods', () => {
    const rows = monthlyCohorts(12, 20, (_m, k) => ({ flag: k < 2 ? 'Oui' : 'Non' }))
    const result = computeSpc(rows, { ...BASE, statisticType: 'proportion', eventValues: ['Oui'] })
    expect(result!.warnings.some(w => w.code === 'too-few-periods')).toBe(false)
  })

  it('returns null when the required columns are missing rather than guessing', () => {
    expect(computeSpc([{ a: 1 }], { ...BASE, dateColumn: '' })).toBeNull()
    expect(computeSpc([], BASE)).toBeNull()
  })

  it('applies a rate basis to both the values and the centre', () => {
    const rows = monthlyCohorts(12, 10, (m, k) => ({
      flag: k === 0 ? 'Oui' : 'Non',
      adm: `2024-${String((m % 12) + 1).padStart(2, '0')}-01`,
      dis: `2024-${String((m % 12) + 1).padStart(2, '0')}-28`,
    }))
    const per1000 = computeSpc(rows, {
      ...BASE,
      statisticType: 'rate',
      chartType: 'u',
      eventValues: ['Oui'],
      denominatorMode: 'patient-days',
      admissionColumn: 'adm',
      dischargeColumn: 'dis',
      rateBasis: 1000,
    })
    const per100 = computeSpc(rows, {
      ...BASE,
      statisticType: 'rate',
      chartType: 'u',
      eventValues: ['Oui'],
      denominatorMode: 'patient-days',
      admissionColumn: 'adm',
      dischargeColumn: 'dis',
      rateBasis: 100,
    })
    expect(per1000!.centre).toBeCloseTo(per100!.centre * 10, 6)
    expect(per1000!.yUnit).toBe('/1000')
  })

  it('smooths with an EWMA when asked, keeping the raw counts on the point', () => {
    // Alternating 10% and 50% months: raw proportions swing by 0.4, the EWMA
    // must not.
    const rows = monthlyCohorts(12, 20, (m, k) => ({ flag: k < (m % 2 === 0 ? 2 : 10) ? 'Oui' : 'Non' }))
    const result = computeSpc(rows, {
      ...BASE,
      statisticType: 'proportion',
      chartType: 'ewma',
      eventValues: ['Oui'],
      lambda: 0.2,
    })
    expect(result!.chartType).toBe('ewma')
    expect(result!.points[0].denominator).toBe(20)
    expect(result!.points[0].numerator).toBe(2)
    const values = result!.points.map(p => p.value)
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.4)
  })
})
