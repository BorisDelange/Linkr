import { describe, expect, it } from 'vitest'
import { IssueBag } from '../issue.js'
import { MemoryTree } from '../tree.js'
import { detectTreeKind, validateEntity } from './entities.js'
import { validateCohort } from './records.js'

const CHECK = {
  id: 'chk-1',
  name: 'Non-null person id',
  category: 'completeness',
  severity: 'error',
  threshold: 0.02,
  sql: 'SELECT COUNT(*) FROM person WHERE person_id IS NULL;',
  order: 0,
}

const ruleSet = (checks: unknown[] = [CHECK]) =>
  new MemoryTree({
    'rule-set.json': JSON.stringify({ name: { en: 'ICU DQ' } }),
    'checks.json': JSON.stringify(checks),
  })

const MAPPING = {
  sourceConceptCode: '220045',
  sourceConceptName: 'Heart Rate',
  targetConceptId: 3027018,
  status: 'approved',
}

const mappingProject = (mappings: unknown[] = [MAPPING]) =>
  new MemoryTree({
    'project.json': JSON.stringify({ name: { en: 'MIMIC → OMOP' } }),
    'mappings.json': JSON.stringify(mappings),
  })

describe('detectTreeKind', () => {
  it('tells a mapping project from a plain project', () => {
    // Both carry project.json; mappings.json is what discriminates. Getting this
    // backwards would validate one against the other's schema.
    expect(detectTreeKind(mappingProject())).toBe('mapping-project')
    expect(detectTreeKind(new MemoryTree({ 'project.json': '{}' }))).toBe('project')
  })

  it('identifies the record-based kinds', () => {
    expect(detectTreeKind(ruleSet())).toBe('dq-rule-set')
    expect(detectTreeKind(new MemoryTree({ 'catalog.json': '{}' }))).toBe('data-catalog')
  })
})

describe('dq rule set', () => {
  it('accepts a well-formed rule set', () => {
    expect(validateEntity(ruleSet(), 'dq-rule-set')).toEqual([])
  })

  it('accepts a rule set with no checks yet', () => {
    const tree = new MemoryTree({ 'rule-set.json': JSON.stringify({ name: { en: 'Empty' } }) })
    expect(validateEntity(tree, 'dq-rule-set')).toEqual([])
  })

  it('requires SQL — a check without it runs nothing', () => {
    const { sql: _sql, ...noSql } = CHECK
    const issues = validateEntity(ruleSet([noSql]), 'dq-rule-set')
    expect(issues.some((i) => i.code === 'missing-field')).toBe(true)
  })

  it('rejects an unknown severity', () => {
    const issues = validateEntity(ruleSet([{ ...CHECK, severity: 'critical' }]), 'dq-rule-set')
    const wrong = issues.find((i) => i.code === 'wrong-type')
    expect(wrong?.hint).toContain('warning')
  })

  it('flags duplicate check ids', () => {
    const issues = validateEntity(ruleSet([CHECK, CHECK]), 'dq-rule-set')
    expect(issues.some((i) => i.code === 'duplicate-key')).toBe(true)
  })
})

describe('mapping project', () => {
  it('accepts a well-formed mapping project', () => {
    expect(validateEntity(mappingProject(), 'mapping-project')).toEqual([])
  })

  it('requires a source concept code — the row identity', () => {
    const { sourceConceptCode: _c, ...noCode } = MAPPING
    const issues = validateEntity(mappingProject([noCode]), 'mapping-project')
    expect(issues.some((i) => i.code === 'missing-field')).toBe(true)
  })

  it('requires a target concept id on an APPROVED mapping', () => {
    const { targetConceptId: _t, ...noTarget } = MAPPING
    const issues = validateEntity(mappingProject([noTarget]), 'mapping-project')
    // Approved but mapping to nothing is the silent failure worth catching.
    expect(issues.some((i) => i.code === 'missing-field')).toBe(true)
  })

  it('allows a pending mapping with no target yet', () => {
    const { targetConceptId: _t, ...noTarget } = MAPPING
    expect(validateEntity(mappingProject([{ ...noTarget, status: 'pending' }]), 'mapping-project'))
      .toEqual([])
  })

  it('rejects an unknown status', () => {
    const issues = validateEntity(mappingProject([{ ...MAPPING, status: 'maybe' }]), 'mapping-project')
    expect(issues.some((i) => i.code === 'wrong-type')).toBe(true)
  })
})

describe('data catalog', () => {
  const catalog = (over: Record<string, unknown> = {}) =>
    new MemoryTree({
      'catalog.json': JSON.stringify({ name: { en: 'Catalog' }, dimensions: ['age'], ...over }),
    })

  it('accepts a well-formed catalog', () => {
    expect(validateEntity(catalog(), 'data-catalog')).toEqual([])
  })

  it('warns when it would compute nothing', () => {
    const issues = validateEntity(catalog({ dimensions: [] }), 'data-catalog')
    expect(issues.find((i) => i.code === 'empty-value')?.severity).toBe('warning')
  })

  it('requires a name', () => {
    const issues = validateEntity(new MemoryTree({ 'catalog.json': '{}' }), 'data-catalog')
    expect(issues.some((i) => i.code === 'missing-field')).toBe(true)
  })
})

describe('cohort', () => {
  const run = (cohort: unknown) => {
    const bag = new IssueBag()
    validateCohort(bag, 'cohorts/x.json', cohort)
    return bag.all()
  }

  it('accepts a cohort with criteria', () => {
    expect(run({
      name: { en: 'Adults' },
      level: 'patient',
      criteriaTree: { op: 'and', rules: [{ field: 'age', op: '>=', value: 18 }] },
    })).toEqual([])
  })

  it('accepts a cohort defined by custom SQL', () => {
    expect(run({ name: { en: 'Adults' }, customSql: 'SELECT person_id FROM person' })).toEqual([])
  })

  it('warns when it would select nobody', () => {
    // Imports fine, returns nothing — exactly the failure that is invisible in
    // the UI.
    const issues = run({ name: { en: 'Empty' }, criteriaTree: { op: 'and', rules: [] } })
    expect(issues.find((i) => i.code === 'empty-value')?.severity).toBe('warning')
  })

  it('rejects an unknown level', () => {
    const issues = run({ name: { en: 'X' }, level: 'episode', customSql: 'SELECT 1' })
    const wrong = issues.find((i) => i.code === 'wrong-type')
    expect(wrong?.hint).toContain('patient')
  })
})
