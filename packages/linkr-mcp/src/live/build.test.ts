import { describe, expect, it } from 'vitest'
import { CATALOG, CORE_TOOLS, TOOLSETS, buildServer, selectedToolsets } from './build'
import { inputJsonSchema } from './gateway'
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

  it('gives every parameter a single type, which grammar-constrained providers require', () => {
    const unions = (node: unknown, at: string): string[] => {
      if (Array.isArray(node)) return node.flatMap((n, i) => unions(n, `${at}[${i}]`))
      if (typeof node !== 'object' || node === null) return []
      const here = Object.entries(node as Record<string, unknown>)
        .filter(([key, value]) => key === 'anyOf' || key === 'oneOf' || (key === 'type' && Array.isArray(value)))
        .map(([key]) => `${at}.${key}`)
      return [...here, ...Object.entries(node).flatMap(([key, value]) => unions(value, `${at}.${key}`))]
    }
    expect(CATALOG.flatMap((t) => unions(inputJsonSchema(t), t.name))).toEqual([])
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
