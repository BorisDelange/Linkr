import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/server'
import type { DqCheckTemplate } from '@/lib/dq-templates'
import type { DqCustomCheck } from '@/types'
import {
  boundedQuery, checkTestProblem, evaluateRows, errorResult, formatCheckList, formatReport, groupChecks, groupKey,
  makeReport, missingTemplates, nextOrder, readCheck, resolveSubcategory, runRecord, runnableChecks, selectChecks,
  summarizeRows, unboundedExplore, validateCheckFields,
} from './dq'
import { registerDqTools } from './tools-dq'

const check = (over: Partial<DqCustomCheck>): DqCustomCheck => ({
  id: 'c1', ruleSetId: 'rs', name: 'Negative values', description: '', category: 'plausibility', subcategory: 'atemporal',
  severity: 'warning', threshold: 0, sql: 'SELECT 0 AS violated_rows, 1 AS total_rows', exploreSql: null, order: 0,
  origin: 'manual', templateKey: null, tableName: null, disabled: false, createdAt: '', updatedAt: '', ...over,
})

const CHECKS = [
  check({ id: 'nn', name: 'person.person_id not null', category: 'conformance', subcategory: 'relational', origin: 'ddl', tableName: 'person', order: 0, templateKey: 'ddl.not_null:person.person_id' }),
  check({ id: 'orph', name: 'linkr_visit orphans', category: 'conformance', subcategory: 'relational', origin: 'mapping', tableName: 'linkr_visit', order: 2 }),
  check({ id: 'pk', name: 'person primary key', category: 'conformance', subcategory: 'relational', origin: 'ddl', tableName: 'person', order: 1, disabled: true }),
  check({ id: 'man', name: 'Negative doses', order: 3 }),
]

describe('readCheck', () => {
  it('fills the fields older rows lack and maps the pre-Kahn categories', () => {
    const legacy = { ...check({}), category: 'validity', subcategory: undefined, origin: undefined, disabled: undefined } as unknown as DqCustomCheck
    expect(readCheck(legacy)).toMatchObject({ category: 'conformance', subcategory: 'value', origin: 'manual', disabled: false })
  })
})

describe('groups and filters', () => {
  it('groups by table in list order, ungrouped last', () => {
    expect(groupChecks(CHECKS).map((g) => [g.name, g.checks.map((c) => c.id)])).toEqual([
      ['person', ['nn', 'pk']], ['linkr_visit', ['orph']], ['', ['man']],
    ])
    expect(groupKey('Other checks')).toBe('')
    expect(groupKey(null)).toBe('')
  })

  it('filters by origin, group, state and reports unknown ids', () => {
    expect(selectChecks(CHECKS, { origins: ['ddl'] }).checks.map((c) => c.id)).toEqual(['nn', 'pk'])
    expect(selectChecks(CHECKS, { groups: ['PERSON'], state: 'enabled' }).checks.map((c) => c.id)).toEqual(['nn'])
    expect(selectChecks(CHECKS, { groups: ['Other checks'] }).checks.map((c) => c.id)).toEqual(['man'])
    expect(selectChecks(CHECKS, { checkIds: ['man', 'nope'] }).unknownIds).toEqual(['nope'])
  })

  it('runs the enabled checks only, in order', () => {
    expect(runnableChecks(CHECKS).map((c) => c.id)).toEqual(['nn', 'orph', 'man'])
    expect(nextOrder(CHECKS)).toBe(4)
  })

  it('lists checks under their group with the disabled count', () => {
    const out = formatCheckList(CHECKS)
    expect(out).toContain('person (1/2 enabled)')
    expect(out).toContain('person primary key (disabled)')
    expect(out).toContain('Other checks (1)')
  })
})

describe('validateCheckFields', () => {
  it('accepts a well-formed check', () => {
    expect(validateCheckFields({ name: 'x', category: 'conformance', subcategory: 'value', severity: 'error', threshold: 5, sql: 'SELECT 1 AS violated_rows, 2 AS total_rows' })).toEqual([])
  })

  it('refuses old categories, a foreign subcategory, bad threshold and SQL without the two columns', () => {
    expect(validateCheckFields({ name: ' ', category: 'validity', severity: 'fatal', threshold: 120, sql: 'SELECT 1' })).toHaveLength(5)
    expect(validateCheckFields({ name: 'x', category: 'completeness', subcategory: 'value', sql: 'SELECT 1 AS violated_rows, 1 AS total_rows' })[0]).toMatch(/no subcategory/)
  })

  it('checks only the given fields on an update, against the check\'s category', () => {
    const current = check({ category: 'plausibility' })
    expect(validateCheckFields({ threshold: 10 }, current)).toEqual([])
    expect(validateCheckFields({ subcategory: 'relational' }, current)).toHaveLength(1)
    expect(validateCheckFields({ sql: 'SELECT 1' }, current)).toHaveLength(1)
  })

  it('keeps a subcategory that fits, else takes the category\'s first — the editor\'s rule', () => {
    expect(resolveSubcategory('plausibility', undefined, 'temporal')).toBe('temporal')
    expect(resolveSubcategory('conformance', undefined, 'temporal')).toBe('value')
    expect(resolveSubcategory('completeness', undefined, 'temporal')).toBeNull()
    expect(resolveSubcategory('conformance', null, 'value')).toBeNull()
  })

  it('reads a test run as the Test button does', () => {
    expect(checkTestProblem([])).toMatch(/no row/)
    expect(checkTestProblem([{ violated_rows: 1 }])).toMatch(/total_rows/)
    expect(checkTestProblem([{ violated_rows: 1, total_rows: 3 }])).toBeNull()
  })
})

