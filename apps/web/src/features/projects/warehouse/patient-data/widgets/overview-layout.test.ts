import { describe, it, expect } from 'vitest'
import {
  buildOverviewRows,
  medianGapPx,
  type OverviewConceptRow,
} from './overview-layout'

/**
 * The layout's contract is "fit the height you were given". A figure taller than
 * its container is the failure that actually shows on a small widget, so the
 * budget invariant is checked across every size rather than at one.
 */

function concept(
  table: string,
  id: string,
  eventCount: number,
  conceptClass: string | null = null,
): OverviewConceptRow {
  return {
    table,
    conceptId: id,
    conceptName: `Concept ${id}`,
    conceptClass,
    unit: null,
    eventCount,
    durational: false,
  }
}

/** A record shaped like a real one: one dominant table plus a long tail. */
function sampleRecord(): OverviewConceptRow[] {
  const out: OverviewConceptRow[] = []
  const classes = ['Lab Test', 'Clinical Observation', 'Observable Entity']
  for (let i = 0; i < 190; i++) {
    out.push(concept('measurement', `m${i}`, 200 - i, classes[i % classes.length]))
  }
  for (let i = 0; i < 30; i++) out.push(concept('drug_exposure', `d${i}`, 40 - i, 'Clinical Drug'))
  for (let i = 0; i < 12; i++) out.push(concept('observation', `o${i}`, 10, 'Survey'))
  for (let i = 0; i < 4; i++) out.push(concept('procedure_occurrence', `p${i}`, 3, 'Procedure'))
  out.push(concept('specimen', 's0', 13, null))
  return out
}

const base = {
  concepts: sampleRecord(),
  byClass: false,
  hasUnits: true,
  unitsTable: 'visit_detail',
  collapsed: new Set<string>(),
  hidden: new Set<string>(),
  offsets: new Map<string, number>(),
}

describe('buildOverviewRows — the figure fits its height', () => {
  const budgets = [4, 6, 8, 10, 12, 15, 18, 20, 25, 30, 40, 60, 80, 120]

  for (const byClass of [false, true]) {
    it(`never exceeds the budget (byClass=${byClass})`, () => {
      for (const budget of budgets) {
        const { rows } = buildOverviewRows({ ...base, budget, byClass })
        expect(
          rows.length,
          `budget ${budget} produced ${rows.length} rows`,
        ).toBeLessThanOrEqual(budget)
      }
    })
  }

  it('shows more concepts individually as the height grows', () => {
    const small = buildOverviewRows({ ...base, budget: 20 })
    const large = buildOverviewRows({ ...base, budget: 80 })
    const count = (r: ReturnType<typeof buildOverviewRows>) =>
      r.rows.filter((x) => x.kind === 'concept').length
    expect(count(large)).toBeGreaterThan(count(small))
  })

  it('keeps every table visible even when one dominates', () => {
    const { rows } = buildOverviewRows({ ...base, budget: 30 })
    const tables = rows.filter((r) => r.kind === 'table').map((r) => r.table)
    // measurement holds 190 of 237 concepts; the small tables must still appear.
    expect(tables).toContain('specimen')
    expect(tables).toContain('procedure_occurrence')
  })

  it('never loses events: what is not shown is folded into "other"', () => {
    const { rows } = buildOverviewRows({ ...base, budget: 25 })
    const drawn = new Set<string>()
    for (const r of rows) {
      if (r.kind === 'concept' || r.kind === 'other') {
        for (const id of r.conceptIds) drawn.add(id)
      }
    }
    expect(drawn.size).toBe(base.concepts.length)
  })
})

describe('collapsing and hiding free space for the rest', () => {
  it('collapsing a table hands its lines to the others', () => {
    const open = buildOverviewRows({ ...base, budget: 40 })
    const shut = buildOverviewRows({
      ...base,
      budget: 40,
      collapsed: new Set(['measurement']),
    })
    const drugRows = (r: ReturnType<typeof buildOverviewRows>) =>
      r.rows.filter((x) => x.table === 'drug_exposure' && x.kind === 'concept').length
    expect(drugRows(shut)).toBeGreaterThan(drugRows(open))
  })

  it('a hidden table keeps its header but draws nothing', () => {
    const { rows } = buildOverviewRows({
      ...base,
      budget: 40,
      hidden: new Set(['measurement']),
    })
    const own = rows.filter((r) => r.table === 'measurement')
    expect(own).toHaveLength(1)
    expect(own[0].kind).toBe('table')
  })
})

describe('scrolling a group slides a window over its concepts', () => {
  it('folds what scrolled away into "other", and reports how many', () => {
    const offsets = new Map([['measurement', 5]])
    const { rows } = buildOverviewRows({ ...base, budget: 40, offsets })
    const other = rows.find((r) => r.table === 'measurement' && r.kind === 'other')
    expect(other?.scrolledAbove).toBe(5)
    expect(other?.scrolledBelow).toBeGreaterThan(0)
  })

  it('clamps an offset past the end, so the band is never empty', () => {
    const offsets = new Map([['measurement', 9999]])
    const result = buildOverviewRows({ ...base, budget: 40, offsets })
    const shown = result.rows.filter(
      (r) => r.table === 'measurement' && r.kind === 'concept',
    ).length
    expect(shown).toBeGreaterThan(0)
    const win = result.windows.get('measurement')!
    expect(result.offsets.get('measurement')).toBe(win.total - win.shown)
  })
})

describe('the concept-class level', () => {
  it('adds a level when the height can afford it', () => {
    const { rows, classesDropped } = buildOverviewRows({ ...base, budget: 60, byClass: true })
    expect(classesDropped).toBe(false)
    expect(rows.some((r) => r.kind === 'class')).toBe(true)
  })

  it('drops back to the flat tree when it cannot, rather than overflowing', () => {
    const { rows, classesDropped } = buildOverviewRows({ ...base, budget: 12, byClass: true })
    expect(classesDropped).toBe(true)
    expect(rows.some((r) => r.kind === 'class')).toBe(false)
    expect(rows.length).toBeLessThanOrEqual(12)
  })
})

describe('medianGapPx picks density over collision, not over count', () => {
  it('is the median, so one long quiet stretch cannot mask a dense burst', () => {
    // 10 events one minute apart, then a one-year gap.
    const minute = 60_000
    const ts = [0, minute, 2 * minute, 3 * minute, 4 * minute, 365 * 24 * 3600_000]
    const span = 365 * 24 * 3600_000
    const gap = medianGapPx(ts, 1000, span)
    // The mean would be dragged up by the year; the median stays at a minute.
    expect(gap).toBeLessThan(1)
  })

  it('returns Infinity below two events, so a lone mark always draws', () => {
    expect(medianGapPx([5], 1000, 1000)).toBe(Infinity)
    expect(medianGapPx([], 1000, 1000)).toBe(Infinity)
  })
})
