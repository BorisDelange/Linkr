import { describe, expect, it } from 'vitest'
import {
  compareByRole,
  NO_ROLE_ICON_COLOR,
  ROLE_ICON_COLOR,
  ROLE_ORDER,
  roleIconColor,
  type PipelineRole,
} from './role-presentation'

const ROLES: Record<string, PipelineRole | undefined> = {
  src: 'source',
  tgt: 'target',
  voc: 'vocab',
  other: undefined,
}
const roleOf = (id: string | undefined) => (id ? ROLES[id] : undefined)

describe('compareByRole', () => {
  it('orders source, target, vocab', () => {
    expect(['voc', 'tgt', 'src'].sort((a, b) => compareByRole(a, b, roleOf)))
      .toEqual(['src', 'tgt', 'voc'])
  })

  it('keeps a database with no role after the three roles', () => {
    expect(['other', 'voc', 'src'].sort((a, b) => compareByRole(a, b, roleOf)))
      .toEqual(['src', 'voc', 'other'])
  })

  it('is stable whatever the input order', () => {
    const a = ['tgt', 'other', 'src', 'voc']
    const b = ['other', 'voc', 'tgt', 'src']
    expect([...a].sort((x, y) => compareByRole(x, y, roleOf)))
      .toEqual([...b].sort((x, y) => compareByRole(x, y, roleOf)))
  })
})

describe('roleIconColor', () => {
  it('gives each role its own colour', () => {
    const colors = ROLE_ORDER.map((r) => roleIconColor(r))
    expect(new Set(colors).size).toBe(ROLE_ORDER.length)
  })

  it('never uses grey — it reads as disabled next to the coloured ones', () => {
    for (const c of [...Object.values(ROLE_ICON_COLOR), NO_ROLE_ICON_COLOR]) {
      expect(c).not.toMatch(/gray|grey|slate|muted/)
    }
  })

  it('marks a database with no role distinctly from the roles', () => {
    expect(Object.values(ROLE_ICON_COLOR)).not.toContain(roleIconColor(undefined))
  })
})
