import { describe, it, expect } from 'vitest'
import {
  readWordSets,
  addWord,
  hasWord,
  removeWord,
  renameWord,
  appliedSets,
  highlightWords,
  toggleSet,
  labelTaken,
  type WordSet,
} from './word-sets'

const SETS: WordSet[] = [
  { id: 'a', label: 'Sepsis', words: ['fever', 'lactate'] },
  { id: 'b', label: 'Bleeding', words: ['haemorrhage'] },
  { id: 'c', label: 'Neuro', words: ['GCS', 'fever'] },
]

describe('readWordSets', () => {
  it('reads the sets a widget stored', () => {
    expect(readWordSets([{ id: 'a', label: 'Sepsis', words: ['fever'] }])).toEqual([
      { id: 'a', label: 'Sepsis', words: ['fever'] },
    ])
  })

  it('keys a set saved before ids existed by its label', () => {
    // These configs are already out there; dropping them would silently lose a
    // clinician's saved sets.
    const [set] = readWordSets([{ label: 'Sepsis', words: ['fever'] }])
    expect(set.id).toBe('label:Sepsis')
    expect(set.label).toBe('Sepsis')
  })

  it('gives the same legacy set the same id every read, so applying one sticks', () => {
    const first = readWordSets([{ label: 'Sepsis', words: ['fever'] }])
    const second = readWordSets([{ label: 'Sepsis', words: ['fever'] }])
    expect(first[0].id).toBe(second[0].id)
  })

  it('survives a config that is missing, empty or the wrong shape', () => {
    expect(readWordSets(undefined)).toEqual([])
    expect(readWordSets(null)).toEqual([])
    expect(readWordSets('sepsis')).toEqual([])
    expect(readWordSets([])).toEqual([])
  })

  it('skips entries that are not sets rather than rendering blank chips', () => {
    expect(readWordSets([null, 42, { words: ['fever'] }, { label: 'Ok', words: [] }])).toEqual([
      { id: 'label:Ok', label: 'Ok', words: [] },
    ])
  })

  it('drops blank and non-string words', () => {
    const [set] = readWordSets([{ label: 'S', words: ['fever', '', '  ', 7, null] }])
    expect(set.words).toEqual(['fever'])
  })
})

describe('addWord', () => {
  it('appends a word', () => {
    expect(addWord(['fever'], 'lactate')).toEqual(['fever', 'lactate'])
  })

  it('trims what was typed', () => {
    expect(addWord([], '  lactate  ')).toEqual(['lactate'])
  })

  it('ignores a blank word', () => {
    const words = ['fever']
    expect(addWord(words, '   ')).toBe(words)
  })

  it('refuses a duplicate whatever its case, since matching ignores case too', () => {
    const words = ['Fever']
    expect(addWord(words, 'fever')).toBe(words)
  })
})

describe('removeWord', () => {
  it('removes it whatever its case', () => {
    expect(removeWord(['Fever', 'lactate'], 'fever')).toEqual(['lactate'])
  })

  it('leaves the rest alone', () => {
    expect(removeWord(['fever'], 'absent')).toEqual(['fever'])
  })
})

describe('renameWord', () => {
  it('renames in place, so the chips do not jump', () => {
    expect(renameWord(['fever', 'lactate', 'gcs'], 'lactate', 'lactates')).toEqual([
      'fever',
      'lactates',
      'gcs',
    ])
  })

  it('collapses a rename onto an existing word instead of duplicating it', () => {
    expect(renameWord(['fever', 'lactate'], 'lactate', 'Fever')).toEqual(['fever'])
  })

  it('ignores a rename to blank', () => {
    const words = ['fever']
    expect(renameWord(words, 'fever', '  ')).toBe(words)
  })
})

describe('hasWord', () => {
  it('ignores case and surrounding space', () => {
    expect(hasWord(['Fever'], ' fever ')).toBe(true)
    expect(hasWord(['Fever'], 'lactate')).toBe(false)
  })
})

describe('appliedSets', () => {
  it('returns the applied ones, in the list order', () => {
    expect(appliedSets(SETS, ['c', 'a']).map((s) => s.id)).toEqual(['a', 'c'])
  })

  it('drops an id whose set was deleted', () => {
    // A deleted set must stop highlighting rather than linger in the config.
    expect(appliedSets(SETS, ['a', 'gone'])).toHaveLength(1)
  })

  it('returns nothing when none is applied', () => {
    expect(appliedSets(SETS, [])).toEqual([])
  })
})

describe('highlightWords', () => {
  it('collects the words of every applied set', () => {
    expect(highlightWords(SETS, ['a', 'b']).map((h) => h.word)).toEqual([
      'fever',
      'lactate',
      'haemorrhage',
    ])
  })

  it('colours each word by its set position in the FULL list', () => {
    // Only the third set is applied; it must still get colour 2, or a set would
    // change colour depending on which of its neighbours happen to be on.
    expect(highlightWords(SETS, ['c'])).toEqual([
      { word: 'GCS', setIndex: 2 },
      { word: 'fever', setIndex: 2 },
    ])
  })

  it('paints a word shared by two applied sets once, in the first set colour', () => {
    // "fever" is in both Sepsis and Neuro. It can only be painted once, and
    // dropping it would leave a word the user asked for unhighlighted.
    const words = highlightWords(SETS, ['a', 'c'])
    expect(words.filter((h) => h.word.toLowerCase() === 'fever')).toEqual([
      { word: 'fever', setIndex: 0 },
    ])
  })

  it('returns nothing when no set is applied', () => {
    expect(highlightWords(SETS, [])).toEqual([])
  })
})

describe('toggleSet', () => {
  it('applies and un-applies one set, leaving the others', () => {
    expect(toggleSet(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleSet(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('labelTaken', () => {
  it('spots a clash whatever the case, since the popover shows labels only', () => {
    expect(labelTaken(SETS, 'sepsis')).toBe(true)
    expect(labelTaken(SETS, 'Renal')).toBe(false)
  })

  it('does not count the set being renamed as a clash with itself', () => {
    expect(labelTaken(SETS, 'Sepsis', 'a')).toBe(false)
  })

  it('treats a blank label as free, so the add button governs that case', () => {
    expect(labelTaken(SETS, '   ')).toBe(false)
  })
})
