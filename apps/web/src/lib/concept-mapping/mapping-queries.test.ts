import { describe, it, expect } from 'vitest'
import { buildFilterOptionsQuery, buildFileSourceFilterOptionsQuery, buildFileSourceConceptsCountQuery, buildFileSourceDuplicateCountQuery } from './mapping-queries'
import type { SchemaMapping } from '@/types/schema-mapping'

const mapping: SchemaMapping = {
  eventTables: [],
  conceptTables: [
    {
      key: 'd_items',
      table: 'd_items',
      nameColumn: 'label',
      terminologyIdColumn: 'vocabulary_id',
      terminologyNameColumn: 'terminology_name',
      categoryColumn: 'category',
      subcategoryColumn: 'subcategory',
    },
  ],
} as unknown as SchemaMapping

describe('buildFilterOptionsQuery — vocabulary scoping', () => {
  it('returns unscoped DISTINCT when no scope is given', () => {
    const sql = buildFilterOptionsQuery(mapping, 'category')
    expect(sql).toContain('SELECT DISTINCT category AS val FROM d_items')
    expect(sql).not.toContain(' IN (')
  })

  it('scopes categories to the selected vocabulary via IN (...)', () => {
    const sql = buildFilterOptionsQuery(mapping, 'category', {
      column: 'vocabulary_id',
      values: ['LOINC', 'SNOMED'],
    })
    expect(sql).toContain("vocabulary_id IN ('LOINC','SNOMED')")
    expect(sql).toContain('category AS val')
  })

  it('scopes by terminology_name when that column drives the filter', () => {
    const sql = buildFilterOptionsQuery(mapping, 'subcategory', {
      column: 'terminology_name',
      values: ['Lab tests'],
    })
    expect(sql).toContain("terminology_name IN ('Lab tests')")
  })

  it('treats an empty scope as no scope', () => {
    const sql = buildFilterOptionsQuery(mapping, 'category', { column: 'vocabulary_id', values: [] })
    expect(sql).not.toContain(' IN (')
  })

  it('escapes single quotes in scope values', () => {
    const sql = buildFilterOptionsQuery(mapping, 'category', {
      column: 'vocabulary_id',
      values: ["O'Brien"],
    })
    expect(sql).toContain("'O''Brien'")
  })

  it('excludes a dictionary that has no column for the scoped vocabulary', () => {
    const noVocab: SchemaMapping = {
      eventTables: [],
      conceptTables: [
        { key: 'plain', table: 'plain', nameColumn: 'label', categoryColumn: 'category' },
      ],
    } as unknown as SchemaMapping
    // Scoping by vocabulary_id, but the only dictionary has no vocab column → no rows.
    const sql = buildFilterOptionsQuery(noVocab, 'category', { column: 'vocabulary_id', values: ['X'] })
    expect(sql).toBe('')
  })
})

describe('buildFileSourceFilterOptionsQuery — vocabulary scoping', () => {
  it('is unscoped by default', () => {
    const sql = buildFileSourceFilterOptionsQuery('category')
    expect(sql).toContain('FROM source_concepts')
    expect(sql).not.toContain(' IN (')
  })

  it('adds an IN (...) clause when scoped', () => {
    const sql = buildFileSourceFilterOptionsQuery('category', { column: 'vocabulary_id', values: ['LOINC'] })
    expect(sql).toContain("vocabulary_id IN ('LOINC')")
  })
})

describe('buildWhereClause — suggestion-category filter', () => {
  const SEP = '\0'
  it('emits a (vocabulary_id, concept_code) tuple IN predicate from the keys', () => {
    const sql = buildFileSourceConceptsCountQuery({
      hasSuggestionCategoryFilter: true,
      suggestionCategoryKeys: [`LOINC${SEP}718-7`, `SNOMED${SEP}38341003`],
    })
    expect(sql).toContain("(vocabulary_id, concept_code) IN (('LOINC','718-7'),('SNOMED','38341003'))")
  })

  it('matches no rows when the filter is on but no keys are provided', () => {
    const sql = buildFileSourceConceptsCountQuery({ hasSuggestionCategoryFilter: true, suggestionCategoryKeys: [] })
    expect(sql).toContain('WHERE 1=0')
  })

  it('adds no predicate when the filter is off', () => {
    const sql = buildFileSourceConceptsCountQuery({})
    expect(sql).not.toContain('vocabulary_id, concept_code')
    expect(sql).not.toContain('1=0')
  })
})

describe('mapping-status filter — keyed by (vocabulary_id, concept_code)', () => {
  const SEP = '\0'
  it('"mapped" matches rows whose (vocab, code) is in the mapped key set', () => {
    const sql = buildFileSourceConceptsCountQuery({
      mappingStatus: 'mapped',
      mappedKeys: [`labo${SEP}CA125`],
    })
    expect(sql).toContain("(vocabulary_id, concept_code) IN (('labo','CA125'))")
  })

  it('"mapped" with no keys matches nothing (1=0)', () => {
    const sql = buildFileSourceConceptsCountQuery({ mappingStatus: 'mapped', mappedKeys: [] })
    expect(sql).toContain('1=0')
  })

  it('"unmapped" excludes both mapped and ignored keys', () => {
    const sql = buildFileSourceConceptsCountQuery({
      mappingStatus: 'unmapped',
      mappedKeys: [`labo${SEP}A`],
      ignoredKeys: [`labo${SEP}B`],
    })
    expect(sql).toContain("NOT (vocabulary_id, concept_code) IN (('labo','A'),('labo','B'))")
  })

  it('"mapped_elsewhere" requires an external key and excludes local mapped', () => {
    const sql = buildFileSourceConceptsCountQuery({
      mappingStatus: 'mapped_elsewhere',
      mappedKeys: [`labo${SEP}A`],
      mappedElsewhereKeys: [`labo${SEP}C`],
    })
    expect(sql).toContain("(vocabulary_id, concept_code) IN (('labo','C'))")
    expect(sql).toContain("NOT (vocabulary_id, concept_code) IN (('labo','A'))")
  })

  it('keys on concept_code alone when no terminology column is mapped (empty vocab)', () => {
    // A file source without a terminologyColumn has no vocabulary_id column in its
    // source_concepts view; referencing it would be a DuckDB Binder Error.
    const sql = buildFileSourceConceptsCountQuery({
      mappingStatus: 'mapped',
      mappedKeys: [`${SEP}CA125`, `${SEP}A1c`],
    })
    expect(sql).toContain("concept_code IN ('CA125','A1c')")
    expect(sql).not.toContain('vocabulary_id')
  })
})

describe('buildFileSourceDuplicateCountQuery', () => {
  it('counts raw rows minus deduped rows', () => {
    const sql = buildFileSourceDuplicateCountQuery()
    expect(sql).toContain('FROM source_concepts_raw')
    expect(sql).toContain('FROM source_concepts')
    expect(sql).toContain('AS removed')
  })
})
