import { describe, it, expect } from 'vitest'
import { slugifyId, uniqueEntityId, migrateEntityIds } from './slugify-id'

describe('slugifyId', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyId('OMOP CDM 5.4')).toBe('omop-cdm-5-4')
  })

  it('strips accents', () => {
    expect(slugifyId('Réanimation Médicale')).toBe('reanimation-medicale')
  })

  it('drops leading and trailing hyphens', () => {
    expect(slugifyId('  (copy) ')).toBe('copy')
  })

  it('returns an empty string when nothing survives', () => {
    expect(slugifyId('!!!')).toBe('')
  })
})

describe('uniqueEntityId', () => {
  it('returns the base when it is free', () => {
    expect(uniqueEntityId('omop-cdm-5-4-copy', [])).toBe('omop-cdm-5-4-copy')
  })

  it('appends a counter starting at 2 when taken', () => {
    expect(uniqueEntityId('omop', ['omop'])).toBe('omop-2')
    expect(uniqueEntityId('omop', ['omop', 'omop-2'])).toBe('omop-3')
  })

  it('skips over a gap rather than reusing it', () => {
    expect(uniqueEntityId('omop', ['omop', 'omop-2', 'omop-3'])).toBe('omop-4')
  })

  it('falls back to "entity" for an empty slug', () => {
    expect(uniqueEntityId('', [])).toBe('entity')
  })

  it('pads a 1-character slug, since an id needs at least two', () => {
    expect(uniqueEntityId('a', [])).toBe('entity-a')
  })
})

describe('migrateEntityIds', () => {
  it('only fills in entities that lack an id', () => {
    const entities = [{ name: 'Alpha', entityId: 'kept' }, { name: 'Beta' as string, entityId: undefined }]
    const mutated = migrateEntityIds(entities, (e) => e.name)
    expect(entities[0]!.entityId).toBe('kept')
    expect(entities[1]!.entityId).toBe('beta')
    expect(mutated).toHaveLength(1)
  })

  it('deduplicates against ids already present and ones it just assigned', () => {
    const entities = [
      { name: 'Cohort', entityId: 'cohort' },
      { name: 'Cohort', entityId: undefined },
      { name: 'Cohort', entityId: undefined },
    ]
    migrateEntityIds(entities, (e) => e.name)
    expect(entities[1]!.entityId).toBe('cohort-2')
    expect(entities[2]!.entityId).toBe('cohort-3')
  })
})
