import { describe, it, expect } from 'vitest'
import { buildFileSourceConceptsQuery, buildFilterOptionsQuery, buildFileSourceFilterOptionsQuery, buildFileSourceConceptsCountQuery, buildFileSourceDuplicateCountQuery, buildSourceConceptsGroupCountQuery, buildFileSourceConceptsGroupCountQuery, buildStandardConceptSearchQuery } from './mapping-queries'
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

describe('buildSourceConceptsGroupCountQuery — per-group totals over the DB source', () => {
  it('groups totals by vocabulary_id', () => {
    const sql = buildSourceConceptsGroupCountQuery(mapping, 'vocabulary_id')
    expect(sql).toContain('vocabulary_id AS group_key')
    expect(sql).toContain('COUNT(*) AS total')
    expect(sql).toContain('GROUP BY vocabulary_id')
  })

  it('groups totals by category when a category column is mapped', () => {
    const sql = buildSourceConceptsGroupCountQuery(mapping, 'category')
    expect(sql).toContain('category AS group_key')
    expect(sql).toContain('GROUP BY category')
  })

  it('returns empty string for category when no dictionary maps a category column', () => {
    const noCategory: SchemaMapping = {
      eventTables: [],
      conceptTables: [
        { key: 'd', table: 'd', nameColumn: 'label', terminologyIdColumn: 'vocabulary_id' },
      ],
    } as unknown as SchemaMapping
    expect(buildSourceConceptsGroupCountQuery(noCategory, 'category')).toBe('')
    // vocabulary_id is always projected, so it still produces a query.
    expect(buildSourceConceptsGroupCountQuery(noCategory, 'vocabulary_id')).not.toBe('')
  })

  it('returns empty string when there are no concept tables', () => {
    const empty = { eventTables: [], conceptTables: [] } as unknown as SchemaMapping
    expect(buildSourceConceptsGroupCountQuery(empty, 'vocabulary_id')).toBe('')
  })
})

describe('buildFileSourceConceptsGroupCountQuery — per-group totals over the file source', () => {
  it('groups by vocabulary_id when the column is present', () => {
    const sql = buildFileSourceConceptsGroupCountQuery('vocabulary_id', { vocabulary: true, category: true })
    expect(sql).toContain('vocabulary_id AS group_key')
    expect(sql).toContain('FROM source_concepts')
    expect(sql).toContain('GROUP BY vocabulary_id')
  })

  it('returns empty string when the requested column is absent (avoids a Binder Error)', () => {
    expect(buildFileSourceConceptsGroupCountQuery('vocabulary_id', { vocabulary: false, category: true })).toBe('')
    expect(buildFileSourceConceptsGroupCountQuery('category', { vocabulary: true, category: false })).toBe('')
  })
})

const vocabMapping: SchemaMapping = {
  eventTables: [],
  conceptTables: [
    {
      key: 'concept',
      table: 'concept',
      idColumn: 'concept_id',
      nameColumn: 'concept_name',
      codeColumn: 'concept_code',
      vocabularyColumn: 'vocabulary_id',
      extraColumns: {
        domain_id: 'domain_id',
        concept_class_id: 'concept_class_id',
        standard_concept: 'standard_concept',
        invalid_reason: 'invalid_reason',
      },
    },
  ],
} as unknown as SchemaMapping

