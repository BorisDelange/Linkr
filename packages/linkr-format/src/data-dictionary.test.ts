import { describe, expect, it } from 'vitest'
import { isDictionaryFile, isWorkspaceDictionaryFile } from './data-dictionary.js'

describe('dictionary files', () => {
  it('keeps what a sync reads, nothing else of the repository', () => {
    expect(['concept_sets/1.json', 'units/unit_conversions.json', 'units/recommended_units.json', 'config.json'].every(isDictionaryFile)).toBe(true)
    expect(['concept_sets/resolved/1.json', 'app/package.json', 'README.md'].some(isDictionaryFile)).toBe(false)
  })

  it('reads a workspace tree: the index and each clone\'s dictionary files', () => {
    expect(isWorkspaceDictionaryFile('data-dictionaries/_dictionaries.json')).toBe(true)
    expect(isWorkspaceDictionaryFile('data-dictionaries/core/concept_sets/1.json')).toBe(true)
    expect(isWorkspaceDictionaryFile('data-dictionaries/core/app/package.json')).toBe(false)
    expect(isWorkspaceDictionaryFile('data-dictionaries/concept_sets/1.json')).toBe(false)
  })
})
