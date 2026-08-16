import { describe, it, expect } from 'vitest'
import {
  buildCachePageQuery,
  buildCacheCountQuery,
  computeAvailableColumns,
  NULL_FILTER_VALUE,
  VALIDITY_COLUMNS,
  CONCEPT_SET_COLUMNS,
  DEFAULT_HIDDEN_COLUMNS,
  type ColumnDescriptor,
} from './concept-queries'
import type { ConceptDictionary } from '@/types/schema-mapping'

const COLS: ColumnDescriptor[] = [
  { id: 'domain_id', source: 'extra', filterable: true },
  { id: 'standard_concept', source: 'extra', filterable: true },
]

describe('buildCachePageQuery filters', () => {
  it('emits equality for a single selected value', () => {
    const sql = buildCachePageQuery({ domain_id: ['Drug'] }, COLS, 0, 50, null)
    expect(sql).toContain(`"domain_id" = 'Drug'`)
    expect(sql).not.toContain('IN (')
  })

  it('emits IN for several values on one column', () => {
    const sql = buildCachePageQuery({ domain_id: ['Drug', 'Measurement'] }, COLS, 0, 50, null)
    expect(sql).toContain(`"domain_id" IN ('Drug', 'Measurement')`)
  })

  it('ANDs filters across different columns', () => {
    const sql = buildCachePageQuery(
      { domain_id: ['Drug'], standard_concept: ['S'] },
      COLS,
      0,
      50,
      null,
    )
    expect(sql).toContain(`"domain_id" = 'Drug'`)
    expect(sql).toContain(`"standard_concept" = 'S'`)
    expect(sql).toContain(' AND ')
  })

  it('translates the NULL sentinel to IS NULL (non-standard concepts)', () => {
    const sql = buildCachePageQuery({ standard_concept: [NULL_FILTER_VALUE] }, COLS, 0, 50, null)
    expect(sql).toContain(`"standard_concept" IS NULL`)
    expect(sql).not.toContain(NULL_FILTER_VALUE)
  })

  it('ORs a real value with NULL when both are selected', () => {
    const sql = buildCachePageQuery(
      { standard_concept: ['S', NULL_FILTER_VALUE] },
      COLS,
      0,
      50,
      null,
    )
    expect(sql).toContain(`("standard_concept" = 'S' OR "standard_concept" IS NULL)`)
  })

  it('ignores empty selections', () => {
    expect(buildCachePageQuery({ domain_id: [] }, COLS, 0, 50, null)).not.toContain('WHERE')
    expect(buildCachePageQuery({ domain_id: null }, COLS, 0, 50, null)).not.toContain('WHERE')
  })

  it('still accepts a bare string (single-select callers)', () => {
    const sql = buildCachePageQuery({ domain_id: 'Drug' }, COLS, 0, 50, null)
    expect(sql).toContain(`"domain_id" = 'Drug'`)
  })

  it('escapes quotes in filter values', () => {
    const sql = buildCachePageQuery({ domain_id: ["O'Brien"] }, COLS, 0, 50, null)
    expect(sql).toContain(`'O''Brien'`)
  })

  it('applies the same predicate to the count query', () => {
    const count = buildCacheCountQuery({ domain_id: ['Drug', 'Device'] }, COLS)
    expect(count).toContain(`"domain_id" IN ('Drug', 'Device')`)
    expect(count).toContain('COUNT(*)')
  })

  it('orders by relevance when a fuzzy search is active and no sort is set', () => {
    const sql = buildCachePageQuery({ _searchFuzzy: 'heart rate' }, COLS, 0, 50, null)
    expect(sql).toContain('jaro_winkler_similarity')
    expect(sql).toContain('ORDER BY (CASE')
  })

  it('lets an explicit sort win over fuzzy relevance', () => {
    const sql = buildCachePageQuery(
      { _searchFuzzy: 'heart rate' },
      COLS,
      0,
      50,
      { columnId: 'record_count', desc: true },
    )
    expect(sql).toContain('ORDER BY "record_count" DESC')
  })
})

