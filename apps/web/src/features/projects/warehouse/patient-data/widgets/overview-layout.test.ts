import { describe, it, expect } from 'vitest'
import {
  buildOverviewRows,
  medianGapPx,
  shortenDrugName,
  looksLikeDrugName,
  sameWords,
  hourlyRate,
  unitIsRate,
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
 * A rate here is an average over the recorded window, not a prescribed rate:
 * OMOP end dates are order-validity periods. The figure is shown with the route
 * beside it so the reader can judge; the code does not try to classify, because
 * the standard vocabulary calls a drip and a bolus both "Intravenous".
 */
describe('hourlyRate spreads a dose over its recorded period', () => {
  const H = 3_600_000

  it('divides the quantity by the elapsed hours', () => {
    expect(hourlyRate(1000, 0, 4 * H)).toBe(250)
    expect(hourlyRate(150, 0, 20 * H)).toBe(7.5)
  })

  it('has no rate without an end, so an instant event stays a plain dose', () => {
    expect(hourlyRate(1000, 0, null)).toBeNull()
  })

  it('refuses a zero or backwards period rather than dividing by zero', () => {
    expect(hourlyRate(1000, 5 * H, 5 * H)).toBeNull()
    expect(hourlyRate(1000, 5 * H, 1 * H)).toBeNull()
  })

  it('refuses a missing or non-positive quantity', () => {
    expect(hourlyRate(null, 0, 4 * H)).toBeNull()
    expect(hourlyRate(0, 0, 4 * H)).toBeNull()
    expect(hourlyRate(-5, 0, 4 * H)).toBeNull()
  })
})

/**
 * Which names get shortened is decided by the NAME, not by the table it came
 * from: OMOP calls the table "Drug", MIMIC "Prescriptions", and the next model
 * something else. Triggering on the table label silently skipped MIMIC.
 */
describe('looksLikeDrugName reads the name, not the schema', () => {
  it('recognises RxNorm-style names whatever table they came from', () => {
    for (const n of [
      '1000 ML sodium chloride 9 MG/ML Injection',
      'metoprolol tartrate 25 MG Oral Tablet',
      'insulin glargine 100 UNT/ML Injectable Solution [Lantus]',
      'bisacodyl 10 MG Rectal Suppository',
    ]) expect(looksLikeDrugName(n), n).toBe(true)
  })

  it('leaves MIMIC drug names alone — they are already short', () => {
    for (const n of ['Vancomycin', 'Heparin', 'Dextrose 50%', 'Heparin Flush (10 units/ml)'])
      expect(looksLikeDrugName(n), n).toBe(false)
  })

  it('does not mistake a LOINC name for a brand', () => {
    // LOINC brackets look like RxNorm brand suffixes, so a bare bracket test
    // would mangle every lab name. A brand only counts beside a strength.
    for (const n of [
      'Leukocytes [#/volume] in Blood by Automated count',
      'Erythrocyte [DistWidth] in Red Blood Cells by Automated count',
      'Body mass index (BMI) [Ratio]',
      'Heart rate',
    ]) expect(looksLikeDrugName(n), n).toBe(false)
  })
})

// The overflow lived exactly at `budget === tables * 3`, where the class level
// looks affordable only if the unit lane is counted as free. One fixed record
// never lands on that boundary, so the table count is swept alongside the
// budget rather than held constant.
describe('buildOverviewRows — the unit lane is paid for, not assumed free', () => {
  function nTables(n: number): OverviewConceptRow[] {
    const out: OverviewConceptRow[] = []
    for (let t = 0; t < n; t++) {
      for (let i = 0; i < 6; i++) {
        out.push(concept(`table_${t}`, `t${t}_c${i}`, 50 - i, `Class ${i % 3}`))
      }
    }
    return out
  }

  it('fits the budget at every table-count × budget boundary, with units shown', () => {
    for (let tables = 1; tables <= 8; tables++) {
      const concepts = nTables(tables)
      for (let budget = 4; budget <= tables * 3 + 6; budget++) {
        for (const byClass of [false, true]) {
          const { rows } = buildOverviewRows({
            ...base,
            concepts,
            budget,
            byClass,
            hasUnits: true,
          })
          expect(
            rows.length,
            `${tables} tables, budget ${budget}, byClass=${byClass} produced ${rows.length} rows`,
          ).toBeLessThanOrEqual(budget)
        }
      }
    }
  })

  it('still fills the height when there is no unit lane to pay for', () => {
    const concepts = nTables(2)
    const withUnits = buildOverviewRows({ ...base, concepts, budget: 6, byClass: true, hasUnits: true })
    const without = buildOverviewRows({ ...base, concepts, budget: 6, byClass: true, hasUnits: false })
    expect(withUnits.rows.length).toBeLessThanOrEqual(6)
    expect(without.rows.length).toBeLessThanOrEqual(6)
    // Dropping the lane frees exactly one row for content, never more.
    expect(without.rows.filter((r) => r.kind !== 'units').length).toBeGreaterThanOrEqual(
      withUnits.rows.filter((r) => r.kind !== 'units').length,
    )
  })
})

// The inventory query resolves a concept's unit with MAX(), which picks one
// alphabetically. That is right for a concept charted in one unit and a wrong
// clinical fact for one charted in several — a drug in both mg and mL.
describe('units that cannot be trusted are not shown', () => {
  function unitConcept(unit: string | null, unitCount: number): OverviewConceptRow {
    return { ...concept('measurement', 'c1', 10), unit, unitCount }
  }

  const opts = { ...base, byClass: false, hasUnits: false, budget: 40 }

  it('labels a concept charted in a single unit', () => {
    const { rows } = buildOverviewRows({ ...opts, concepts: [unitConcept('mmHg', 1)] })
    expect(rows.find((r) => r.kind === 'concept')?.unit).toBe('mmHg')
  })

  it('withholds the unit when the concept was charted in several', () => {
    const { rows } = buildOverviewRows({ ...opts, concepts: [unitConcept('mL', 3)] })
    expect(rows.find((r) => r.kind === 'concept')?.unit).toBeNull()
  })

  it('treats a missing count as single-unit, so older data still labels', () => {
    const c = { ...concept('measurement', 'c1', 10), unit: 'kg' }
    const { rows } = buildOverviewRows({ ...opts, concepts: [c] })
    expect(rows.find((r) => r.kind === 'concept')?.unit).toBe('kg')
  })
})

describe('unitIsRate', () => {
  it('recognises the rate units a value column can already hold', () => {
    for (const u of ['mL/h', 'mL/hr', 'mcg/kg/min', 'U/hour', 'mg / min', 'L/day', 'mL/h.']) {
      expect(unitIsRate(u), u).toBe(true)
    }
  })

  it('leaves plain quantity units alone, so the rate is still derived', () => {
    for (const u of ['mL', 'mg', 'mmHg', 'kg', '%', 'mEq/L', 'mg/dL', null, undefined, '']) {
      expect(unitIsRate(u), String(u)).toBe(false)
    }
  })
})
