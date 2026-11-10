import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import type { DqCheck, DqCheckResult, DqCheckStatus, DqReport } from '@/lib/duckdb/data-quality-checks'
import { buildSummary } from '@/lib/duckdb/data-quality-checks'
import { statusBars } from './charts'
import { shapeDqReportModel } from './model'
import { renderDqReportHtml } from './render-html'
import { failuresFirst, pruneTree, resultRows, resultTree, scoreOf, tallyOf } from './tally'

const t = ((key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key)) as unknown as TFunction

function check(id: string, over: Partial<DqCheck> = {}): DqCheck {
  return {
    id,
    name: { en: `Check ${id}`, fr: `Contrôle ${id}` },
    description: { en: `About ${id}` },
    category: 'completeness',
    subcategory: null,
    severity: 'error',
    origin: 'manual',
    groupPath: [],
    threshold: 0,
    sql: `SELECT ${id}`,
    exploreSql: null,
    ...over,
  }
}

function result(checkId: string, status: DqCheckStatus, pct = 0): DqCheckResult {
  return {
    checkId, status, pctViolated: pct, violatedRows: pct, totalRows: status === 'not_applicable' ? 0 : 100,
    executionTimeMs: 10, sql: `SELECT ${checkId}`, ...(status === 'error' ? { errorMessage: 'boom' } : {}),
  }
}

const labs = { key: 'labs', name: { en: 'Labs', fr: 'Biologie' } }
const kidney = { key: 'kidney', name: { en: 'Kidney', fr: 'Rein' } }

function report(entries: [DqCheck, DqCheckStatus, number?][]): DqReport {
  const checks = entries.map(([c]) => c)
  const results = entries.map(([c, s, p]) => result(c.id, s, p))
  return { dataSourceId: 'db', computedAt: '2026-11-10T09:30:00.000Z', checks, results, summary: buildSummary(checks, results) }
}

describe('tally', () => {
  it('scores passed out of applicable checks, none applicable giving null', () => {
    const r = report([[check('a'), 'pass'], [check('b'), 'fail', 5], [check('c'), 'not_applicable'], [check('d'), 'error']])
    const tally = tallyOf(resultRows(r.checks, r.results))
    expect(tally).toEqual({ total: 4, passed: 1, failed: 1, errors: 1, notApplicable: 1 })
    expect(scoreOf(tally)).toBe(33)
    expect(scoreOf({ total: 1, passed: 0, failed: 0, errors: 0, notApplicable: 1 })).toBeNull()
  })
})

describe('resultTree', () => {
  const r = report([
    [check('a', { groupPath: [labs] }), 'pass'],
    [check('b', { groupPath: [labs, kidney] }), 'fail', 12],
    [check('c'), 'pass'],
    [check('d', { groupPath: [labs, kidney] }), 'error'],
  ])
  const rows = resultRows(r.checks, r.results)

  it('nests groups by path, counts everything under a node, other checks last', () => {
    const tree = resultTree(rows, 'fr')
    expect(tree.map((n) => [n.kind, n.label])).toEqual([['group', 'Biologie'], ['other', '']])
    const [labsNode] = tree
    expect(labsNode.tally).toMatchObject({ total: 3, passed: 1, failed: 1, errors: 1 })
    expect(labsNode.rows.map((x) => x.check.id)).toEqual(['a'])
    expect(labsNode.children[0]).toMatchObject({ label: 'Rein', tally: { total: 2 } })
  })

  it('puts each rule set on top when a run spans several', () => {
    const multi = resultRows(
      [check('a', { ruleSetId: 'r1', ruleSetName: 'One', groupPath: [labs] }), check('b', { ruleSetId: 'r2', ruleSetName: 'Two', groupPath: [labs] })],
      [result('a', 'pass'), result('b', 'pass')],
    )
    const tree = resultTree(multi, 'en')
    expect(tree.map((n) => [n.kind, n.label])).toEqual([['ruleSet', 'One'], ['ruleSet', 'Two']])
    // The same group key in two rule sets stays two nodes.
    expect(new Set(tree.map((n) => n.children[0].key)).size).toBe(2)
  })

  it('sorts failures first, keeps other checks last, and prunes without changing counts', () => {
    const r2 = report([
      [check('x', { groupPath: [{ key: 'ok', name: { en: 'OK' } }] }), 'pass'],
      [check('y'), 'fail', 3],
      [check('z', { groupPath: [labs] }), 'fail', 3],
    ])
    const sorted = failuresFirst(resultTree(resultRows(r2.checks, r2.results), 'en'))
    expect(sorted.map((n) => n.label || n.kind)).toEqual(['Labs', 'OK', 'other'])
    const pruned = pruneTree(sorted, (row) => row.result.status === 'fail')
    expect(pruned.map((n) => n.label || n.kind)).toEqual(['Labs', 'other'])
    expect(pruned[0].tally.total).toBe(1)
  })
})

