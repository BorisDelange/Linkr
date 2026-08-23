import { describe, it, expect } from 'vitest'
import {
  summarizeQuestion,
  describe as describeStats,
  quantile,
  sortCounts,
  crossTabulate,
  coSelectionMatrix,
  selectionCountDistribution,
  jaccardMatrix,
  isTicked,
  isBlank,
  toNumber,
} from './survey-analysis'
import type { SurveyQuestion, SurveySchema } from './survey-schema'

const SINGLE: SurveyQuestion = {
  name: 'type_structure',
  label: { fr: 'Type de structure' },
  kind: 'select_one',
  listName: 'type_structure',
  binding: { kind: 'single_column', column: 'type_structure' },
}

const MULTI: SurveyQuestion = {
  name: 'usi',
  label: { fr: 'Quelles USI ?' },
  kind: 'select_multiple',
  listName: 'usi',
  binding: {
    kind: 'one_hot',
    columns: [
      { code: 'usic', column: 'usi___usic' },
      { code: 'usinv', column: 'usi___usinv' },
      { code: 'usih', column: 'usi___usih' },
    ],
  },
}

const NUMERIC: SurveyQuestion = {
  name: 'lits',
  label: { fr: 'Nombre de lits' },
  kind: 'integer',
  binding: { kind: 'single_column', column: 'lits' },
}

/** One schema holding all three, so tests read like real usage. */
const SCHEMA: SurveySchema = {
  source: 'generic',
  questions: [SINGLE, MULTI, NUMERIC],
  choices: {
    type_structure: [
      { name: 'chu_chr', label: { fr: 'CHU/CHR' } },
      { name: 'ch', label: { fr: 'Centre Hospitalier' } },
      { name: 'esprv', label: { fr: 'Privé' } },
    ],
    usi: [
      { name: 'usic', label: { fr: 'Cardiologie' } },
      { name: 'usinv', label: { fr: 'Neuro-vasculaire' } },
      { name: 'usih', label: { fr: 'Hématologie' } },
    ],
  },
}

describe('cell predicates', () => {
  it('treats null, undefined and whitespace as blank', () => {
    expect(isBlank(null)).toBe(true)
    expect(isBlank(undefined)).toBe(true)
    expect(isBlank('   ')).toBe(true)
    expect(isBlank('')).toBe(true)
  })

  it('does not treat 0 or false as blank — they are answers', () => {
    expect(isBlank(0)).toBe(false)
    expect(isBlank(false)).toBe(false)
  })

  it('accepts the spellings exports use for a ticked box', () => {
    for (const v of [1, '1', true, 'true', 'Checked', 'Yes', 'oui']) expect(isTicked(v)).toBe(true)
  })

  it("accepts LimeSurvey's bare Y", () => {
    expect(isTicked('Y')).toBe(true)
    expect(isTicked('y')).toBe(true)
  })

  it('rejects unticked and empty values', () => {
    for (const v of [0, '0', false, '', null, undefined, 'no', 'N']) expect(isTicked(v)).toBe(false)
  })

  it('does not read LimeSurvey 2 as ticked — with Y/N conversion on, 2 means No', () => {
    expect(isTicked(2)).toBe(false)
    expect(isTicked('2')).toBe(false)
  })

  it('parses numbers, tolerating the decimal comma', () => {
    expect(toNumber('12')).toBe(12)
    expect(toNumber('10,5')).toBe(10.5)
    expect(toNumber(7)).toBe(7)
  })

  it('rejects non-numeric and empty cells', () => {
    expect(toNumber('abc')).toBeNull()
    expect(toNumber('')).toBeNull()
    expect(toNumber(null)).toBeNull()
    expect(toNumber(Infinity)).toBeNull()
  })
})

describe('summarizeQuestion — single choice', () => {
  const rows = [
    { type_structure: 'chu_chr' },
    { type_structure: 'chu_chr' },
    { type_structure: 'ch' },
    { type_structure: '' },
    { type_structure: null },
  ]
  const s = summarizeQuestion(SCHEMA, SINGLE, rows)

  it('counts respondents as those who answered, not all rows', () => {
    expect(s.total).toBe(5)
    expect(s.respondents).toBe(3)
    expect(s.missing).toBe(2)
    expect(s.responseRate).toBeCloseTo(0.6)
  })

  it('takes percentages over respondents, not over all rows', () => {
    const chu = s.counts.find((c) => c.code === 'chu_chr')!
    expect(chu.count).toBe(2)
    expect(chu.proportion).toBeCloseTo(2 / 3)
  })

  it('keeps a zero-count choice, in declared order', () => {
    expect(s.counts.map((c) => c.code)).toEqual(['chu_chr', 'ch', 'esprv'])
    expect(s.counts[2].count).toBe(0)
    expect(s.counts[2].proportion).toBe(0)
  })

  it('surfaces a value absent from the declared choices rather than dropping it', () => {
    const dirty = summarizeQuestion(SCHEMA, SINGLE, [{ type_structure: 'inconnu' }])
    expect(dirty.counts.find((c) => c.code === 'inconnu')?.count).toBe(1)
  })

  it('never divides by zero when nobody answered', () => {
    const empty = summarizeQuestion(SCHEMA, SINGLE, [{ type_structure: null }])
    expect(empty.respondents).toBe(0)
    expect(empty.responseRate).toBe(0)
    expect(empty.counts.every((c) => c.proportion === 0)).toBe(true)
  })
})

