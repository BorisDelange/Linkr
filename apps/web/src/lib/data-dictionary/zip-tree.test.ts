import { describe, expect, it } from 'vitest'
import { zipPathsToTree } from './content'

describe('zipPathsToTree', () => {
  it('drops the folder a forge archive nests everything under', () => {
    expect(zipPathsToTree({
      'data-dictionary-main/concept_sets/1.json': 'a',
      'data-dictionary-main/units/unit_conversions.json': 'b',
      'data-dictionary-main/config.json': 'c',
      'data-dictionary-main/concept_sets_resolved/1.json': 'x',
      'other/concept_sets/2.json': 'y',
    })).toEqual({
      'concept_sets/1.json': 'a',
      'units/unit_conversions.json': 'b',
      'config.json': 'c',
    })
  })

  it('reads an archive of the repository root as is', () => {
    expect(zipPathsToTree({ 'concept_sets/1.json': 'a', 'units/recommended_units.json': 'b' }))
      .toEqual({ 'concept_sets/1.json': 'a', 'units/recommended_units.json': 'b' })
  })
})
