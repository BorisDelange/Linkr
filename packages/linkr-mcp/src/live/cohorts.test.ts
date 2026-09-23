import { describe, expect, it } from 'vitest'
import { buildCohortCountSql } from '@/lib/duckdb/cohort-query'
import type { Cohort, CriterionNode, SchemaMapping } from '@/types'
import {
  applyConceptNames, conceptIdsByTable, describeMapping, formatRows, normalizeCriteria, renderTree,
} from './cohorts'

const MAPPING = {
  presetId: 'mimic-iv',
  presetLabel: { en: 'MIMIC-IV' },
  patientTable: { schema: 'hosp', table: 'patients', idColumn: 'subject_id', genderColumn: 'gender', deathDateColumn: 'dod' },
  visitTable: {
    schema: 'hosp', table: 'admissions', idColumn: 'hadm_id', patientIdColumn: 'subject_id',
    startDateColumn: 'admittime', endDateColumn: 'dischtime',
  },
  conceptTables: [{ key: 'd_labitems', schema: 'hosp', table: 'd_labitems', idColumn: 'itemid', nameColumn: 'label' }],
  eventTables: {
    'Lab events': {
      schema: 'hosp', table: 'labevents', conceptIdColumn: 'itemid', conceptDictionaryKey: 'd_labitems',
      patientIdColumn: 'subject_id', dateColumn: 'charttime', valueColumn: 'valuenum',
    },
  },
  genderValues: { male: 'M', female: 'F' },
} as unknown as SchemaMapping

const cohort = (tree: Cohort['criteriaTree']): Cohort => ({
  id: 'c1', projectUid: 'p1', name: { en: 'x' }, description: {}, level: 'visit',
  criteriaTree: tree, schemaVersion: 5, createdAt: '', updatedAt: '',
})

describe('normalizeCriteria', () => {
  it('accepts a bare array and fills ids, operators and flags', () => {
    const { tree, errors } = normalizeCriteria([
      { type: 'sex', config: { values: ['F'] } },
      { type: 'death', config: { isDead: true }, operator: 'OR', exclude: true },
    ], MAPPING)
    expect(errors).toEqual([])
    expect(tree.kind).toBe('group')
    const [a, b] = tree.children as CriterionNode[]
    expect(a).toMatchObject({ kind: 'criterion', operator: 'AND', exclude: false, enabled: true })
    expect(a.id).toMatch(/[0-9a-f-]{36}/)
    expect(b).toMatchObject({ operator: 'OR', exclude: true })
  })

  it('recognises nested groups by their children', () => {
    const { tree, errors } = normalizeCriteria({
      children: [{ children: [{ type: 'sex', config: { values: ['M'] } }], exclude: true }],
    }, MAPPING)
    expect(errors).toEqual([])
    expect(tree.children[0]).toMatchObject({ kind: 'group', exclude: true })
  })

  it('collects every error in one pass', () => {
    const { errors } = normalizeCriteria([
      { type: 'weight', config: {} },
      { type: 'sex', config: { values: ['female'] } },
      { type: 'concept', config: { eventTableLabel: 'Chart events', conceptIds: [] } },
      { type: 'duration', config: { durationLevel: 'visit_detail' } },
    ], MAPPING)
    expect(errors).toHaveLength(6)
    expect(errors.join('\n')).toMatch(/unknown criterion type "weight"/)
    expect(errors.join('\n')).toMatch(/female not in genderValues/)
    expect(errors.join('\n')).toMatch(/not an event table \(Lab events\)/)
    expect(errors.join('\n')).toMatch(/no visit-detail/)
  })

  it('fixes the case of an event table label and coerces ids to numbers', () => {
    const { tree, errors } = normalizeCriteria([
      { type: 'concept', config: { eventTableLabel: 'lab events', conceptIds: ['50813'] } },
    ], MAPPING)
    expect(errors).toEqual([])
    expect((tree.children[0] as CriterionNode).config).toMatchObject({
      eventTableLabel: 'Lab events', conceptIds: [50813], conceptNames: {},
    })
  })

  it('rejects a value filter on a table without a numeric value', () => {
    const noValue = { ...MAPPING, eventTables: { Notes: { table: 'n', conceptIdColumn: 'c' } } } as unknown as SchemaMapping
    const { errors } = normalizeCriteria([
      { type: 'concept', config: { eventTableLabel: 'Notes', conceptIds: [1], valueFilters: [{ operator: '>', value: 2 }] } },
    ], noValue)
    expect(errors.join('\n')).toMatch(/no numeric value column/)
  })

  it('warns that an age criterion is ignored when no birth column is mapped', () => {
    const { errors, warnings } = normalizeCriteria([
      { type: 'age', config: { ageReference: 'admission', min: 18 } },
    ], MAPPING)
    expect(errors).toEqual([])
    expect(warnings.join('\n')).toMatch(/IGNORED/)
  })

  it('produces a tree the app compiles to SQL', () => {
    const { tree } = normalizeCriteria([
      { type: 'sex', config: { values: ['F'] } },
      { type: 'concept', config: { eventTableLabel: 'Lab events', conceptIds: [50813], valueFilters: [{ operator: '>', value: 2 }] } },
    ], MAPPING)
    const sql = buildCohortCountSql(cohort(tree), MAPPING)
    expect(sql).toContain('50813')
    expect(sql).toContain("'F'")
    expect(sql).toContain('> 2')
  })
})

describe('concept names', () => {
  it('fills names by table and falls back to the id', () => {
    const { tree } = normalizeCriteria([
      { type: 'concept', config: { eventTableLabel: 'Lab events', conceptIds: [1, 2] } },
    ], MAPPING)
    expect([...conceptIdsByTable(tree).get('Lab events')!]).toEqual([1, 2])
    applyConceptNames(tree, new Map([['Lab events', new Map([[1, 'Lactate']])]]))
    expect((tree.children[0] as CriterionNode).config).toMatchObject({ conceptNames: { 1: 'Lactate', 2: '2' } })
  })
})

describe('rendering', () => {
  it('renders the tree with operators and negation', () => {
    const { tree } = normalizeCriteria([
      { type: 'sex', config: { values: ['F'] } },
      { children: [{ type: 'death', config: { isDead: true } }], operator: 'OR', label: 'dead' },
    ], MAPPING)
    expect(renderTree(tree, MAPPING)).toBe('Sex: Female\nOR (dead)\n  Deceased')
  })

  it('describes the mapping and flags a missing birth column', () => {
    const text = describeMapping(MAPPING)
    expect(text).toContain('Patients: hosp.patients')
    expect(text).toContain('"Lab events": hosp.labevents')
    expect(text).toMatch(/age" criterion cannot work/)
  })

  it('cuts rows to the budget and says so', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ a: i, b: 'x|y' }))
    const out = formatRows(rows, 3)
    expect(out.split('\n')).toHaveLength(5)
    expect(out).toContain('x y')
    expect(out).toContain('7 more row(s)')
  })
})
