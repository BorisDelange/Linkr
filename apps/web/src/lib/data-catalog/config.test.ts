import { describe, expect, it } from 'vitest'
import {
  ageBucketLabels,
  canonicalCrossing,
  convertLegacyCatalog,
  crossingParamsKey,
  defaultCatalogVariables,
  effectiveCrossings,
  normalizeCatalog,
  periodLabel,
  periodRange,
  trimPeriods,
} from './config'

describe('crossing identity', () => {
  it('puts variables in canonical order, once each', () => {
    expect(canonicalCrossing(['sex', 'period', 'sex'])).toEqual(['period', 'sex'])
  })

  it('computes every enabled marginal, then the chosen crossings of enabled variables, smallest first', () => {
    const variables = defaultCatalogVariables()
    const out = effectiveCrossings({
      variables,
      crossings: [['sex', 'age', 'period'], ['age', 'period'], ['period', 'age'], ['service', 'age'], ['period', 'age', 'sex', 'service']],
    })
    expect(out).toEqual([['period'], ['age'], ['sex'], ['period', 'age'], ['period', 'age', 'sex']])
  })

  it('keys an estimate on the parameters of the variables it crosses only', () => {
    const a = defaultCatalogVariables()
    const b = { ...a, period: { enabled: true, granularity: 'month' as const } }
    expect(crossingParamsKey(a, ['age', 'sex'])).toBe(crossingParamsKey(b, ['age', 'sex']))
    expect(crossingParamsKey(a, ['period', 'sex'])).not.toBe(crossingParamsKey(b, ['period', 'sex']))
  })
})

describe('modalities', () => {
  it('labels age brackets, the last open-ended', () => {
    expect(ageBucketLabels([65, 18, 18])).toEqual(['[0;18[', '[18;65[', '[65;+∞['])
    expect(ageBucketLabels([])).toEqual(['[0;+∞['])
  })

  it('lists every period between two, gaps included', () => {
    expect(periodRange('2023-11', '2024-02', 'month')).toEqual(['2023-11', '2023-12', '2024-01', '2024-02'])
    expect(periodRange('2023-Q4', '2024-Q2', 'quarter')).toEqual(['2023-Q4', '2024-Q1', '2024-Q2'])
    expect(periodRange('2021', '2023', 'year')).toEqual(['2021', '2022', '2023'])
    expect(periodRange('2024', '2021', 'year')).toEqual([])
  })

  it('steps through periods of several units, labelled by their span', () => {
    expect(periodRange('2020', '2024', 'year', 2)).toEqual(['2020', '2022', '2024'])
    expect(periodRange('2024-01', '2024-12', 'month', 6)).toEqual(['2024-01', '2024-07'])
    expect(periodLabel('2020', 'en', 2)).toBe('2020–2021')
    expect(periodLabel('2024-Q3', 'en', 2)).toBe('Q3 2024 – Q4 2024')
    expect(periodLabel('2024-11', 'en', 3)).toBe('Nov 2024 – Jan 2025')
  })

  it('trims the periods before the first and after the last reaching the threshold', () => {
    const periods = ['2100', '2101', '2102', '2103', '2104']
    const marginal = new Map([['2100', 2], ['2101', 50], ['2102', 3], ['2103', 40], ['2104', 1]])
    expect(trimPeriods(periods, marginal, 10)).toEqual(['2101', '2102', '2103'])
    expect(trimPeriods(periods, new Map(), 10)).toEqual([])
  })
})

describe('legacy catalogs', () => {
  const legacy = {
    dimensions: [
      { type: 'age_group', enabled: true, ageGroup: { brackets: [18, 65] } },
      { type: 'sex', enabled: true },
      { type: 'care_site', enabled: false },
    ],
    categoryColumn: 'domain_id',
    periodConfig: { granularity: 'quarter' as const, serviceLabels: ['ICU'], conceptCategories: ['Drug'] },
    computedPeriods: 4,
  }

  it('turns the period table into period × X crossings', () => {
    const { variables, crossings } = convertLegacyCatalog(legacy)
    expect(variables.period).toEqual({ enabled: true, granularity: 'quarter' })
    expect(variables.age?.brackets).toEqual([18, 65])
    expect(variables.concept).toMatchObject({ enabled: true, level: 'category', categoryColumn: 'domain_id' })
    expect(variables.service).toMatchObject({ enabled: false, grouping: 'manual', groups: { ICU: 'ICU' } })
    expect(crossings).toEqual([['concept', 'period'], ['period', 'age'], ['period', 'sex']])
  })

  it('drops the legacy fields, and leaves a converted catalog alone', () => {
    const converted = normalizeCatalog({ id: 'c', ...legacy })
    expect(converted).not.toHaveProperty('dimensions')
    expect(converted).not.toHaveProperty('computedPeriods')
    expect(normalizeCatalog(converted)).toBe(converted)
  })
})
