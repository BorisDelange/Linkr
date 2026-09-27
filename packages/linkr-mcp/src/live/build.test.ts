import { describe, expect, it } from 'vitest'
import { TOOLSETS, buildServer, selectedToolsets } from './build'

describe('selectedToolsets', () => {
  it('means every toolset when unset or "all"', () => {
    expect(selectedToolsets(undefined)).toEqual(Object.keys(TOOLSETS))
    expect(selectedToolsets(' all ')).toEqual(Object.keys(TOOLSETS))
  })

  it('keeps the named ones and refuses unknown names', () => {
    expect(selectedToolsets('Lab, ide')).toEqual(['lab', 'ide'])
    expect(() => selectedToolsets('lab,cohorts')).toThrow(/unknown toolset\(s\) cohorts/)
  })
})

describe('buildServer', () => {
  it('registers every tool once (a duplicate name throws)', () => {
    expect(() => buildServer()).not.toThrow()
  })

  it('registers a subset without the others', () => {
    expect(() => buildServer(['git'])).not.toThrow()
  })
})