describe('a run', () => {
  const checks = runnableChecks([check({ id: 'a', threshold: 10 }), check({ id: 'b', order: 1, severity: 'error' }), check({ id: 'c', order: 2 }), check({ id: 'd', order: 3 })])
  const results = [
    evaluateRows(checks[0], [{ violated_rows: 5, total_rows: 10 }], 3),
    evaluateRows(checks[1], [{ violated_rows: 0, total_rows: 10 }], 2),
    evaluateRows(checks[2], [{ violated_rows: 0, total_rows: 0 }], 5),
    errorResult(checks[3], new Error('no table'), 1),
  ]
  const report = makeReport('db1', checks, results, '2026-01-01T00:00:00.000Z')

  it('evaluates like the page\'s runner', () => {
    expect(results.map((r) => r.status)).toEqual(['fail', 'pass', 'not_applicable', 'error'])
    expect(evaluateRows(checks[0], [], 0).status).toBe('not_applicable')
    expect(results[0].pctViolated).toBe(50)
  })

  it('records the run and the rule set\'s last run as the page does', () => {
    const { ruleSetChanges, entry } = runRecord('r1', { id: 'rs', dataSourceId: 'db1' }, report, '2026-01-01T00:00:01.000Z')
    // 1 passed out of 3 applicable (the not-applicable one is left out of the score).
    expect(entry).toMatchObject({ id: 'r1', ruleSetId: 'rs', dataSourceId: 'db1', status: 'success', totalChecks: 4, passed: 1, failed: 1, errors: 1, notApplicable: 1, durationMs: 11, score: 33 })
    expect(ruleSetChanges).toEqual({ status: 'error', lastRunAt: report.computedAt, lastRunDurationMs: 11, lastScore: 33 })
  })

  it('lists errors then failures', () => {
    const out = formatReport(report)
    expect(out).toContain('Score 33%')
    expect(out.indexOf('check_id d')).toBeLessThan(out.indexOf('check_id a'))
    expect(out).toContain('5/10 violated (50%, threshold 10%)')
    expect(out).not.toContain('check_id b')
  })
})

describe('schema checks', () => {
  const tpl = (templateKey: string): DqCheckTemplate => ({
    templateKey, origin: 'ddl', name: templateKey, description: '', category: 'conformance', subcategory: 'relational',
    severity: 'error', threshold: 0, tableName: 'person', sql: '', exploreSql: '',
  })
  it('offers only the templates the rule set does not hold', () => {
    const { missing, presentCount } = missingTemplates([tpl('ddl.not_null:person.person_id'), tpl('ddl.primary_key:person')], CHECKS)
    expect(missing.map((m) => m.templateKey)).toEqual(['ddl.primary_key:person'])
    expect(presentCount).toBe(1)
  })
})

describe('investigation', () => {
  it('rebounds the explore query', () => {
    expect(unboundedExplore('SELECT *\nFROM t\nWHERE x < 0\nLIMIT 100;')).toBe('SELECT *\nFROM t\nWHERE x < 0')
    expect(boundedQuery('SELECT * FROM t LIMIT 100', 5)).toBe('SELECT *\nFROM (\nSELECT * FROM t\n) AS dq_explore\nLIMIT 5')
  })

  it('summarises rows without echoing identifiers', () => {
    const out = summarizeRows([
      { person_id: 12345, unit: 'mg', value: 3, start: '2020-01-02' },
      { person_id: 67890, unit: null, value: -1, start: '2021-05-06' },
    ]).join('\n')
    expect(out).toContain('person_id: 2/2 filled · 2 distinct')
    expect(out).not.toContain('12345')
    expect(out).toContain('value: 2/2 filled · 2 distinct · min -1, max 3')
    expect(out).toContain('from 2020-01-02 to 2021-05-06')
    expect(out).toContain('unit: 1/2 filled')
  })
})

describe('registerDqTools', () => {
  it('registers every tool with a valid schema', () => {
    expect(() => registerDqTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})
