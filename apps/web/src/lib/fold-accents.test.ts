import { describe, expect, it } from 'vitest'
import { foldAccents } from './fold-accents'
import { generateAlias } from './duckdb/engine'
import { slugifyId } from './slugify-id'

describe('foldAccents', () => {
  it('drops accents and spells out ligatures', () => {
    expect(foldAccents('Patients masculins décédés')).toBe('Patients masculins decedes')
    expect(foldAccents('Cœur, Æther, Straße, Ørsted, Łódź')).toBe('Coeur, AEther, Strasse, Orsted, Lodz')
  })

  it('leaves ASCII alone', () => {
    expect(foldAccents('MIMIC-IV (raw)')).toBe('MIMIC-IV (raw)')
  })
})

describe('accent-folding slugs', () => {
  it('keeps the letters of an accented name', () => {
    expect(generateAlias('Patients masculins décédés')).toBe('patients_masculins_decedes')
    expect(slugifyId('Sœurs à l’hôpital')).toBe('soeurs-a-l-hopital')
  })
})