describe('summarizeQuestion — multiple choice', () => {
  const rows = [
    { usi___usic: 1, usi___usinv: 1, usi___usih: 0 }, // two ticks, one respondent
    { usi___usic: 1, usi___usinv: 0, usi___usih: 0 },
    { usi___usic: 0, usi___usinv: 0, usi___usih: 0 }, // no tick — not a respondent
    { usi___usic: 1, usi___usinv: 1, usi___usih: 1 },
  ]
  const s = summarizeQuestion(SCHEMA, MULTI, rows)

  it('counts a respondent once however many boxes they ticked', () => {
    expect(s.total).toBe(4)
    expect(s.respondents).toBe(3)
    expect(s.selections).toBe(6)
  })

  it('lets percentages sum past 100% because they are over respondents', () => {
    const sum = s.counts.reduce((acc, c) => acc + c.proportion, 0)
    expect(sum).toBeGreaterThan(1)
    expect(s.counts.find((c) => c.code === 'usic')!.proportion).toBeCloseTo(1) // 3/3
    expect(s.counts.find((c) => c.code === 'usinv')!.proportion).toBeCloseTo(2 / 3)
  })

  it('reports the mean number of selections per respondent', () => {
    expect(s.meanSelections).toBeCloseTo(2)
  })

  it('treats an all-zero row as non-response, not as a respondent', () => {
    expect(s.missing).toBe(1)
  })
})

describe('summarizeQuestion — numeric', () => {
  const rows = [{ lits: 10 }, { lits: '20' }, { lits: 30 }, { lits: '' }, { lits: 'n/a' }]
  const s = summarizeQuestion(SCHEMA, NUMERIC, rows)

  it('ignores blanks and unparseable cells', () => {
    expect(s.respondents).toBe(3)
    expect(s.missing).toBe(2)
  })

  it('computes summary statistics over the parsed values', () => {
    expect(s.stats!.n).toBe(3)
    expect(s.stats!.mean).toBeCloseTo(20)
    expect(s.stats!.median).toBe(20)
    expect(s.stats!.sum).toBe(60)
    expect(s.stats!.min).toBe(10)
    expect(s.stats!.max).toBe(30)
  })
})

describe('describe / quantile', () => {
  it('returns undefined for an empty sample', () => {
    expect(describeStats([])).toBeUndefined()
  })

  it('matches R type-7 quartiles', () => {
    const s = describeStats([1, 2, 3, 4])!
    expect(s.q1).toBeCloseTo(1.75)
    expect(s.median).toBeCloseTo(2.5)
    expect(s.q3).toBeCloseTo(3.25)
  })

  it('uses the sample standard deviation (n-1)', () => {
    expect(describeStats([2, 4, 4, 4, 5, 5, 7, 9])!.sd).toBeCloseTo(2.13809, 4)
  })

  it('reports sd 0 for a single value rather than NaN', () => {
    expect(describeStats([42])!.sd).toBe(0)
  })

  it('interpolates between neighbours', () => {
    expect(quantile([10, 20], 0.5)).toBe(15)
  })
})

describe('sortCounts', () => {
  const counts = [
    { code: 'a', label: 'Zeta', count: 1, proportion: 0.1 },
    { code: 'b', label: 'Alpha', count: 9, proportion: 0.9 },
  ]

  it('keeps declared order untouched', () => {
    expect(sortCounts(counts, 'declared').map((c) => c.code)).toEqual(['a', 'b'])
  })

  it('sorts by descending frequency', () => {
    expect(sortCounts(counts, 'frequency').map((c) => c.code)).toEqual(['b', 'a'])
  })

  it('sorts alphabetically by label', () => {
    expect(sortCounts(counts, 'alphabetical').map((c) => c.label)).toEqual(['Alpha', 'Zeta'])
  })

  it('does not mutate its input', () => {
    sortCounts(counts, 'frequency')
    expect(counts[0].code).toBe('a')
  })
})