describe('shapeDqReportModel', () => {
  const r = report([
    [check('a', { groupPath: [labs], ruleSetName: 'Core', ruleSetVersion: '1.2.0', severity: 'notice' }), 'fail', 2.5],
    [check('b', { groupPath: [labs, kidney], ruleSetName: 'Core', ruleSetVersion: '1.2.0' }), 'pass'],
    [check('c', { ruleSetName: 'Core', ruleSetVersion: '1.2.0', severity: 'warning' }), 'error'],
  ])
  const base = { title: 'ICU profile', databaseName: 'MIMIC demo', t, locale: 'en', includeSql: false, generatedAt: '2026-11-10T10:00:00.000Z' }

  it('details only failures and errors by default, errors and severe first', () => {
    const model = shapeDqReportModel(r, { ...base, includePassed: false })
    expect(model.checks.map((c) => c.name)).toEqual(['Check c', 'Check a'])
    expect(model.checks[1]).toMatchObject({ group: 'Labs', violated: '2.5%', threshold: '0%', rows: '2.5 / 100', sql: null })
    expect(model.checks[0]).toMatchObject({ violated: null, error: 'boom' })
    expect(model.score).toBe(33)
    expect(model.ruleSets).toEqual([{ name: 'Core', version: '1.2.0', checks: 3 }])
    expect(model.groups.map((g) => [g.depth, g.label])).toEqual([[0, 'Labs'], [1, 'Kidney'], [0, 'data_quality.group_other']])
  })

  it('names checks in the report language and includes passed checks and SQL when asked', () => {
    const model = shapeDqReportModel(r, { ...base, locale: 'fr-FR', includePassed: true, includeSql: true })
    expect(model.checks.map((c) => c.name)).toEqual(['Contrôle c', 'Contrôle a', 'Contrôle b'])
    expect(model.checks[2].group).toBe('Biologie › Rein')
    expect(model.checks[2].sql).toBe('SELECT b')
  })

  it('renders a self-contained page that escapes what it is given', () => {
    const model = shapeDqReportModel(r, { ...base, title: '<b>ICU</b>', includePassed: false })
    const html = renderDqReportHtml(model, t)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('&lt;b&gt;ICU&lt;/b&gt;')
    expect(html).not.toMatch(/<script|https?:\/\/(?!linkr\.interhop\.org|www\.w3\.org)/)
  })
})

describe('statusBars', () => {
  it('draws one bar per row with its score, an empty row reading a dash', () => {
    const svg = statusBars(
      [{ label: 'A', tally: { total: 2, passed: 1, failed: 1, errors: 0, notApplicable: 0 } }, { label: 'B', tally: { total: 0, passed: 0, failed: 0, errors: 0, notApplicable: 0 } }],
      { title: 'T', statusLabel: (s) => s },
    )
    expect(svg).toContain('>50%<')
    expect(svg).toContain('>—<')
  })
})
