import { describe, expect, it } from 'vitest'
import type { CriteriaGroupNode, CriterionNode } from '@/types'
import { importAtlasCohort, isAtlasCohortDefinition, type AtlasCohortDefinition } from './atlas-converter'

const concept = (id: number, name: string, extra: Record<string, boolean> = {}) => ({
  concept: { CONCEPT_ID: id, CONCEPT_NAME: name },
  isExcluded: false, includeDescendants: false, includeMapped: false, ...extra,
})

/** A typical ATLAS export: one entry event, an age/sex rule, an exclusion rule. */
const DEFINITION = {
  ConceptSets: [
    { id: 0, name: 'Lactate', expression: { items: [concept(3047181, 'Lactate')] } },
    { id: 1, name: 'Sepsis', expression: { items: [concept(132797, 'Sepsis'), concept(4, 'Old code', { isExcluded: true })] } },
  ],
  PrimaryCriteria: {
    CriteriaList: [{ Measurement: { CodesetId: 0, ValueAsNumber: { Value: 2, Op: 'gt' } } }],
    ObservationWindow: { PriorDays: 0, PostDays: 0 },
    PrimaryCriteriaLimit: { Type: 'All' },
  },
  QualifiedLimit: { Type: 'First' },
  ExpressionLimit: { Type: 'All' },
  InclusionRules: [
    {
      name: 'Adult men',
      expression: {
        Type: 'ALL', CriteriaList: [], Groups: [],
        DemographicCriteriaList: [{ Age: { Value: 18, Op: 'gte' }, Gender: [{ CONCEPT_ID: 8507 }] }],
      },
    },
    {
      name: 'No sepsis',
      expression: {
        Type: 'AT_MOST', Count: 0, DemographicCriteriaList: [], Groups: [],
        CriteriaList: [{
          Criteria: { ConditionOccurrence: { CodesetId: 1 } },
          StartWindow: { Start: { Days: 365, Coeff: -1 }, End: { Days: 0, Coeff: 1 } },
          Occurrence: { Type: 2, Count: 1 },
        }],
      },
    },
  ],
  CensoringCriteria: [],
} as unknown as AtlasCohortDefinition

const criterion = (n: unknown) => n as CriterionNode
const group = (n: unknown) => n as CriteriaGroupNode

describe('importAtlasCohort', () => {
  it('turns entry events, rules and exclusions into a criteria tree', () => {
    const { criteriaTree } = importAtlasCohort(DEFINITION)
    const [entry, adults, noSepsis] = criteriaTree.children
    expect(criteriaTree).toMatchObject({ kind: 'group', operator: 'AND', exclude: false })
    expect(criterion(entry)).toMatchObject({
      type: 'concept',
      config: {
        eventTableLabel: 'measurement', conceptIds: [3047181], conceptNames: { 3047181: 'Lactate' },
        valueFilters: [{ operator: '>', value: 2 }],
      },
    })
    expect(group(adults).label).toBe('Adult men')
    expect(group(adults).children.map((c) => criterion(c).type)).toEqual(['age', 'sex'])
    expect(criterion(group(adults).children[0]).config).toMatchObject({ ageReference: 'admission', min: 18 })
    expect(criterion(group(adults).children[1]).config).toEqual({ values: ['8507'] })
    expect(group(noSepsis)).toMatchObject({ label: 'No sepsis', exclude: true })
    expect(criterion(group(noSepsis).children[0]).config).toMatchObject({
      eventTableLabel: 'condition_occurrence', conceptIds: [132797], occurrenceCount: { operator: '>=', count: 1 },
    })
  })

  it('reports what it drops, once each', () => {
    const { warnings } = importAtlasCohort(DEFINITION)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Concept set "Sepsis": 1 excluded concept'),
      expect.stringContaining('QualifiedLimit "First"'),
      expect.stringContaining('Time window constraint'),
    ]))
    // "All" limits and an empty observation window are no loss.
    expect(warnings.join('\n')).not.toMatch(/PrimaryCriteriaLimit|ExpressionLimit|observation window/)
    expect(new Set(warnings).size).toBe(warnings.length)
  })

  it('flags semantics the tree cannot express', () => {
    const { criteriaTree, warnings } = importAtlasCohort({
      ConceptSets: [{ id: 0, name: 'A', expression: { items: [concept(1, 'A', { includeDescendants: true, includeMapped: true })] } }],
      PrimaryCriteria: {
        CriteriaList: [
          { ConditionOccurrence: { CodesetId: 0, First: true, Age: { Value: 18, Op: 'gt' } } },
          { DrugExposure: { CodesetId: 7 } },
          { ObservationPeriod: {} },
        ],
      },
      AdditionalCriteria: {
        Type: 'AT_LEAST', Count: 2, Groups: [],
        DemographicCriteriaList: [{ Race: [{ CONCEPT_ID: 1 }], Age: { Value: 1, Op: '!bt' } }],
        CriteriaList: [{ Criteria: { Measurement: { CodesetId: 0 } }, Occurrence: { Type: 0, Count: 0 }, RestrictVisit: true }],
      },
      InclusionRules: [],
      EndStrategy: { DateOffset: {} },
      CensorWindow: { StartDate: '2020-01-01' },
    } as unknown as AtlasCohortDefinition)

    // Two supported entry events kept; ObservationPeriod dropped.
    expect(criteriaTree.children.filter((c) => c.kind === 'criterion')).toHaveLength(2)
    const text = warnings.join('\n')
    for (const expected of [
      'includeDescendants', 'includeMapped', 'must ALL match', 'ObservationPeriod (dropped)',
      'ConditionOccurrence criterion: First ignored', 'Age set on a ConditionOccurrence criterion was dropped',
      'names concept set 7', 'at least 2 of', 'Race ignored', 'age condition "!bt"',
      'exactly 0 occurrences', 'same visit', 'EndStrategy', 'CensorWindow',
    ]) {
      expect(text).toContain(expected)
    }
  })
})

describe('isAtlasCohortDefinition', () => {
  it('recognises an ATLAS definition, not other JSON', () => {
    expect(isAtlasCohortDefinition(DEFINITION)).toBe(true)
    expect(isAtlasCohortDefinition({ PrimaryCriteria: { CriteriaList: [] } })).toBe(true)
    expect(isAtlasCohortDefinition({ criteriaTree: {} })).toBe(false)
    expect(isAtlasCohortDefinition([])).toBe(false)
    expect(isAtlasCohortDefinition('x')).toBe(false)
  })
})
