import { describe, it, expect } from 'vitest'
import { buildDescriptiveTable, quantile, fmt, DASH, type VariableSpec } from './descriptive-table'

const numeric: VariableSpec = { id: 'age', label: 'Âge', kind: 'numeric' }
const categorical: VariableSpec = { id: 'svc', label: 'Type de service', kind: 'categorical' }

describe('quantile (R type 7)', () => {
  it('matches R on a known vector', () => {
    // R: quantile(c(1,2,3,4,5,6,7,8,9,10)) -> 25% = 3.25, 50% = 5.5, 75% = 7.75
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(quantile(x, 0.25)).toBeCloseTo(3.25, 6)
    expect(quantile(x, 0.5)).toBeCloseTo(5.5, 6)
    expect(quantile(x, 0.75)).toBeCloseTo(7.75, 6)
  })

  it('handles the degenerate sizes', () => {
    expect(quantile([], 0.5)).toBeNaN()
    expect(quantile([7], 0.5)).toBe(7)
  })
})

describe('fmt', () => {
  it('keeps integers integral and never prints a trailing .0', () => {
    expect(fmt(42)).toBe('42')
    expect(fmt(42.25)).toBe('42.3')
    expect(fmt(NaN)).toBe(DASH)
  })
})

describe('buildDescriptiveTable — categorical levels', () => {
  const rows = [
    { svc: 'ICU' }, { svc: 'ICU' }, { svc: 'ICU' },
    { svc: 'HDU' }, { svc: 'HDU' },
    { svc: null },
  ]

  it('emits a heading row plus one indented row per level', () => {
    const t = buildDescriptiveTable({ rows, variables: [categorical] })
    const labels = t.rows.map((r) => [r.label, r.indent])
    expect(labels).toEqual([
      ['Type de service', false],
      ['ICU', true],
      ['HDU', true],
      ['Missing', true],
    ])
  })

  it('takes percentages over those who ANSWERED, not the total', () => {
    // 5 answered of 6. ICU is 3/5 = 60%, not 3/6 = 50% — otherwise the levels
    // sum to less than 100% and read as an arithmetic mistake.
    const t = buildDescriptiveTable({ rows, variables: [categorical] })
    expect(t.rows[1].cells[''].text).toBe('3 (60%)')
    expect(t.rows[2].cells[''].text).toBe('2 (40%)')
  })

  it('reports missing over the group TOTAL, since that is what makes it missing', () => {
    const t = buildDescriptiveTable({ rows, variables: [categorical] })
    expect(t.rows[3].cells[''].text).toBe('1 (17%)')
  })

  it('orders levels by frequency, so the dominant category leads', () => {
    const skewed = [{ svc: 'a' }, { svc: 'b' }, { svc: 'b' }, { svc: 'b' }]
    const t = buildDescriptiveTable({ rows: skewed, variables: [categorical] })
    expect(t.rows.filter((r) => r.indent).map((r) => r.label)).toEqual(['b', 'a'])
  })

  it('folds the tail into Other rather than dropping it', () => {
    const many = ['a', 'a', 'a', 'b', 'b', 'c', 'd'].map((svc) => ({ svc }))
    const t = buildDescriptiveTable({ rows: many, variables: [categorical], maxLevels: 2, othersLabel: 'Autres' })
    const levels = t.rows.filter((r) => r.indent)
    expect(levels.map((r) => r.label)).toEqual(['a', 'b', 'Autres'])
    // c and d, i.e. 2 of 7 answered.
    expect(levels[2].cells[''].text).toBe('2 (29%)')
  })
})

describe('buildDescriptiveTable — numeric', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((age) => ({ age }))

  it('defaults to median [IQR]', () => {
    const t = buildDescriptiveTable({ rows, variables: [numeric] })
    expect(t.rows[0].cells[''].text).toBe('5.5 [3.3–7.8]')
  })

  it('uses the sample SD (n-1), not the population one', () => {
    const t = buildDescriptiveTable({ rows, variables: [numeric], stat: 'mean_sd' })
    // R: mean = 5.5, sd = 3.0277. The population SD would be 2.87, so the
    // digit after the point is what distinguishes the two.
    expect(t.rows[0].cells[''].text).toBe('5.5 ± 3.0')
  })

  it('shows a dash rather than NaN when nothing is measurable', () => {
    const t = buildDescriptiveTable({ rows: [{ age: null }, { age: '' }], variables: [numeric] })
    expect(t.rows[0].cells[''].text).toBe(DASH)
  })

  it('reads a decimal comma, which French exports produce', () => {
    const t = buildDescriptiveTable({ rows: [{ age: '1,5' }, { age: '2,5' }], variables: [numeric] })
    expect(t.rows[0].cells[''].text).toBe('2 [1.8–2.3]')
  })
})

describe('buildDescriptiveTable — grouping', () => {
  const rows = [
    { arm: 'A', svc: 'ICU' }, { arm: 'A', svc: 'ICU' }, { arm: 'A', svc: 'HDU' },
    { arm: 'B', svc: 'ICU' }, { arm: 'B', svc: 'HDU' },
  ]

  it('splits into one cell per group, with the group sizes', () => {
    const t = buildDescriptiveTable({
      rows, variables: [categorical], groupBy: { id: 'arm', label: 'Arm' },
    })
    expect(t.groups).toEqual(['A', 'B'])
    expect(t.groupSizes).toEqual({ A: 3, B: 2 })
    const icu = t.rows.find((r) => r.label === 'ICU')!
    expect(icu.cells.A.text).toBe('2 (67%)')
    expect(icu.cells.B.text).toBe('1 (50%)')
  })

  it('keeps rows whose group value is missing as their own group', () => {
    // Dropping them would silently change every other column's denominator.
    const withGap = [...rows, { arm: null, svc: 'ICU' }]
    const t = buildDescriptiveTable({
      rows: withGap, variables: [categorical], groupBy: { id: 'arm', label: 'Arm' },
    })
    expect(t.groups).toContain(DASH)
    expect(t.groupSizes[DASH]).toBe(1)
    expect(t.total).toBe(6)
  })
})
