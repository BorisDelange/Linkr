import { describe, it, expect } from 'vitest'
import { packSetNames, unpackSetNames, SET_SEP } from './concept-set-names'

// A concept can belong to several data dictionaries, and the Concepts table
// packs their names into one cell that is later split back into one button per
// set. The separator therefore has to be something a set name cannot contain.

describe('packSetNames / unpackSetNames', () => {
  it('round-trips several names', () => {
    const names = ['Fibrinogen antigen', 'Fibrinogen in blood']
    expect(unpackSetNames(packSetNames(names))).toEqual(names)
  })

  it('round-trips a name containing a comma and a space', () => {
    // ", " was the old separator, so this name split into two phantom entries
    // that matched no set and opened nothing.
    const names = ['Labs, chemistry', 'Vitals']
    expect(unpackSetNames(packSetNames(names))).toEqual(names)
  })

  it('de-duplicates and drops empties, so a cell has no blank buttons', () => {
    expect(unpackSetNames(packSetNames(['A', 'A', '', 'B']))).toEqual(['A', 'B'])
  })

  it('treats an empty cell as no sets rather than one empty name', () => {
    expect(unpackSetNames('')).toEqual([])
    expect(packSetNames([])).toBe('')
  })

  it('uses a separator that cannot occur in a name', () => {
    expect(SET_SEP).toBe('\u0000')
  })
})