describe('buildStandardConceptSearchQuery', () => {
  it('caps the result set at the requested limit', () => {
    const sql = buildStandardConceptSearchQuery(vocabMapping, '', undefined, 25)
    expect(sql).toContain('LIMIT 25')
  })

  // Rows sharing a rank would otherwise come back in scan order, so the same
  // search could list them differently from one run to the next.
  it('orders a ranked search by rank then concept_id, for a stable listing', () => {
    const sql = buildStandardConceptSearchQuery(vocabMapping, 'aspirin', undefined, 25)
    expect(sql).toContain('ORDER BY _rank, d.concept_id')
  })

  it('selects the columns the browse table renders', () => {
    const sql = buildStandardConceptSearchQuery(vocabMapping, '', undefined, 25)
    expect(sql).toContain('AS standard_concept')
    expect(sql).toContain('AS invalid_reason')
  })

  it('applies the popover filters to the query', () => {
    const sql = buildStandardConceptSearchQuery(
      vocabMapping,
      '',
      { vocabularyIds: ['SNOMED'], conceptClassIds: ['Clinical Finding'], standardConcepts: ['S'] },
      25,
    )
    expect(sql).toContain("vocabulary_id IN ('SNOMED')")
    expect(sql).toContain("concept_class_id IN ('Clinical Finding')")
    expect(sql).toContain("standard_concept IN ('S')")
  })
})

describe('buildFileSourceConceptsQuery — source concept id search', () => {
  const q = (filters: Parameters<typeof buildFileSourceConceptsQuery>[0]) =>
    buildFileSourceConceptsQuery(filters, null, 10, 0)

  it('matches the id column when the source carries its own ids', () => {
    expect(q({ searchId: '42' })).toContain("CAST(concept_id AS VARCHAR) LIKE '42%'")
  })

  it('filters on the concepts the registry id resolved to', () => {
    // The displayed id is not a column of the source, so matching it against
    // concept_id finds nothing \u2014 the caller resolves it to (vocab, code) first.
    const sql = q({ searchId: '2000153806', registryIdKeys: ['labo\u0000BVRSG_OBR_GAH1'] })
    expect(sql).toContain("(vocabulary_id, concept_code) IN (('labo','BVRSG_OBR_GAH1'))")
    expect(sql).not.toContain('CAST(concept_id AS VARCHAR)')
  })

  it('returns nothing when the id matched no concept', () => {
    // An empty resolution is "no such id", never "no filter" \u2014 falling through
    // to an unfiltered query would show every row for a bad search.
    const sql = q({ searchId: '999', registryIdKeys: [] })
    expect(sql).toContain('FALSE')
    expect(sql).not.toContain('CAST(concept_id AS VARCHAR)')
  })
})

describe('buildFileSourceConceptsQuery — pagination is a stable window', () => {
  // A LIMIT/OFFSET over a non-unique ORDER BY is not a window over one total
  // order: ties resolve however the engine feels, and DuckDB parallelises, so
  // two pages of the same set can both contain a row — or neither. That showed
  // up as concepts stuck at the top of the table after paging or filtering.
  const q = (
    filters: Parameters<typeof buildFileSourceConceptsQuery>[0],
    sorting: Parameters<typeof buildFileSourceConceptsQuery>[1],
  ) => buildFileSourceConceptsQuery(filters, sorting, 50, 50)

  it('breaks ties on concept_id when sorting by a non-unique column', () => {
    // record_count is 0 for thousands of concepts.
    expect(q({}, { columnId: 'record_count', desc: true })).toContain(
      'ORDER BY record_count DESC NULLS LAST, concept_id ASC',
    )
  })

  it('breaks ties on concept_id when sorting ascending too', () => {
    expect(q({}, { columnId: 'patient_count', desc: false })).toContain(
      'ORDER BY patient_count ASC NULLS LAST, concept_id ASC',
    )
  })

  it('breaks ties on concept_id with no explicit sort', () => {
    // Two concepts can share a name across vocabularies.
    expect(q({}, null)).toContain('ORDER BY concept_name ASC, concept_id ASC')
  })

  it('breaks ties on concept_id when ordering by fuzzy relevance', () => {
    const sql = q({ searchText: 'heart' }, null)
    expect(sql).toContain('concept_name ASC, concept_id ASC')
  })

  it('still applies the window after the tiebreaker', () => {
    expect(q({}, { columnId: 'record_count', desc: true })).toContain('LIMIT 50 OFFSET 50')
  })
})
