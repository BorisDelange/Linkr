import { describe, it, expect } from 'vitest'
import {
  buildOverviewRows,
  medianGapPx,
  shortenDrugName,
  sameWords,
  infusionRate,
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
    conceptCode: null,
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

/**
 * These names are taken verbatim from a real MIMIC-IV-on-OMOP record. The gutter
 * truncates from the right, so what matters is that the substance survives at
 * the front — and, just as much, that two different orders never end up with the
 * same label.
 */
describe('shortenDrugName puts the substance first without merging orders', () => {
  it('moves a leading quantity to the end', () => {
    expect(shortenDrugName('1000 ML sodium chloride 9 MG/ML Injection')).toBe(
      'sodium chloride 9 MG/ML, 1000 ML',
    )
  })

  it('drops the dose form when a quantity already distinguishes the row', () => {
    expect(shortenDrugName('50 ML glucose 500 MG/ML Prefilled Syringe')).toBe(
      'glucose 500 MG/ML, 50 ML',
    )
  })

  it('keeps the brand, which is how clinicians name the drug', () => {
    expect(shortenDrugName('insulin glargine 100 UNT/ML Injectable Solution [Lantus]')).toBe(
      'insulin glargine 100 UNT/ML [Lantus], injectable solution',
    )
  })

  it('keeps the form when there is no quantity to tell rows apart', () => {
    expect(shortenDrugName('metoprolol tartrate 25 MG Oral Tablet')).toBe(
      'metoprolol tartrate 25 MG, oral tablet',
    )
  })

  it('leaves a name it does not recognise alone', () => {
    expect(shortenDrugName('Multivitamin preparation')).toBe('Multivitamin preparation')
  })

  it('never collapses two different orders onto one label', () => {
    // The bug this guards: dropping the quantity outright made five distinct
    // sodium-chloride bags render as five identical rows.
    const names = [
      '50 ML sodium chloride 9 MG/ML Injection',
      '100 ML sodium chloride 9 MG/ML Injection',
      '250 ML sodium chloride 9 MG/ML Injection',
      '500 ML sodium chloride 9 MG/ML Injection',
      '1000 ML sodium chloride 9 MG/ML Injection',
      'lidocaine hydrochloride 10 MG/ML Injectable Solution [Xylocaine]',
      '2 ML lidocaine hydrochloride 10 MG/ML Injection [Xylocaine]',
      'cholecalciferol 0.025 MG Oral Tablet',
      'cholecalciferol 0.025 MG Oral Capsule',
    ]
    expect(new Set(names.map(shortenDrugName)).size).toBe(names.length)
  })
})

/**
 * The gutter tooltip repeats the untouched name only when shortening actually
 * hid something. Comparing raw strings showed it for every drug: reordering
 * "… Oral Tablet" into "…, oral tablet" changes the text without losing a word,
 * so the tooltip said the same thing twice.
 */
describe('sameWords tells reordering apart from real loss', () => {
  it('treats a reordered, re-cased label as unchanged', () => {
    expect(
      sameWords(
        'bisacodyl 5 MG Delayed Release Oral Tablet',
        'bisacodyl 5 MG Delayed Release, oral tablet',
      ),
    ).toBe(true)
  })

  it('reports a difference when a word is genuinely dropped', () => {
    expect(
      sameWords('1000 ML sodium chloride 9 MG/ML Injection', 'sodium chloride 9 MG/ML, 1000 ML'),
    ).toBe(false)
  })

  it('does not confuse two different strengths', () => {
    expect(sameWords('bisacodyl 5 MG', 'bisacodyl 10 MG')).toBe(false)
  })
})

/**
 * The trap this guards, taken from a real record: `drug_exposure` end dates are
 * prescription windows, not administration times. An oral bisacodyl tablet spans
 * 57 hours, so dividing by the duration would report 0.18 mg/h for a drug
 * swallowed in one go. Only the route can tell the two apart.
 */
describe('infusionRate only rates what actually runs continuously', () => {
  const H = 3_600_000
  const ROUTES = ['iv drip']

  it('rates a drip: 1000 mL over 4 h is 250 mL/h', () => {
    expect(infusionRate(1000, 0, 4 * H, 'IV DRIP', ROUTES)).toBe(250)
  })

  it('is case- and space-insensitive about the route', () => {
    expect(infusionRate(150, 0, 20 * H, '  iv drip ', ROUTES)).toBe(7.5)
  })

  it('refuses an oral tablet, however long its prescription window', () => {
    expect(infusionRate(10, 0, 57 * H, 'PO', ROUTES)).toBeNull()
  })

  it('refuses an IV push — not every IV route is a drip', () => {
    expect(infusionRate(4, 0, 57 * H, 'IV', ROUTES)).toBeNull()
  })

  it('refuses when the route is unknown, rather than guessing', () => {
    expect(infusionRate(1000, 0, 4 * H, null, ROUTES)).toBeNull()
  })

  it('refuses a zero or backwards duration', () => {
    expect(infusionRate(1000, 5 * H, 5 * H, 'IV DRIP', ROUTES)).toBeNull()
    expect(infusionRate(1000, 5 * H, 1 * H, 'IV DRIP', ROUTES)).toBeNull()
  })

  it('refuses a missing or non-positive quantity', () => {
    expect(infusionRate(null, 0, 4 * H, 'IV DRIP', ROUTES)).toBeNull()
    expect(infusionRate(0, 0, 4 * H, 'IV DRIP', ROUTES)).toBeNull()
  })

  it('rates nothing when the schema declares no continuous routes', () => {
    expect(infusionRate(1000, 0, 4 * H, 'IV DRIP', [])).toBeNull()
  })

  it('refuses a span too long to be one infusion', () => {
    // 8 mg of norepinephrine over 146 h is a renewed order, not a drip: rating
    // it would report 0.05 mg/h for a vasopressor. 17% of the IV DRIP rows on a
    // real record are like this.
    expect(infusionRate(8, 0, 146 * H, 'IV DRIP', ROUTES)).toBeNull()
    expect(infusionRate(8, 0, 71 * H, 'IV DRIP', ROUTES)).not.toBeNull()
  })
})
