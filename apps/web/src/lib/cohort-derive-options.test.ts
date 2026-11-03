import { describe, expect, it } from 'vitest'
import type { Cohort, CriteriaGroupNode, DataSource, SchemaMapping } from '@/types'
import {
  birthDates, copyableTables, criteriaConcepts, derivationRequest, derivationScopes, mergeVariables, personlessTables,
  variableFilters,
} from './cohort-derive'

const mapping = {
  formatVersion: 2,
  patient: { from: { table: 'person', alias: 'p' }, fields: { patient_id: 'p.person_id', birth_date: 'p.birth_datetime' } },
  visit: { from: { table: 'visit_occurrence', alias: 'v' }, fields: { visit_id: 'v.visit_occurrence_id', patient_id: 'v.person_id', start_datetime: 'v.d' } },
  concepts: [
    { key: 'd_items', from: { schema: 'icu', table: 'd_items', alias: 'd' }, fields: { concept_id: 'd.itemid', concept_name: 'd.label' } },
    { key: 'd_labitems', from: { schema: 'hosp', table: 'd_labitems', alias: 'd' }, fields: { concept_id: 'd.itemid', concept_name: 'd.label' } },
  ],
  events: [
    {
      label: 'Chart', conceptDictionaryKey: 'd_items', from: { schema: 'icu', table: 'chartevents', alias: 'e' },
      fields: { patient_id: 'e.subject_id', concept_id: 'e.itemid', start_datetime: 'e.charttime' },
    },
    {
      label: 'Labs', conceptDictionaryKey: 'd_labitems', from: { schema: 'hosp', table: 'labevents', alias: 'e' },
      fields: { patient_id: 'e.subject_id', concept_id: 'e.itemid', source_concept_id: 'e.src_id', start_datetime: 'e.charttime' },
    },
    {
      label: 'Notes', from: { table: 'notes', alias: 'n' },
      fields: { patient_id: 'n.subject_id', concept_id: { expr: 'n.a + n.b' }, start_datetime: 'n.t' },
    },
  ],
} as unknown as SchemaMapping

describe('derivationScopes', () => {
  it('offers the cohort level and the wider ones', () => {
    expect(derivationScopes('visit_detail')).toEqual(['patient', 'visit', 'visit_detail'])
    expect(derivationScopes('visit')).toEqual(['patient', 'visit'])
    expect(derivationScopes('patient')).toEqual(['patient'])
    expect(derivationScopes('event')).toEqual([])
  })
})

describe('the plan tables', () => {
  const plan = [
    { schema: null, table: 'person', filter: 'patient', column: 'person_id' },
    { schema: null, table: 'concept', filter: null, column: null },
    { schema: null, table: 'odd', filter: null, column: null, unresolved: 'events.X' },
    { schema: null, table: 'stay_note', filter: null, column: null, unfilterable: 'visit_id' },
  ] as const
  it('never offers a table the server refuses', () => {
    expect(copyableTables([...plan]).map((p) => p.table)).toEqual(['person', 'concept'])
    expect(personlessTables([...plan]).map((p) => p.table)).toEqual(['concept'])
  })
})

describe('variableFilters', () => {
  it('keeps the concepts in the tables of their dictionary, and empties the others', () => {
    const { filters, unfiltered } = variableFilters(mapping, { conceptIds: [50912], conceptNames: {}, dictionaryKeys: ['d_labitems'] })
    expect(filters).toEqual([
      { schemaName: 'icu', table: 'chartevents', columns: ['itemid'], conceptIds: [] },
      { schemaName: 'hosp', table: 'labevents', columns: ['itemid', 'src_id'], conceptIds: [50912] },
    ])
    // An expression names no column: that table keeps every variable.
    expect(unfiltered).toEqual(['Notes'])
  })

  it('searches every table naming a dictionary when the dictionaries are not known', () => {
    const { filters } = variableFilters(mapping, { conceptIds: [1, 2], conceptNames: {} })
    expect(filters.map((f) => f.conceptIds)).toEqual([[1, 2], [1, 2]])
  })
})

