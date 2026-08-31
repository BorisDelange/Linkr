import { describe, it, expect } from 'vitest'
import { buildValueDistributionQuery, buildValueHistogramQuery } from './concept-queries'
import type { SchemaMapping } from '@/types/schema-mapping'

// A dictionary spans several event tables, and which one holds a given concept
// is a property of the DATA, not of the mapping. Reading only the first table
// that declares a valueColumn reported "0 non-null values" with empty min/max
// for every concept stored in another one — an OMOP measurement read from
// `observation` because that table happened to be declared first.

const MAPPING: SchemaMapping = {
  conceptTables: [{ key: 'omop', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    // Declared FIRST on purpose: the bug picked whichever came first.
    observation: {
      table: 'observation',
      conceptIdColumn: 'observation_concept_id',
      sourceConceptIdColumn: 'observation_source_concept_id',
      valueColumn: 'value_as_number',
    },
    measurement: {
      table: 'measurement',
      conceptIdColumn: 'measurement_concept_id',
      sourceConceptIdColumn: 'measurement_source_concept_id',
      valueColumn: 'value_as_number',
    },
  },
} as unknown as SchemaMapping

describe('buildValueDistributionQuery', () => {
  it('reads every event table of the dictionary, not just the first', () => {
    const sql = buildValueDistributionQuery(MAPPING, 'omop', 3024171)!
    expect(sql).toContain('FROM "observation"')
    expect(sql).toContain('FROM "measurement"')
    expect(sql).toContain('UNION ALL')
  })

  it('matches the concept on both the concept and source-concept columns', () => {
    const sql = buildValueDistributionQuery(MAPPING, 'omop', 3024171)!
    expect(sql).toContain('measurement_concept_id')
    expect(sql).toContain('measurement_source_concept_id')
  })

  it('aggregates over the union rather than one table', () => {
    const sql = buildValueDistributionQuery(MAPPING, 'omop', 3024171)!
    expect(sql).toContain('COUNT(v)::INTEGER AS non_null_count')
    expect(sql).toContain('FROM vals')
  })

  it('returns null when no event table records a value', () => {
    const noValues = {
      conceptTables: MAPPING.conceptTables,
      eventTables: {
        condition: { table: 'condition_occurrence', conceptIdColumn: 'condition_concept_id' },
      },
    } as unknown as SchemaMapping
    expect(buildValueDistributionQuery(noValues, 'omop', 1)).toBeNull()
  })

  it('still works when a single table declares a value column', () => {
    const one = {
      conceptTables: MAPPING.conceptTables,
      eventTables: { measurement: MAPPING.eventTables!.measurement },
    } as unknown as SchemaMapping
    const sql = buildValueDistributionQuery(one, 'omop', 3024171)!
    expect(sql).toContain('FROM "measurement"')
    expect(sql).not.toContain('UNION ALL')
  })
})

describe('buildValueHistogramQuery', () => {
  it('bins values from every event table of the dictionary', () => {
    const sql = buildValueHistogramQuery(MAPPING, 'omop', 3024171)!
    expect(sql).toContain('FROM "observation"')
    expect(sql).toContain('FROM "measurement"')
    expect(sql).toContain('UNION ALL')
  })

  it('clips to P1–P99 and reports what it dropped when excluding outliers', () => {
    const sql = buildValueHistogramQuery(MAPPING, 'omop', 3024171, 20, true)!
    expect(sql).toContain('QUANTILE_CONT(v, 0.01)')
    expect(sql).toContain('QUANTILE_CONT(v, 0.99)')
    expect(sql).toContain('excluded_count')
  })

  it('uses the true min/max when keeping outliers', () => {
    const sql = buildValueHistogramQuery(MAPPING, 'omop', 3024171, 20, false)!
    expect(sql).toContain('MIN(v) AS mn')
    expect(sql).toContain('MAX(v) AS mx')
    expect(sql).not.toContain('QUANTILE_CONT')
  })
})
