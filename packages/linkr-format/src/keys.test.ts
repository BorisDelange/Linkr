import { describe, expect, it } from 'vitest'
import { buildTabKeyMap, buildWidgetKeyMap, dashboardKey } from './keys.js'

describe('dashboardKey', () => {
  it('slugs the English name', () => {
    expect(dashboardKey({ en: 'ICU Activity', fr: 'Activité' })).toBe('icu-activity')
  })

  it('falls back to another language when English is missing', () => {
    // Mirrors the app's localized(): `||` not `??`, so a defined-but-empty
    // language falls through rather than producing a blank key.
    expect(dashboardKey({ en: '', fr: 'Activité' })).toBe('activite')
  })

  it('accepts a bare string, as legacy exports carry', () => {
    expect(dashboardKey('CLIP-MIR')).toBe('clip-mir')
  })
})

describe('buildTabKeyMap', () => {
  it('qualifies root tabs by the dashboard', () => {
    const keys = buildTabKeyMap('overview', [
      { id: 't1', name: { en: 'Demographics' }, displayOrder: 0 },
    ])
    expect(keys.get('t1')).toBe('overview/demographics')
  })

  it('qualifies a sub-tab by its parent, whatever the input order', () => {
    // Children may come before parents; the map sorts parents first.
    const keys = buildTabKeyMap('overview', [
      { id: 't2', name: { en: 'Detail' }, parentTabId: 't1', displayOrder: 0 },
      { id: 't1', name: { en: 'Demographics' }, displayOrder: 0 },
    ])
    expect(keys.get('t2')).toBe('overview/demographics/detail')
  })

  it('disambiguates colliding siblings by displayOrder', () => {
    const keys = buildTabKeyMap('overview', [
      { id: 't1', name: { en: 'Tab' }, displayOrder: 0 },
      { id: 't2', name: { en: 'Tab' }, displayOrder: 1 },
    ])
    expect([keys.get('t1'), keys.get('t2')]).toEqual(['overview/tab', 'overview/tab#1'])
  })
})

describe('buildWidgetKeyMap', () => {
  const tabs = buildTabKeyMap('overview', [{ id: 't1', name: { en: 'Main' }, displayOrder: 0 }])

  it('qualifies a widget by its tab and grid position', () => {
    const keys = buildWidgetKeyMap(tabs, [
      { id: 'w1', name: { en: 'Age distribution' }, tabId: 't1', layout: { x: 12, y: 4 } },
    ])
    expect(keys.get('w1')).toBe('overview/main/age-distribution@4,12')
  })

  it('is stable regardless of the order widgets are read in', () => {
    // Two same-named widgets at one position collide; the `#i` counter is handed
    // out in id order, so an unordered read would swap their keys on re-export.
    const a = { id: 'b', name: { en: 'KPI' }, tabId: 't1', layout: { x: 0, y: 0 } }
    const b = { id: 'a', name: { en: 'KPI' }, tabId: 't1', layout: { x: 0, y: 0 } }
    const one = buildWidgetKeyMap(tabs, [a, b])
    const two = buildWidgetKeyMap(tabs, [b, a])
    expect(one.get('a')).toBe(two.get('a'))
    expect(one.get('b')).toBe(two.get('b'))
    expect(one.get('a')).toBe('overview/main/kpi@0,0')
  })

  it('gives a widget in an unknown tab an empty prefix rather than throwing', () => {
    const keys = buildWidgetKeyMap(tabs, [
      { id: 'w1', name: { en: 'Orphan' }, tabId: 'ghost', layout: { x: 0, y: 0 } },
    ])
    expect(keys.get('w1')).toBe('/orphan@0,0')
  })
})
