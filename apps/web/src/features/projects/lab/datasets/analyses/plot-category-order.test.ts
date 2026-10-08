import { describe, it, expect } from 'vitest'
import { orderCategories, readCategoryOrder, readCustomCategoryOrder, type CategoryOrder } from './plot-category-order'

/** Pinned against the server mirror (_linkr_order_categories in
 *  apps/api/app/services/execution/render/plot_builder.py, tests in test_render.py). */
const items = [
  { name: 'b', n: 2 },
  { name: 'Class 10', n: 5 },
  { name: 'a', n: 2 },
  { name: 'Class 2', n: 9 },
]
const order = (o: CategoryOrder, custom?: string[]) =>
  orderCategories(items, d => d.name, d => d.n, o, custom).map(d => d.name)

describe('orderCategories', () => {
  it('sorts by value, keeping first appearance between ties', () => {
    expect(order('value-desc')).toEqual(['Class 2', 'Class 10', 'b', 'a'])
    expect(order('value-asc')).toEqual(['b', 'a', 'Class 10', 'Class 2'])
  })

  it('sorts alphabetically with numbers compared as numbers', () => {
    expect(order('alpha')).toEqual(['a', 'b', 'Class 2', 'Class 10'])
  })

  it('ignores case and accents alphabetically', () => {
    const names = orderCategories(['Éa', 'b', 'a', 'ea', 'B'], s => s, () => 0, 'alpha')
    expect(names).toEqual(['a', 'b', 'B', 'Éa', 'ea'])
  })

  it('keeps data order', () => {
    expect(order('data')).toEqual(['b', 'Class 10', 'a', 'Class 2'])
  })

  it('puts the custom list first, then the rest by descending value', () => {
    expect(order('custom', ['a', 'gone', 'b'])).toEqual(['a', 'b', 'Class 2', 'Class 10'])
  })

  it('falls back to descending value when the custom list is empty', () => {
    expect(order('custom', [])).toEqual(order('value-desc'))
  })

  it('does not mutate its input', () => {
    order('alpha')
    expect(items.map(d => d.name)).toEqual(['b', 'Class 10', 'a', 'Class 2'])
  })
})

describe('readCategoryOrder', () => {
  it('reads a saved order', () => {
    expect(readCategoryOrder({ categoryOrder: 'alpha' })).toBe('alpha')
  })

  it('is null when nothing was chosen, so each plot keeps its own default', () => {
    expect(readCategoryOrder({})).toBeNull()
    expect(readCategoryOrder({ categoryOrder: 'bogus' })).toBeNull()
  })

  it('reads the older sortByMedian flag as descending value', () => {
    expect(readCategoryOrder({ sortByMedian: true })).toBe('value-desc')
    expect(readCategoryOrder({ sortByMedian: false })).toBeNull()
    expect(readCategoryOrder({ sortByMedian: true, categoryOrder: 'data' })).toBe('data')
  })
})

describe('readCustomCategoryOrder', () => {
  it('keeps only strings', () => {
    expect(readCustomCategoryOrder({ categoryOrderCustom: ['a', 3, 'b'] })).toEqual(['a', 'b'])
    expect(readCustomCategoryOrder({})).toEqual([])
  })
})

describe('orderCategories custom with a duplicate name', () => {
  it('places the first item of that name, like the server', () => {
    const items = [{ n: 'a', v: 1 }, { n: 'b', v: 2 }, { n: 'a', v: 3 }]
    const out = orderCategories(items, i => i.n, i => i.v, 'custom', ['a'])
    expect(out[0]).toBe(items[0])
  })
})