describe('crossTabulate', () => {
  const rows = [
    { type_structure: 'chu_chr', cat: 'A' },
    { type_structure: 'ch', cat: 'A' },
    { type_structure: 'ch', cat: 'B' },
    { type_structure: 'ch', cat: null },
  ]
  const ct = crossTabulate(SCHEMA, SINGLE, rows, 'cat', { A: 'Groupe A' })

  it('drops rows with no group value', () => {
    expect(ct.groups.map((g) => g.value)).toEqual(['A', 'B'])
  })

  it('uses the supplied group label when there is one', () => {
    expect(ct.groups[0].label).toBe('Groupe A')
    expect(ct.groups[1].label).toBe('B')
  })

  it('computes each group percentage over its own respondents', () => {
    const a = ct.groups[0].summary
    expect(a.respondents).toBe(2)
    expect(a.counts.find((c) => c.code === 'ch')!.proportion).toBeCloseTo(0.5)
    const b = ct.groups[1].summary
    expect(b.counts.find((c) => c.code === 'ch')!.proportion).toBeCloseTo(1)
  })
})

describe('selectionCountDistribution', () => {
  const rows = [
    { usi___usic: 1, usi___usinv: 1, usi___usih: 0 },
    { usi___usic: 1, usi___usinv: 0, usi___usih: 0 },
    { usi___usic: 0, usi___usinv: 0, usi___usih: 0 },
    { usi___usic: 1, usi___usinv: 1, usi___usih: 1 },
  ]

  it('counts respondents by how many boxes they ticked', () => {
    // index k = respondents with k selections
    expect(selectionCountDistribution(MULTI, rows)).toEqual([1, 1, 1, 1])
  })

  it('spans zero through the number of choices', () => {
    expect(selectionCountDistribution(MULTI, rows)).toHaveLength(4)
  })

  it('puts every row at zero when nothing is ticked', () => {
    expect(selectionCountDistribution(MULTI, [{}, {}])).toEqual([2, 0, 0, 0])
  })
})

describe('jaccardMatrix', () => {
  it('scores a pair by the share of either-ticked who ticked both', () => {
    // usic in rows 1,2 ; usinv in row 1 → intersection 1, union 2
    const rows = [
      { usi___usic: 1, usi___usinv: 1, usi___usih: 0 },
      { usi___usic: 1, usi___usinv: 0, usi___usih: 0 },
    ]
    expect(jaccardMatrix(MULTI, rows)[0][1]).toBeCloseTo(0.5)
  })

  it('scores 1 on the diagonal for a choice someone ticked', () => {
    const m = jaccardMatrix(MULTI, [{ usi___usic: 1, usi___usinv: 0, usi___usih: 0 }])
    expect(m[0][0]).toBe(1)
  })

  it('scores 0 rather than NaN for a choice nobody ticked', () => {
    const m = jaccardMatrix(MULTI, [{ usi___usic: 1, usi___usinv: 0, usi___usih: 0 }])
    expect(m[2][2]).toBe(0)
    expect(m[0][2]).toBe(0)
  })

  it('is not fooled by two ubiquitous choices being unrelated', () => {
    // Both ticked by everyone → Jaccard 1, which is correct: they always co-occur.
    const rows = [
      { usi___usic: 1, usi___usinv: 1, usi___usih: 0 },
      { usi___usic: 1, usi___usinv: 1, usi___usih: 0 },
    ]
    expect(jaccardMatrix(MULTI, rows)[0][1]).toBe(1)
  })

  it('is symmetric', () => {
    const rows = [
      { usi___usic: 1, usi___usinv: 1, usi___usih: 0 },
      { usi___usic: 1, usi___usinv: 0, usi___usih: 1 },
    ]
    const m = jaccardMatrix(MULTI, rows)
    expect(m[0][1]).toBeCloseTo(m[1][0])
    expect(m[1][2]).toBeCloseTo(m[2][1])
  })
})

describe('coSelectionMatrix', () => {
  const rows = [
    { usi___usic: 1, usi___usinv: 1, usi___usih: 0 },
    { usi___usic: 1, usi___usinv: 0, usi___usih: 0 },
  ]
  const m = coSelectionMatrix(MULTI, rows)

  it('puts each choice own count on the diagonal', () => {
    expect(m[0][0]).toBe(2)
    expect(m[1][1]).toBe(1)
    expect(m[2][2]).toBe(0)
  })

  it('counts pairs ticked together, symmetrically', () => {
    expect(m[0][1]).toBe(1)
    expect(m[1][0]).toBe(1)
    expect(m[0][2]).toBe(0)
  })
})
