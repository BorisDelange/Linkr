import { describe, expect, it } from 'vitest'
import { orderTabs, placeTab } from './ide-tab-order'

describe('orderTabs', () => {
  it('follows the shared order across tab kinds', () => {
    expect(orderTabs(['f1', 'term:r:1', 'table'], ['table', 'f1', 'term:r:1'])).toEqual(['table', 'f1', 'term:r:1'])
  })

  it('puts tabs the order does not know after the others, in arrival order', () => {
    expect(orderTabs(['new1', 'f1', 'new2', 'f2'], ['f2', 'f1'])).toEqual(['f2', 'f1', 'new1', 'new2'])
  })

  it('ignores order entries for tabs no longer in the panel', () => {
    expect(orderTabs(['f1'], ['gone', 'f1'])).toEqual(['f1'])
  })
})

describe('placeTab', () => {
  const tabs = ['f1', 'f2', 'console', 'table']

  it('drops a tab before or after its target', () => {
    expect(placeTab(tabs, 'table', 'f1', 'left')).toEqual(['table', 'f1', 'f2', 'console'])
    expect(placeTab(tabs, 'f1', 'console', 'right')).toEqual(['f2', 'console', 'f1', 'table'])
  })

  it('mixes kinds: an output lands between two scripts', () => {
    expect(placeTab(tabs, 'console', 'f1', 'right')).toEqual(['f1', 'console', 'f2', 'table'])
  })

  it('leaves the order alone for a drop on itself or on an unknown tab', () => {
    expect(placeTab(tabs, 'f1', 'f1', 'left')).toBe(tabs)
    expect(placeTab(tabs, 'f1', 'nope', 'left')).toBe(tabs)
  })
})
