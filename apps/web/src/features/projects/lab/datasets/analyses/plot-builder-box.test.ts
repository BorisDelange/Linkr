import { describe, it, expect } from 'vitest'
import { buildBoxplotGroups, MAX_BOX_CATEGORIES } from './plot-builder-box'

/** Pinned against the server mirror (boxplot branch of _linkr_print_plot in
 *  apps/api/app/services/execution/render/plot_builder.py, tests in test_render.py). */
function groups(n: number): [string, number[]][] {
  return Array.from({ length: n }, (_, i) => [`c${i}`, [i, i, i]])
}

describe('buildBoxplotGroups', () => {
  it('keeps first-seen order by default', () => {
    expect(buildBoxplotGroups(groups(3), 'data').map(d => d.name)).toEqual(['c0', 'c1', 'c2'])
  })

  it('orders by descending median when asked', () => {
    const data = buildBoxplotGroups([['a', [1, 2, 3]], ['b', [10, 20, 30]], ['c', [5, 5]]], 'value-desc')
    expect(data.map(d => d.name)).toEqual(['b', 'c', 'a'])
    expect(data.map(d => d.values.length)).toEqual([3, 2, 3])
  })

  it('keeps first-seen order between equal medians', () => {
    const data = buildBoxplotGroups([['a', [2]], ['b', [5]], ['c', [2]]], 'value-desc')
    expect(data.map(d => d.name)).toEqual(['b', 'a', 'c'])
  })

  it('sorts before the category cap, keeping the highest medians', () => {
    const data = buildBoxplotGroups(groups(25), 'value-desc')
    expect(data).toHaveLength(MAX_BOX_CATEGORIES)
    expect(data[0].name).toBe('c24')
    expect(data[data.length - 1].name).toBe('c5')
  })

  it('places the custom list first, then the rest by descending median, before the cap', () => {
    const data = buildBoxplotGroups(groups(25), 'custom', ['c3', 'c1'])
    expect(data).toHaveLength(MAX_BOX_CATEGORIES)
    expect(data.slice(0, 3).map(d => d.name)).toEqual(['c3', 'c1', 'c24'])
  })

  it('caps unsorted charts at the first categories met', () => {
    const data = buildBoxplotGroups(groups(25), 'data')
    expect(data.map(d => d.name).slice(-1)).toEqual(['c19'])
  })
})
