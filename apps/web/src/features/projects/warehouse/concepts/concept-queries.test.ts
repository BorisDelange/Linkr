import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  buildCachePageQuery,
  buildCacheCountQuery,
  buildCacheDetailsQuery,
  buildConceptsFullQuery,
  buildCacheFilterOptionsQuery,
  buildConceptsCountQuery,
  buildFilterOptionsQuery,
  FILTER_OPTIONS_LIMIT,
  computeAvailableColumns,
  NULL_FILTER_VALUE,
  VALIDITY_COLUMNS,
  CONCEPT_SET_COLUMNS,
  DEFAULT_HIDDEN_COLUMNS,
  type ColumnDescriptor,
} from './concept-queries'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { conceptRelations } from '@/lib/schema-classes/relations'
import { matchFilterValue } from '@/lib/match-filter'

type ConceptDictionary = NonNullable<SchemaMappingV1['conceptTables']>[number]
const rels = (...conceptTables: ConceptDictionary[]) =>
  conceptRelations(mappingV1ToV2({ presetId: 't', presetLabel: { en: 't' }, conceptTables }))

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

  it('ranks on the code only when the output has a code column', () => {
    // MIMIC d_items has no code: naming concept_code in the ORDER BY made the
    // whole search fail to bind.
    const noCode = buildCachePageQuery({ _searchFuzzy: 'heart rate' }, COLS, 0, 50, null)
    expect(noCode).not.toContain('concept_code')
    const withCode = [...COLS, { id: 'concept_code', source: 'code', filterable: false } as ColumnDescriptor]
    expect(buildCachePageQuery({ _searchFuzzy: 'heart rate' }, withCode, 0, 50, null)).toContain('concept_code')
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

  it('keeps the OMOP names when the dictionary reads domain_id / concept_class_id', () => {
    const cols = computeAvailableColumns(rels(dict))
    expect(cols.find((c) => c.id === 'domain_id')?.labelKey).toBeUndefined()
    expect(cols.find((c) => c.id === 'concept_class_id')?.labelKey).toBeUndefined()
  })

  it('calls them category / subcategory for another schema', () => {
    const cols = computeAvailableColumns(rels({ ...dict, categoryColumn: 'category', subcategoryColumn: 'type' }))
    expect(cols.find((c) => c.id === 'domain_id')?.labelKey).toBe('concepts.column_category')
    expect(cols.find((c) => c.id === 'concept_class_id')?.labelKey).toBe('concepts.column_subcategory')
  })

  it('puts the domain and the class right after the vocabulary', () => {
    const ids = computeAvailableColumns(rels(dict)).map((c) => c.id)
    expect(ids.slice(0, 6)).toEqual(
      ['vocabulary_id', 'domain_id', 'concept_class_id', 'concept_id', 'concept_name', 'concept_code'],
    )
  })

  it('puts patient_count before record_count', () => {
    const ids = computeAvailableColumns(rels(dict)).map((c) => c.id)
    expect(ids.indexOf('patient_count')).toBeLessThan(ids.indexOf('record_count'))
  })

  it('puts the counts last, after the validity trio', () => {
    const ids = computeAvailableColumns(rels(dict)).map((c) => c.id)
    expect(ids.slice(-2)).toEqual(['patient_count', 'record_count'])
    expect(ids.indexOf('invalid_reason')).toBeLessThan(ids.indexOf('patient_count'))
    // The trio keeps its documented order.
    const validityOrder = ids.filter((id) => VALIDITY_COLUMNS.includes(id))
    expect(validityOrder).toEqual(VALIDITY_COLUMNS)
  })

  it('emits each column exactly once', () => {
    const ids = computeAvailableColumns(rels(dict)).map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('omits _dict_key for a single dictionary', () => {
    expect(computeAvailableColumns(rels(dict)).map((c) => c.id)).not.toContain('_dict_key')
  })

  it('leads with _dict_key, next to vocabulary_id, when several dictionaries exist', () => {
    const other: ConceptDictionary = {
      key: 'd_items',
      table: 'd_items',
      idColumn: 'itemid',
      nameColumn: 'label',
      terminologyIdColumn: 'linksto',
    }
    const ids = computeAvailableColumns(rels(dict, other)).map((c) => c.id)
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
    const ids = computeAvailableColumns(rels(withCode)).map((c) => c.id)
    for (const id of CONCEPT_SET_COLUMNS) expect(ids).toContain(id)
  })

  it('omits them when the source has no vocabulary/code to join on', () => {
    const ids = computeAvailableColumns(rels(withoutCode)).map((c) => c.id)
    for (const id of CONCEPT_SET_COLUMNS) expect(ids).not.toContain(id)
  })

  it('hides them by default — they are empty until a dictionary is imported', () => {
    for (const id of CONCEPT_SET_COLUMNS) expect(DEFAULT_HIDDEN_COLUMNS).toContain(id)
  })

  it('never reaches SQL: no SELECT alias and no WHERE predicate', () => {
    const cols = computeAvailableColumns(rels(withCode))
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

describe('concept list order', () => {
  it('breaks ties on concept_id, so pages neither repeat nor skip a concept', () => {
    // Before any count every record_count is NULL: sorted on it alone, the rows
    // come in any order and an OFFSET page is a different draw each time.
    expect(buildCachePageQuery({}, COLS, 1, 50, { columnId: 'record_count', desc: true }))
      .toContain('ORDER BY "record_count" DESC, concept_id LIMIT 50 OFFSET 50')
    expect(buildCachePageQuery({}, COLS, 0, 50, { columnId: 'concept_id', desc: false }))
      .toContain('ORDER BY "concept_id" ASC LIMIT')
  })
})

describe('Name filter over several dictionaries', () => {
  const two: ConceptDictionary[] = [
    { key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' },
    { key: 'd_items', table: 'd_items', idColumn: 'itemid', nameColumn: 'label' },
  ]
  const mapping = mappingV1ToV2({ presetId: 't', presetLabel: { en: 't' }, conceptTables: two })
  const [a, b] = conceptRelations(mapping)

  it('falls back on a typo only when no active dictionary holds the words', () => {
    const sql = buildConceptsCountQuery(mapping, { _searchText: 'antecedant' }, computeAvailableColumns(conceptRelations(mapping)))!
    const scope = `NOT EXISTS (SELECT 1 FROM (SELECT concept_name FROM ${a.name} UNION ALL SELECT concept_name FROM ${b.name}) _lf`
    expect(sql.split(scope)).toHaveLength(3)
  })

  it('reads the one dictionary a dictionary filter keeps', () => {
    const sql = buildConceptsCountQuery(mapping, { _searchText: 'x', _dict_key: ['d_items'] }, computeAvailableColumns(conceptRelations(mapping)))!
    expect(sql).toContain(`NOT EXISTS (SELECT 1 FROM ${b.name} _lf`)
    expect(sql).not.toContain('UNION ALL')
  })
})

describe('column dropdown options, searched past FILTER_OPTIONS_LIMIT', () => {
  it('reads one page of distinct values with the count of all of them', () => {
    const sql = buildCacheFilterOptionsQuery('domain_id')
    expect(sql).toContain('SELECT DISTINCT CAST("domain_id" AS VARCHAR) AS val FROM concepts WHERE "domain_id" IS NOT NULL')
    expect(sql).toContain('COUNT(*) OVER ()::INTEGER AS total')
    expect(sql).toMatch(new RegExp(`ORDER BY val LIMIT ${FILTER_OPTIONS_LIMIT}$`))
    expect(sql).not.toContain('jaro_winkler')
  })

  it('searches the values under the label filter rule', () => {
    const sql = buildCacheFilterOptionsQuery('domain_id', "myco l'a")
    expect(sql).toContain("contains(strip_accents(LOWER(val)), strip_accents(LOWER('myco')))")
    expect(sql).toContain("strip_accents(LOWER('l''a'))")
    expect(sql).toContain('FROM _opts _lf')
  })

  it('reads every dictionary holding the column', () => {
    const mapping = mappingV1ToV2({ presetId: 't', presetLabel: { en: 't' }, conceptTables: [
      { key: 'a', table: 'dict_a', idColumn: 'id', nameColumn: 'name', categoryColumn: 'cat' },
      { key: 'b', table: 'dict_b', idColumn: 'id', nameColumn: 'name', categoryColumn: 'cat' },
    ] })
    const [a, b] = conceptRelations(mapping)
    const sql = buildFilterOptionsQuery(mapping, 'domain_id', 'myco')!
    expect(sql).toContain(`FROM ${a.name} WHERE "category" IS NOT NULL UNION ALL`)
    expect(sql).toContain(`FROM ${b.name} WHERE "category" IS NOT NULL`)
  })

  it('filters the table on a match value as on the values it matches, OR exact ones', () => {
    const sql = buildCachePageQuery({ domain_id: [matchFilterValue('myco'), 'Drug'] }, COLS, 0, 50, null)
    expect(sql).toContain(`("domain_id" = 'Drug' OR CAST("domain_id" AS VARCHAR) IN (WITH _opts AS (SELECT DISTINCT`)
    expect(sql).toContain("contains(strip_accents(LOWER(val)), strip_accents(LOWER('myco')))")
  })
})

describe('several concepts read in one query', () => {
  const mapping = mappingV1ToV2({ presetId: 't', presetLabel: { en: 't' }, conceptTables: [
    { key: 'a', table: 'dict_a', idColumn: 'id', nameColumn: 'name' },
    { key: 'b', table: 'dict_b', idColumn: 'id', nameColumn: 'name' },
  ] })

  it('reads every dictionary for the ids at once', () => {
    const sql = buildConceptsFullQuery(mapping, [3, 1, 2])!
    expect(sql.match(/c\.concept_id IN \(3, 1, 2\)/g)).toHaveLength(2)
    expect(sql).toContain(' UNION ALL ')
    expect(buildCacheDetailsQuery([3, 1])).toBe('SELECT * FROM concepts WHERE concept_id IN (3, 1)')
  })

  it('builds nothing for ids that are not all integers', () => {
    const ids = [1, '2) OR (1=1' as unknown as number]
    expect(buildConceptsFullQuery(mapping, ids)).toBeNull()
    expect(buildCacheDetailsQuery(ids)).toBeNull()
    expect(buildCacheDetailsQuery([])).toBeNull()
  })
})

// apps/api/tests/test_concept_filter_scale.py runs this SQL on a 10-million-row
// concept list and times it. Regenerate after a builder change:
//   GOLDEN_UPDATE=1 npx vitest run src/features/projects/warehouse/concepts/concept-queries.test.ts
describe('column filter SQL run at scale', () => {
  const fixture = new URL('./concept-filter-scale.fixture.json', import.meta.url)
  const sql = {
    firstPage: buildCacheFilterOptionsQuery('domain_id'),
    search: buildCacheFilterOptionsQuery('domain_id', 'myco'),
    typo: buildCacheFilterOptionsQuery('domain_id', 'mycolgie'),
    noMatch: buildCacheFilterOptionsQuery('domain_id', 'zzqxw'),
    tablePage: buildCachePageQuery({ domain_id: [matchFilterValue('myco')] }, COLS, 0, 50, null),
    tableCount: buildCacheCountQuery({ domain_id: [matchFilterValue('myco'), 'Virologie 7'] }, COLS),
  }

  it('is the SQL the scale test runs', () => {
    if (process.env.GOLDEN_UPDATE === '1') writeFileSync(fixture, `${JSON.stringify(sql, null, 2)}\n`)
    expect(JSON.parse(readFileSync(fixture, 'utf8'))).toEqual(sql)
  })
})
