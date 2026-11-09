/**
 * The disclosure audit the server runs (apps/api tests/test_catalog_audit_twin.py)
 * finds what `auditPublished` finds here: this writes each input with its result,
 * and the variable order the findings sort by.
 *
 * To regenerate after an intentional change:
 *   GOLDEN_UPDATE=1 npx vitest run src/lib/data-catalog/audit.twin.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CATALOG_VARIABLE_ORDER, type CatalogVariableId } from '@/types/catalog'
import { auditPublished, type AuditInput } from './audit'
import type { PublishedCatalog, PublishedCrossing } from './publish'
import { PUBLISHED } from './suppression'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__/catalog-audit/audit.json')
const MASKED = 1

const variable = (id: CatalogVariableId, mods: string[], names = mods) => ({ id, label: id, kind: 'nominal' as const, mods, names, partition: {} as never })
const crossing = (vars: CatalogVariableId[], measures: PublishedCrossing['measures'], cells: (number | null)[][]): PublishedCrossing =>
  ({ id: vars.join('-'), vars, measures, masked: { primary: 0, secondary: 0 }, cells })

function atrovent(noise: number): AuditInput {
  return {
    published: {
      threshold: 10,
      variables: { concept: variable('concept', ['c']), period: variable('period', ['2190', '2200', '2210']) },
      crossings: [
        crossing(['concept'], ['records'], [[0, 900, 1300, PUBLISHED]]),
        crossing(['concept', 'period'], ['records'], [[0, 0, 800, 1164, PUBLISHED], [0, 1, 79, 133, PUBLISHED]]),
      ],
    },
    concepts: [],
    totals: { patients: 1000, records: 5000 },
    threshold: 10,
    noise,
  }
}

const periodSex: AuditInput = {
  published: {
    threshold: 10,
    variables: { period: variable('period', ['1', '2']), sex: variable('sex', ['male', 'female']) },
    crossings: [
      crossing(['period'], ['stays'], [[0, 100, 110, PUBLISHED]]),
      crossing(['period', 'sex'], ['stays'], [[0, 0, 60, 66, PUBLISHED], [0, 1, 40, 44, PUBLISHED], [1, 0, 70, 82, PUBLISHED]]),
    ],
  },
  concepts: [],
  totals: { patients: 170, stays: 200, records: 0 },
  threshold: 10,
  noise: 0,
}

const grandTotal = (records: number): AuditInput => ({
  published: { threshold: 10, variables: { concept: { ...variable('concept', ['c', 'd']), everyConcept: true } }, crossings: [] },
  concepts: [{ key: 'c', patients: 40, records: 90 }, { key: 'd', patients: null, records: null }],
  totals: { patients: 100, records },
  threshold: 10,
  noise: 0,
})

const noCategory = (u1: number | null, everyConcept = true): AuditInput => ({
  published: {
    threshold: 10,
    variables: { concept: { ...variable('concept', ['A', 'B']), level: 'category' } },
    crossings: [crossing(['concept'], ['records'], [[0, 200, 500, PUBLISHED], [1, 100, 300, PUBLISHED]])],
  },
  concepts: [
    { key: 'a', name: 'a', group: 'A', patients: 200, records: 500 },
    { key: 'b', name: 'b', group: 'B', patients: 100, records: 300 },
    { key: 'u1', name: 'U1', group: null, patients: u1 == null ? null : 40, records: u1 },
    { key: 'u2', name: 'U2', group: null, patients: null, records: null },
  ],
  everyConcept,
  totals: { patients: 400, records: 894 },
  threshold: 10,
  noise: 0,
})

/** Suppress mode at category level: the list leaves out the masked concepts, which a category may still hold. */
const suppressedCategories: AuditInput = {
  published: {
    threshold: 10,
    variables: {
      concept: { ...variable('concept', ['Lab', 'Drug', 'Ward'], ['Laboratory', 'Drugs', 'Ward']), level: 'category' },
      sex: variable('sex', ['male', 'female'], ['Male', 'Female']),
    },
    crossings: [
      crossing(['concept'], ['records'], [[0, 120, 400, PUBLISHED], [1, 50, 96, PUBLISHED], [2, 8, 9, MASKED]]),
      crossing(['concept', 'sex'], ['records'], [[0, 0, 70, 230, PUBLISHED], [0, 1, null, null, MASKED], [1, 0, 30, 60, PUBLISHED], [1, 1, 20, 36, PUBLISHED]]),
    ],
  },
  concepts: [
    { key: 'glucose', name: 'Glucose', group: 'Lab', patients: 100, records: 300 },
    { key: 'sodium', name: 'Sodium', group: 'Lab', patients: 90, records: 97 },
    { key: 'insulin', name: 'Insulin', group: 'Drug', patients: 48, records: 92 },
    { key: 'x', name: 'Loose', group: null, patients: 30, records: 40 },
  ],
  hidesMasked: true,
  everyConcept: true,
  totals: { patients: 500, records: 540 },
  threshold: 10,
  noise: 0,
}

/** At concept level with no 1-way crossing: the list, with its stays, is the concept margin. */
const conceptListWithStays: AuditInput = {
  published: {
    threshold: 5,
    variables: { concept: { ...variable('concept', ['c', 'd', 'e'], ['Ceftriaxone', 'Dobutamine', 'Ephedrine']), everyConcept: true }, sex: variable('sex', ['male', 'female']) },
    crossings: [
      crossing(['concept', 'sex'], ['stays', 'records'], [
        [0, 0, 20, 25, 40, PUBLISHED], [0, 1, null, null, null, MASKED],
        [1, 0, 12, 14, 30, PUBLISHED], [1, 1, 9, 10, 12, PUBLISHED],
        [2, 0, null, null, null, MASKED], [2, 1, null, null, null, MASKED],
      ]),
      crossing(['sex'], ['stays'], [[0, 300, 410, PUBLISHED], [1, 280, 390, PUBLISHED]]),
    ],
  },
  concepts: [
    { key: 'c', patients: 23, stays: 28, records: 44 },
    { key: 'd', patients: 21, stays: 24, records: 42 },
    { key: 'e', patients: null, stays: null, records: null },
  ],
  totals: { patients: 600, stays: 800, records: 90 },
  threshold: 5,
  noise: 0,
}

