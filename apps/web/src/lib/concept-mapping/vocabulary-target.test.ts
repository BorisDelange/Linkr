import { describe, expect, it } from 'vitest'
import type { SchemaMapping } from '@/types/schema-mapping'
import { resolveVocabularyTarget } from './vocabulary-target'

const mapping = (tables: { table: string; extraColumns?: Record<string, string> }[]) =>
  ({ eventTables: [], conceptTables: tables.map((t) => ({ key: t.table, ...t })) }) as unknown as SchemaMapping

const mimic = { id: 'mimic', schemaMapping: mapping([{ table: 'd_items' }, { table: 'd_labitems' }]) }
const athena = { id: 'athena', schemaMapping: mapping([{ table: 'concept', extraColumns: { standard_concept: 'standard_concept' } }]) }
const mixed = { id: 'mixed', schemaMapping: mapping([{ table: 'd_items' }, { table: 'vocab', extraColumns: { standard_concept: 'std' } }]) }

describe('resolveVocabularyTarget', () => {
  it('uses the vocabulary database over the source database', () => {
    const target = resolveVocabularyTarget({ vocabularyDataSourceId: 'athena' }, mimic, [mimic, athena])
    expect([target?.dsId, target?.conceptTable, target?.dictionary.table]).toEqual(['athena', 'concept', 'concept'])
  })

  it('puts the OMOP concept table first in a database that lists its own dictionaries before it', () => {
    const target = resolveVocabularyTarget({}, mixed, [mixed])
    expect(target?.conceptTable).toBe('vocab')
    expect(target?.mapping.conceptTables?.map((t) => t.table)).toEqual(['vocab', 'd_items'])
  })

  it('keeps the first dictionary when there is no OMOP table, and gives up without one', () => {
    expect(resolveVocabularyTarget({}, mimic, [mimic])?.conceptTable).toBe('d_items')
    expect(resolveVocabularyTarget({ vocabularyDataSourceId: 'gone' }, null, [mimic])).toBeNull()
  })
})
