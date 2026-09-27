import { describe, expect, it } from 'vitest'
import { normalizeDqCheck, subcategoryFor } from './dq-taxonomy'

describe('Kahn taxonomy', () => {
  it('maps the pre-Kahn categories onto it', () => {
    expect(normalizeDqCheck({ category: 'validity', severity: 'error' })).toMatchObject({ category: 'conformance', subcategory: 'value' })
    expect(normalizeDqCheck({ category: 'consistency', severity: 'error' })).toMatchObject({ category: 'conformance', subcategory: 'relational' })
    expect(normalizeDqCheck({ category: 'uniqueness', severity: 'error' })).toMatchObject({ category: 'plausibility', subcategory: 'uniqueness' })
    expect(normalizeDqCheck({ category: 'completeness', severity: 'info' })).toMatchObject({ category: 'completeness', subcategory: null, severity: 'notice' })
  })

  it('drops a subcategory that belongs to another category', () => {
    expect(subcategoryFor('completeness', 'temporal')).toBeNull()
    expect(subcategoryFor('plausibility', 'temporal')).toBe('temporal')
    const check = { category: 'plausibility', subcategory: 'temporal', severity: 'error' }
    expect(normalizeDqCheck(check)).toBe(check)
  })
})