describe('birthDates', () => {
  it('truncates the mapped birth date, and leaves it whole to the day', () => {
    expect(birthDates(mapping, 'month')).toEqual([{ schemaName: null, table: 'person', column: 'birth_datetime', precision: 'month' }])
    expect(birthDates(mapping, 'day')).toEqual([])
    expect(birthDates(mapping, undefined)).toEqual([])
    const noBirth = { ...mapping, patient: { from: { table: 'p', alias: 'p' }, fields: { patient_id: 'p.id' } } } as SchemaMapping
    expect(birthDates(noBirth, 'year')).toEqual([])
  })
})

const concept = (id: string, ids: number[], over: Record<string, unknown> = {}) => ({
  kind: 'criterion', id, type: 'concept', operator: 'AND', exclude: false, enabled: true,
  config: { conceptIds: ids, conceptNames: Object.fromEntries(ids.map((i) => [i, `c${i}`])), dictionaryKeys: ['d_items'] },
  ...over,
})
const tree = (children: unknown[]) => ({ kind: 'group', id: 'root', operator: 'AND', exclude: false, enabled: true, children }) as CriteriaGroupNode

describe('criteriaConcepts', () => {
  it('collects the concepts of the enabled criteria, nested groups included', () => {
    const t = tree([concept('a', [1, 2]), tree([concept('b', [3])]), concept('c', [9], { enabled: false })])
    expect(criteriaConcepts(t)).toEqual({ conceptIds: [1, 2, 3], conceptNames: { 1: 'c1', 2: 'c2', 3: 'c3' }, dictionaryKeys: ['d_items'] })
  })

  it('drops the dictionaries when one criterion does not name its own', () => {
    const unknown = concept('b', [3])
    ;(unknown.config as { dictionaryKeys?: string[] }).dictionaryKeys = undefined
    expect(criteriaConcepts(tree([concept('a', [1]), unknown])).dictionaryKeys).toBeUndefined()
  })
})

describe('mergeVariables', () => {
  it('unites the concepts, and keeps the dictionaries only when both know theirs', () => {
    const a = { conceptIds: [1], conceptNames: { 1: 'a' }, dictionaryKeys: ['x'] }
    expect(mergeVariables(a, { conceptIds: [1, 2], conceptNames: { 2: 'b' }, dictionaryKeys: ['y'] }))
      .toEqual({ conceptIds: [1, 2], conceptNames: { 1: 'a', 2: 'b' }, dictionaryKeys: ['x', 'y'] })
    expect(mergeVariables(a, { conceptIds: [2], conceptNames: {} }).dictionaryKeys).toBeUndefined()
    expect(mergeVariables(undefined, a)).toBe(a)
  })
})

describe('derivationRequest with options', () => {
  const source = {
    id: 'db1', alias: 'db', name: { en: 'Parent' }, sourceType: 'database', workspaceId: 'ws', status: 'connected',
    connectionConfig: { engine: 'duckdb', managed: true }, schemaMapping: mapping,
  } as unknown as DataSource
  const cohort = { id: 'c1', name: { en: 'ICU' }, level: 'visit', criteriaTree: tree([]) } as unknown as Cohort

  it('turns the options into the request, and records them for a rebuild', () => {
    const options = {
      scope: 'patient' as const,
      tables: [{ schema: 'icu', table: 'chartevents' }, { schema: null, table: 'person' }],
      variables: { conceptIds: [7], conceptNames: { 7: 'HR' }, dictionaryKeys: ['d_items'] },
      birthPrecision: 'year' as const,
      pseudonymization: { method: 'hmac' as const, keepKey: true },
    }
    const r = derivationRequest({ cohort, cohortKey: 'icu', source, copyPersonless: true, target: 'new-database', options })
    expect(r.scope).toBe('patient')
    expect(r.tables).toEqual([{ schemaName: 'icu', table: 'chartevents' }, { schemaName: null, table: 'person' }])
    expect(r.variables?.find((v) => v.table === 'chartevents')?.conceptIds).toEqual([7])
    expect(r.dates).toEqual([{ schemaName: null, table: 'person', column: 'birth_datetime', precision: 'year' }])
    expect(r.pseudonymization).toEqual({ method: 'hmac', keepKey: true })
    expect(r.derivedFrom?.options).toEqual(options)
  })

  it('sends none of it without options', () => {
    const r = derivationRequest({ cohort, cohortKey: 'icu', source, copyPersonless: true, target: 'new-database' })
    expect(r).not.toHaveProperty('scope')
    expect(r).not.toHaveProperty('pseudonymization')
  })
})