describe('computeAvailableColumns ordering', () => {
  const dict: ConceptDictionary = {
    key: 'concept',
    table: 'concept',
    idColumn: 'concept_id',
    nameColumn: 'concept_name',
    codeColumn: 'concept_code',
    terminologyIdColumn: 'vocabulary_id',
    categoryColumn: 'domain_id',
    subcategoryColumn: 'concept_class_id',
    extraColumns: {
      standard_concept: 'standard_concept',
      valid_start_date: 'valid_start_date',
      valid_end_date: 'valid_end_date',
      invalid_reason: 'invalid_reason',
    },
  }

  it('puts patient_count before record_count', () => {
    const ids = computeAvailableColumns([dict]).map((c) => c.id)
    expect(ids.indexOf('patient_count')).toBeLessThan(ids.indexOf('record_count'))
  })

  it('puts the counts last, after the validity trio', () => {
    const ids = computeAvailableColumns([dict]).map((c) => c.id)
    expect(ids.slice(-2)).toEqual(['patient_count', 'record_count'])
    expect(ids.indexOf('invalid_reason')).toBeLessThan(ids.indexOf('patient_count'))
    // The trio keeps its documented order.
    const validityOrder = ids.filter((id) => VALIDITY_COLUMNS.includes(id))
    expect(validityOrder).toEqual(VALIDITY_COLUMNS)
  })

  it('emits each column exactly once', () => {
    const ids = computeAvailableColumns([dict]).map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('omits _dict_key for a single dictionary', () => {
    expect(computeAvailableColumns([dict]).map((c) => c.id)).not.toContain('_dict_key')
  })

  it('leads with _dict_key, next to vocabulary_id, when several dictionaries exist', () => {
    const other: ConceptDictionary = {
      key: 'd_items',
      table: 'd_items',
      idColumn: 'itemid',
      nameColumn: 'label',
      terminologyIdColumn: 'linksto',
    }
    const ids = computeAvailableColumns([dict, other]).map((c) => c.id)
    expect(ids[0]).toBe('_dict_key')
    expect(ids[1]).toBe('vocabulary_id')
  })
})

describe('concept-set (data dictionary) columns', () => {
  const withCode: ConceptDictionary = {
    key: 'concept',
    table: 'concept',
    idColumn: 'concept_id',
    nameColumn: 'concept_name',
    codeColumn: 'concept_code',
    terminologyIdColumn: 'vocabulary_id',
  }
  const withoutCode: ConceptDictionary = {
    key: 'd_items',
    table: 'd_items',
    idColumn: 'itemid',
    nameColumn: 'label',
  }

  it('offers the dictionary columns when the source has both join keys', () => {
    const ids = computeAvailableColumns([withCode]).map((c) => c.id)
    for (const id of CONCEPT_SET_COLUMNS) expect(ids).toContain(id)
  })

  it('omits them when the source has no vocabulary/code to join on', () => {
    const ids = computeAvailableColumns([withoutCode]).map((c) => c.id)
    for (const id of CONCEPT_SET_COLUMNS) expect(ids).not.toContain(id)
  })

  it('hides them by default — they are empty until a dictionary is imported', () => {
    for (const id of CONCEPT_SET_COLUMNS) expect(DEFAULT_HIDDEN_COLUMNS).toContain(id)
  })

  it('never reaches SQL: no SELECT alias and no WHERE predicate', () => {
    const cols = computeAvailableColumns([withCode])
    const sql = buildCachePageQuery(
      { concept_set_name: ['Fibrinogen antigen'] },
      cols,
      0,
      50,
      null,
    )
    // The cache table has no such column — filtering it server-side would throw.
    expect(sql).not.toContain('concept_set_name')
    expect(sql).not.toContain('WHERE')
  })
})
