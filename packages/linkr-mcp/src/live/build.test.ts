import { describe, expect, it } from 'vitest'
import { CATALOG, CORE_TOOLS, TOOLSETS, buildServer, selectedToolsets } from './build'
import { FAMILIES } from './tools-gateway'

describe('selectedToolsets', () => {
  it('is the core only when unset, every family with "all"', () => {
    expect(selectedToolsets(undefined)).toEqual([])
    expect(selectedToolsets(' all ')).toEqual(Object.keys(TOOLSETS))
  })

  it('keeps the named ones and refuses unknown names', () => {
    expect(selectedToolsets('Lab, ide')).toEqual(['lab', 'ide'])
    expect(() => selectedToolsets('lab,cohorts')).toThrow(/unknown toolset\(s\) cohorts/)
  })
})

describe('catalog', () => {
  it('holds every tool once', () => {
    const names = CATALOG.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('knows every core tool and describes every family', () => {
    const names = new Set(CATALOG.map((t) => t.name))
    expect(CORE_TOOLS.filter((n) => !names.has(n))).toEqual([])
    expect(Object.keys(FAMILIES).sort()).toEqual(Object.keys(TOOLSETS).sort())
  })
})

describe('buildServer', () => {
  it('builds the core + gateway, a family on top, or everything', () => {
    expect(() => buildServer([])).not.toThrow()
    expect(() => buildServer(['git'])).not.toThrow()
    expect(() => buildServer(Object.keys(TOOLSETS))).not.toThrow()
  })
})
