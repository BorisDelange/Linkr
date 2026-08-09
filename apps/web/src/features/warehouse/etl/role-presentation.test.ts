import { describe, expect, it } from 'vitest'
import {
  compareByRole,
  NO_ROLE_ICON_COLOR,
  ROLE_ICON_COLOR,
  ROLE_ORDER,
  roleIconColor,
  splitSentences,
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

describe('splitSentences', () => {
  it('splits the two-sentence stopped explanation', () => {
    const en = 'Stopped before finishing: you stopped the run. The statement already sent to the database ran to completion, so part of the script may have been applied.'
    expect(splitSentences(en)).toHaveLength(2)
  })

  it('splits the French wording, whose first sentence contains a colon', () => {
    const fr = "Interrompu avant la fin : vous avez arrêté l'exécution. L'instruction déjà envoyée à la base est allée jusqu'au bout, une partie du script a donc pu être appliquée."
    const out = splitSentences(fr)
    expect(out).toHaveLength(2)
    // The colon is not a boundary: it belongs to the first sentence.
    expect(out[0]).toContain('Interrompu avant la fin :')
  })

  it('leaves a single sentence alone', () => {
    expect(splitSentences('Waiting to run')).toEqual(['Waiting to run'])
  })

  it('keeps a decimal number in one piece', () => {
    expect(splitSentences('Took 1.5 seconds')).toEqual(['Took 1.5 seconds'])
  })

  it('handles an empty string', () => {
    expect(splitSentences('')).toEqual([])
  })
})