/** A small seeded generator (mulberry32): the same catalog on every run. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A mid-size catalog: a few hundred concepts, periods, ages and sexes, crossed
 * 1 to 3 ways, from one set of records so that its margins add up; about a
 * quarter of the cells masked, and published within ±1.
 */
function generated(): AuditInput {
  const rand = prng(20261108)
  const int = (n: number) => Math.floor(rand() * n)
  const mods: Record<Exclude<CatalogVariableId, 'service'>, string[]> = {
    concept: Array.from({ length: 300 }, (_, i) => `c${i}`),
    period: ['2019', '2020', '2021', '2022', '2023', '2024'],
    age: ['[0;18[', '[18;65[', '[65;+∞['],
    sex: ['male', 'female'],
  }
  type Var = keyof typeof mods
  // Records per concept × period × age × sex; stays per period × age × sex.
  const records = new Map<string, number>()
  for (let c = 0; c < mods.concept.length; c++) {
    const weight = rand() < 0.3 ? 40 : 4
    for (let p = 0; p < 6; p++) for (let a = 0; a < 3; a++) for (let s = 0; s < 2; s++) {
      const n = int(weight)
      if (n) records.set(`${c},${p},${a},${s}`, n)
    }
  }
  const stays = new Map<string, number>()
  for (let p = 0; p < 6; p++) for (let a = 0; a < 3; a++) for (let s = 0; s < 2; s++) stays.set(`${p},${a},${s}`, 5 + int(60))
  const order: Var[] = ['concept', 'period', 'age', 'sex']
  const sum = (source: Map<string, number>, dims: Var[], vars: Var[]) => {
    const out = new Map<string, number>()
    for (const [key, n] of source) {
      const at = key.split(',').map(Number)
      const k = vars.map((v) => at[dims.indexOf(v)]).join(',')
      out.set(k, (out.get(k) ?? 0) + n)
    }
    return out
  }
  const cellsOf = (totals: Map<string, number>) => [...totals].map(([key, n]) => {
    const masked = rand() < 0.25
    const patients = Math.max(1, Math.round(n * (0.5 + rand() * 0.4)))
    return [...key.split(',').map(Number), masked ? null : patients, masked ? null : n, masked ? MASKED : PUBLISHED]
  })
  const crossings: PublishedCrossing[] = []
  const add = (vars: Var[]) => {
    const event = vars.includes('concept')
    const totals = event ? sum(records, order, vars) : sum(stays, ['period', 'age', 'sex'], vars)
    crossings.push(crossing(vars, [event ? 'records' : 'stays'], cellsOf(totals)))
  }
  for (const vars of [
    ['concept'], ['period'], ['age'], ['sex'],
    ['concept', 'period'], ['concept', 'sex'], ['period', 'age'], ['period', 'sex'], ['age', 'sex'],
    ['concept', 'period', 'sex'], ['period', 'age', 'sex'],
  ] as Var[][]) add(vars)
  const published: PublishedCatalog = {
    threshold: 10,
    variables: {
      concept: { ...variable('concept', mods.concept, mods.concept.map((c) => `Concept ${c}`)), everyConcept: true },
      period: variable('period', mods.period),
      age: variable('age', mods.age),
      sex: variable('sex', mods.sex, ['Male', 'Female']),
    },
    crossings,
  }
  const margin = crossings[0].cells
  const concepts = mods.concept.map((key, i) => {
    const cell = margin.find((c) => c[0] === i)
    const shown = cell && cell[cell.length - 1] === PUBLISHED
    return { key, name: `Concept ${key}`, patients: shown ? cell[1] : null, records: shown ? cell[2] : null }
  })
  let allRecords = 0
  for (const n of records.values()) allRecords += n
  let allStays = 0
  for (const n of stays.values()) allStays += n
  return { published, concepts, totals: { patients: Math.round(allStays * 0.7), stays: allStays, records: allRecords }, threshold: 10, noise: 1 }
}

const CASES: [string, AuditInput][] = [
  ['atrovent', atrovent(0)],
  ['atrovent-noise-3', atrovent(3)],
  ['period-sex-total', periodSex],
  ['grand-total-95', grandTotal(95)],
  ['grand-total-200', grandTotal(200)],
  ['no-category-u1-90', noCategory(90)],
  ['no-category-u1-masked', noCategory(null)],
  ['no-category-not-every-concept', noCategory(90, false)],
  ['suppressed-categories', suppressedCategories],
  ['concept-list-with-stays', conceptListWithStays],
  ['generated', generated()],
]

describe('the audit twin fixture', () => {
  it('matches what auditPublished finds now', async () => {
    const cases = []
    for (const [name, input] of CASES) cases.push({ name, input, expected: await auditPublished(input) })
    const fixture = { variableOrder: CATALOG_VARIABLE_ORDER, cases }
    const generatedCase = cases[cases.length - 1].expected
    expect(generatedCase.findings.length).toBeGreaterThan(3)
    expect(generatedCase.findings.some((f) => f.examples.length === 20)).toBe(true)
    const text = `${JSON.stringify(fixture)}\n`
    if (process.env.GOLDEN_UPDATE || !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, text)
    }
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(JSON.parse(text))
  })
})
