import { describe, it, expect } from 'vitest'
import { EQUIVALENCE_OPTIONS, EQUIV_BADGE, normalizeEquivalence } from './equivalence-badge'

describe('normalizeEquivalence', () => {
  it('passes canonical SKOS predicates through unchanged', () => {
    expect(normalizeEquivalence('skos:exactMatch')).toBe('skos:exactMatch')
    expect(normalizeEquivalence('skos:closeMatch')).toBe('skos:closeMatch')
    expect(normalizeEquivalence('skos:broadMatch')).toBe('skos:broadMatch')
    expect(normalizeEquivalence('skos:narrowMatch')).toBe('skos:narrowMatch')
    expect(normalizeEquivalence('skos:relatedMatch')).toBe('skos:relatedMatch')
  })

  it('maps legacy aliases to their SKOS predicate', () => {
    expect(normalizeEquivalence('equal')).toBe('skos:exactMatch')
    expect(normalizeEquivalence('equivalent')).toBe('skos:closeMatch')
    expect(normalizeEquivalence('wider')).toBe('skos:broadMatch')
    expect(normalizeEquivalence('narrower')).toBe('skos:narrowMatch')
    expect(normalizeEquivalence('inexact')).toBe('skos:relatedMatch')
  })

  it('falls back to exactMatch for unknown, empty, or missing values', () => {
    expect(normalizeEquivalence('')).toBe('skos:exactMatch')
    expect(normalizeEquivalence('nonsense')).toBe('skos:exactMatch')
    expect(normalizeEquivalence(undefined)).toBe('skos:exactMatch')
    expect(normalizeEquivalence(null)).toBe('skos:exactMatch')
  })
})

describe('EQUIVALENCE_OPTIONS', () => {
  it('lists every canonical predicate exactly once, exact first', () => {
    expect(EQUIVALENCE_OPTIONS).toEqual([
      'skos:exactMatch', 'skos:closeMatch', 'skos:broadMatch', 'skos:narrowMatch', 'skos:relatedMatch',
    ])
    expect(new Set(EQUIVALENCE_OPTIONS).size).toBe(EQUIVALENCE_OPTIONS.length)
  })

  it('offers only options the badge map can render, and only canonical ones', () => {
    for (const pred of EQUIVALENCE_OPTIONS) {
      expect(EQUIV_BADGE[pred]).toBeDefined()
      expect(normalizeEquivalence(pred)).toBe(pred)
    }
  })
})
