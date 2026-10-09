import { describe, expect, it } from 'vitest'
import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import { resolveVocabularyTarget } from './vocabulary-target'

const mapping = (tables: { table: string; extraColumns?: Record<string, string> }[]) =>
  mappingV1ToV2({ presetId: 't', presetLabel: { en: 't' }, conceptTables: tables.map((t) => ({ key: t.table, nameColumn: 'name', ...t })) })

const mimic = { id: 'mimic', schemaMapping: mapping([{ table: 'd_items' }, { table: 'd_labitems' }]) }
const athena = { id: 'athena', schemaMapping: mapping([{ table: 'concept', extraColumns: { standard_concept: 'standard_concept' } }]) }
const mixed = { id: 'mixed', schemaMapping: mapping([{ table: 'd_items' }, { table: 'vocab', extraColumns: { standard_concept: 'std' } }]) }

describe('resolveVocabularyTarget', () => {
  it('uses the vocabulary database', () => {
    const target = resolveVocabularyTarget({ vocabularyDataSourceId: 'athena' }, [mimic, athena])
    expect([target?.dsId, target?.conceptTable, target?.dictionary.tables[0]?.table]).toEqual(['athena', 'concept', 'concept'])
  })

  it('puts the OMOP concept table first in a vocabulary database that lists other dictionaries before it', () => {
    const target = resolveVocabularyTarget({ vocabularyDataSourceId: 'mixed' }, [mixed])
    expect(target?.conceptTable).toBe('vocab')
    expect(target?.mapping.concepts?.map((t) => t.from?.table)).toEqual(['vocab', 'd_items'])
  })

  it('keeps the first dictionary of a vocabulary database with no OMOP table', () => {
    expect(resolveVocabularyTarget({ vocabularyDataSourceId: 'mimic' }, [mimic])?.conceptTable).toBe('d_items')
  })

  it('never falls back on the source database', () => {
    // No vocabulary: no target, rather than the warehouse's own concept table
    // searched live, or a native dictionary offered as a target vocabulary.
    expect(resolveVocabularyTarget({}, [mimic, athena])).toBeNull()
    expect(resolveVocabularyTarget({ vocabularyDataSourceId: 'gone' }, [mimic])).toBeNull()
  })
})
