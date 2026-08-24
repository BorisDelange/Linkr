import { describe, it, expect } from 'vitest'
import { applicableTests, overrideApplies } from './applicable-tests'

describe('applicableTests', () => {
  it('offers the two-sample pair for two groups', () => {
    expect(applicableTests('numeric', 2)).toEqual(['welch-t', 'mann-whitney'])
  })

  it('offers the k-sample pair beyond two groups', () => {
    expect(applicableTests('numeric', 3)).toEqual(['anova', 'kruskal-wallis'])
    expect(applicableTests('numeric', 7)).toEqual(['anova', 'kruskal-wallis'])
  })

  it('offers the contingency tests for a categorical variable, whatever the group count', () => {
    expect(applicableTests('categorical', 2)).toEqual(['chi-square', 'fisher'])
    expect(applicableTests('categorical', 5)).toEqual(['chi-square', 'fisher'])
  })

  it('puts the parametric option first', () => {
    // The picker shows them in this order, so it is part of the contract.
    expect(applicableTests('numeric', 2)[0]).toBe('welch-t')
    expect(applicableTests('numeric', 4)[0]).toBe('anova')
  })
})

describe('overrideApplies', () => {
  it('accepts a test that fits the variable', () => {
    expect(overrideApplies('mann-whitney', 'numeric', 2)).toBe(true)
    expect(overrideApplies('kruskal-wallis', 'numeric', 3)).toBe(true)
    expect(overrideApplies('fisher', 'categorical', 2)).toBe(true)
  })

  it('rejects a two-sample test once there are more than two groups', () => {
    // The case this exists for: a pinned Welch t, then the group column gains a
    // third level. Running it anyway would compare two of three groups.
    expect(overrideApplies('welch-t', 'numeric', 3)).toBe(false)
    expect(overrideApplies('mann-whitney', 'numeric', 4)).toBe(false)
  })

  it('rejects a k-sample test on exactly two groups', () => {
    expect(overrideApplies('anova', 'numeric', 2)).toBe(false)
  })

  it('rejects a test meant for the other variable type', () => {
    expect(overrideApplies('chi-square', 'numeric', 2)).toBe(false)
    expect(overrideApplies('welch-t', 'categorical', 2)).toBe(false)
  })

  it('reports no override as not applying', () => {
    expect(overrideApplies(undefined, 'numeric', 2)).toBe(false)
  })
})
