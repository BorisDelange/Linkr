import { describe, it, expect } from 'vitest'
import { LIBRARY_TABLES, libraryViewSql, typedSelect, type LibraryOwner } from './tables'
import { VOCAB_TABLES } from '@/lib/concept-mapping/vocab-files'
import { defaultSelection, importStatus, libraryReleases, type InspectedVocabulary } from './types'

const owner = (prefix: string, vocabularies: string[], ownsAll: boolean, tables: Record<string, string[]>): LibraryOwner => ({
  prefix,
  vocabularies,
  ownsAll,
  tables: new Map(Object.entries(tables).map(([t, cols]) => [t, new Set(cols)])),
})

describe('library tables', () => {
  it('are the ATHENA tables the import accepts', () => {
    expect([...LIBRARY_TABLES].sort()).toEqual([...VOCAB_TABLES].sort())
  })
})

describe('libraryViewSql', () => {
  it('reads a sole owner of its whole export as is', () => {
    expect(libraryViewSql('concept', [owner('"a".main', ['LOINC'], true, { concept: ['concept_id'] })])).toBe('SELECT * FROM "a".main.concept')
  })

  it('keeps only the owned vocabularies, through the owning concept', () => {
    const a = owner('"a".main', ['SNOMED'], false, { concept: ['concept_id'], concept_relationship: ['concept_id_1'] })
    expect(libraryViewSql('concept', [a])).toBe(`SELECT * FROM "a".main.concept WHERE vocabulary_id IN ('SNOMED')`)
    expect(libraryViewSql('concept_relationship', [a])).toBe(
      `SELECT * FROM "a".main.concept_relationship WHERE concept_id_1 IN (SELECT concept_id FROM "a".main.concept WHERE vocabulary_id IN ('SNOMED'))`,
    )
  })

  // Two CSV imports need not infer the same types: a union casts both sides.
  it('casts every side of a union to the library types', () => {
    const a = owner('"a".main', ['SNOMED'], false, { concept: ['concept_id', 'concept_code'] })
    const b = owner('"b".main', ['LOINC'], true, { concept: ['concept_id', 'concept_code', 'valid_start_date'] })
    const sql = libraryViewSql('concept', [a, b])!
    expect(sql).toContain(' UNION ALL BY NAME ')
    expect(sql).toContain(`FROM "a".main.concept WHERE vocabulary_id IN ('SNOMED')`)
    expect(sql).toContain('TRY_CAST(concept_code AS VARCHAR) AS concept_code')
    expect(sql).toContain("TRY_STRPTIME(CAST(valid_start_date AS VARCHAR), '%Y%m%d')::DATE")
    expect(sql).toContain('CAST(NULL AS DATE) AS valid_start_date')
  })

  it('takes shared tables from one import, and skips a table nobody has', () => {
    const a = owner('"a".main', ['SNOMED'], true, { concept: ['concept_id'], domain: ['domain_id'] })
    expect(libraryViewSql('domain', [a], a)).toBe(typedSelect('domain', '"a".main.domain', new Set(['domain_id'])))
    expect(libraryViewSql('drug_strength', [a], a)).toBeNull()
  })
})

describe('import preview', () => {
  const v = (id: string, version: string | null, libraryVersion: string | null, inLibrary = true): InspectedVocabulary =>
    ({ vocabularyId: id, vocabularyName: null, vocabularyVersion: version, conceptCount: 1, inLibrary, libraryVersion })

  it('ticks new and changed vocabularies, not the ones already held at this version', () => {
    const found = [v('LOINC', 'LOINC 2.78', null, false), v('SNOMED', '2026', '2025'), v('UCUM', 'v1', 'v1')]
    expect(found.map(importStatus)).toEqual(['new', 'other', 'same'])
    expect([...defaultSelection(found)]).toEqual(['LOINC', 'SNOMED'])
  })

  it('lists the releases a library mixes', () => {
    const lib = [{ release: 'v5.0 27-FEB-26' }, { release: 'v5.0 30-MAR-27' }, { release: 'v5.0 27-FEB-26' }]
    expect(libraryReleases(lib as never)).toEqual(['v5.0 27-FEB-26', 'v5.0 30-MAR-27'])
  })
})
