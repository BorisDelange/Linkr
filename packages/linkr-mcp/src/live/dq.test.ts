import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/server'
import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import { evaluateCheck } from '@/lib/duckdb/data-quality-checks'
import type { DqCustomCheck } from '@/types'
import {
  buildChecks, checkTestProblem, formatCheckList, formatReport, makeReport, runEntry, selectChecks, validateCheckFields,
} from './dq'
import { registerDqTools } from './tools-dq'

const mapping = mappingV1ToV2({
  presetId: 'omop',
  presetLabel: { en: 'OMOP' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_start_datetime' },
  eventTables: { Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', dateColumn: 'measurement_datetime' } },
})

const TABLES = [
  { name: 'person', columns: [{ name: 'person_id' }, { name: 'year_of_birth' }] },
  { name: 'visit_occurrence', columns: [{ name: 'visit_occurrence_id' }] },
  { name: 'measurement', columns: [{ name: 'value_as_number' }] },
]

const custom = (over: Partial<DqCustomCheck>): DqCustomCheck => ({
  id: 'c1', ruleSetId: 'rs', name: 'Negative values', description: '', category: 'plausibility', severity: 'warning',
  threshold: 0, sql: 'SELECT 0 AS violated_rows, 1 AS total_rows', order: 0, createdAt: '', updatedAt: '', ...over,
})

describe('buildChecks', () => {
  it('generates the page\'s checks: builtin per table and column, schema ones, then custom by order', () => {
    const checks = buildChecks(TABLES, mapping, [custom({ id: 'c2', order: 1 }), custom({ id: 'c1', order: 0 })])
    const ids = checks.map((c) => c.id)
    expect(ids).toContain('builtin_empty_table_person')
    expect(ids).toContain('builtin_null_rate_person_year_of_birth')
    expect(ids).toContain('schema_table_exists_person')
    expect(ids).toContain('schema_relation_contract_linkr_visit')
    expect(ids.slice(-2)).toEqual(['c1', 'c2'])
  })

  it('has no schema checks without a mapping', () => {
    expect(buildChecks(TABLES, null, []).some((c) => c.source === 'schema')).toBe(false)
  })
})

describe('selectChecks', () => {
  const checks = buildChecks(TABLES, mapping, [custom({})])

  it('drops disabled checks and keeps the filtered ones', () => {
    const { checks: kept } = selectChecks(checks, { sources: ['custom'], disabledIds: [] })
    expect(kept.map((c) => c.id)).toEqual(['c1'])
    expect(selectChecks(checks, { sources: ['custom'], disabledIds: ['c1'] }).checks).toEqual([])
  })

  it('matches a table by bare or qualified name and reports unknown ids', () => {
    const { checks: kept, unknownIds } = selectChecks(checks, { tables: ['PERSON'], checkIds: ['builtin_empty_table_person', 'nope'] })
    expect(kept.map((c) => c.id)).toEqual(['builtin_empty_table_person'])
    expect(unknownIds).toEqual(['nope'])
  })
})

describe('validateCheckFields', () => {
  it('accepts a well-formed check', () => {
    expect(validateCheckFields({ name: 'x', category: 'validity', severity: 'error', threshold: 5, sql: 'SELECT 1 AS violated_rows, 2 AS total_rows' })).toEqual([])
  })

  it('refuses bad enums, thresholds and SQL without the two columns', () => {
    const errors = validateCheckFields({ name: ' ', category: 'speed', severity: 'fatal', threshold: 120, sql: 'SELECT 1' })
    expect(errors).toHaveLength(5)
  })

  it('checks only the given fields on an update', () => {
    expect(validateCheckFields({ threshold: 10 }, true)).toEqual([])
    expect(validateCheckFields({ sql: 'SELECT 1' }, true)).toHaveLength(1)
  })

  it('reads a test run', () => {
    expect(checkTestProblem([])).toMatch(/no row/)
    expect(checkTestProblem([{ violated_rows: 1 }])).toMatch(/total_rows/)
    expect(checkTestProblem([{ VIOLATED_ROWS: 1, total_rows: 3 }])).toBeNull()
  })
})

describe('report', () => {
  const all = buildChecks(TABLES, mapping, [custom({ threshold: 10 })])
  const byId = (id: string) => all.find((c) => c.id === id)!
  const checks = [byId('c1'), byId('builtin_empty_table_person'), byId('schema_table_exists_person')]
  const results = [
    evaluateCheck(checks[0], [{ violated_rows: 1, total_rows: 1 }], 3),
    evaluateCheck(checks[1], [{ violated_rows: 0, total_rows: 1 }], 2),
    evaluateCheck(checks[2], [{ violated_rows: 0, total_rows: 1 }], 5),
  ]
  const report = makeReport('db1', checks, results, '2026-01-01T00:00:00.000Z')

  it('records the run as the page does', () => {
    const entry = runEntry('r1', 'rs', report, '2026-01-01T00:00:01.000Z')
    expect(entry).toMatchObject({ status: 'success', totalChecks: 3, passed: 2, failed: 1, durationMs: 10, score: 67 })
  })

  it('lists failures with their counts', () => {
    const out = formatReport(report)
    expect(out).toContain('Score 67%')
    expect(out).toContain('1/1 violated')
    expect(out).toContain('id c1')
    expect(out).not.toContain('id builtin_empty_table_person')
  })

  it('summarises NULL-rate checks per table', () => {
    const out = formatCheckList(buildChecks(TABLES, null, []), new Set())
    expect(out).toContain('person 2')
    expect(out).not.toContain('builtin_null_rate_person_person_id')
  })
})

describe('registerDqTools', () => {
  it('registers every tool with a valid schema', () => {
    expect(() => registerDqTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})
