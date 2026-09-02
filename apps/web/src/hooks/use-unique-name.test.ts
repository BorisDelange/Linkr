import { describe, expect, it } from 'vitest'
import { nameCollides } from './use-unique-name'

const board = (id: string, name: Record<string, string>) => ({ id, name })

describe('nameCollides', () => {
  const siblings = [board('a', { en: 'Adults', fr: 'Adultes' }), board('b', { en: 'Children' })]

  it('flags a name another sibling already carries', () => {
    expect(nameCollides('Adults', siblings, 'en')).toBe(true)
    expect(nameCollides('Newborns', siblings, 'en')).toBe(false)
  })

  // Renaming without touching the name must not report the entity against itself.
  it('ignores the entity being renamed', () => {
    expect(nameCollides('Adults', siblings, 'en', 'a')).toBe(false)
    expect(nameCollides('Adults', siblings, 'en', 'b')).toBe(true)
  })

  // The clash the user can see is the one in the language on screen.
  it('compares in the active language only', () => {
    expect(nameCollides('Adultes', siblings, 'fr')).toBe(true)
    expect(nameCollides('Adultes', siblings, 'en')).toBe(false)
  })

  it('is case- and blank-insensitive, and lets a blank name through', () => {
    expect(nameCollides('  adults ', siblings, 'en')).toBe(true)
    expect(nameCollides('', siblings, 'en')).toBe(false)
  })
})
