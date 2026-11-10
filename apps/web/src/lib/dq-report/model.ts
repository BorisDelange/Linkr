/**
 * Everything a quality report shows, shaped once from a recorded run in the
 * reader's language — the HTML, PDF and Word renderers only lay it out. A run
 * snapshots its checks (names, groups, rule set versions), so a report of a
 * past run reads as that run was, whatever the rule sets became since.
 */
import type { TFunction } from 'i18next'
import { localized } from '@/lib/localized'
import { DQ_SEVERITIES } from '@/lib/dq-taxonomy'
import type { DqCheckStatus, DqReport } from '@/lib/duckdb/data-quality-checks'
import {
  groupPathLabel, isProblem, resultRows, resultTree, scoreOf, tallyByCategory, tallyBySeverity, tallyOf,
  type DqResultNode, type DqTally,
} from './tally'

export interface DqReportCheck {
  name: string
  /** Its group path, `A › B`; empty when filed under none. */
  group: string
  ruleSet: string | null
  description: string
  status: DqCheckStatus
  statusLabel: string
  severityLabel: string
  dimensionLabel: string
  /** Share of violating rows, formatted; null when nothing was counted. */
  violated: string | null
  threshold: string
  /** `violated / total` rows, formatted; null when nothing was counted. */
  rows: string | null
  error: string | null
  sql: string | null
}

export interface DqReportModel {
  title: string
  description: string
  version: string | null
  databaseName: string
  /** When the run was computed. */
  runAt: string
  generatedAt: string
  locale: string
  durationMs: number
  score: number | null
  tally: DqTally
  ruleSets: { name: string; version: string; checks: number }[]
  byDimension: { label: string; tally: DqTally }[]
  bySeverity: { label: string; tally: DqTally }[]
  /** The group tree flattened, top first; `depth` indents it. */
  groups: { label: string; depth: number; kind: DqResultNode['kind']; tally: DqTally }[]
  /** The checks detailed: failures and errors first, then (when asked) the others. */
  checks: DqReportCheck[]
  includePassed: boolean
  includeSql: boolean
}

export interface DqReportOptions {
  title: string
  description?: string
  version?: string | null
  databaseName: string
  t: TFunction
  locale: string
  includePassed: boolean
  includeSql: boolean
  /** Defaults to now. */
  generatedAt?: string
}

const SEVERITY_RANK = Object.fromEntries(DQ_SEVERITIES.map((s, i) => [s, i])) as Record<string, number>

export function shapeDqReportModel(report: DqReport, opts: DqReportOptions): DqReportModel {
  const { t, locale } = opts
  const lang = locale.slice(0, 2)
  const rows = resultRows(report.checks, report.results)
  const tally = tallyOf(rows)
  const percent = (value: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(value / 100)
  const count = (n: number) => n.toLocaleString(locale)

  const ruleSets: DqReportModel['ruleSets'] = []
  for (const { check } of rows) {
    if (!check.ruleSetName) continue
    const version = check.ruleSetVersion ?? ''
    const entry = ruleSets.find((r) => r.name === check.ruleSetName && r.version === version)
    if (entry) entry.checks++
    else ruleSets.push({ name: check.ruleSetName, version, checks: 1 })
  }

  const groups: DqReportModel['groups'] = []
  const flatten = (nodes: DqResultNode[], depth: number) => {
    for (const n of nodes) {
      groups.push({ label: n.kind === 'other' ? t('data_quality.group_other') : n.label, depth, kind: n.kind, tally: n.tally })
      flatten(n.children, depth + 1)
    }
  }
  flatten(resultTree(rows, lang), 0)

  const detailed = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => opts.includePassed || isProblem(row.result.status))
    .sort((a, b) => Number(isProblem(b.row.result.status)) - Number(isProblem(a.row.result.status))
      || SEVERITY_RANK[a.row.check.severity] - SEVERITY_RANK[b.row.check.severity]
      || a.i - b.i)

  const checks = detailed.map(({ row: { check, result } }): DqReportCheck => {
    const counted = result.status !== 'not_applicable' && result.status !== 'error'
    return {
      name: localized(check.name, lang),
      group: groupPathLabel(check, lang),
      ruleSet: check.ruleSetName ?? null,
      description: localized(check.description, lang),
      status: result.status,
      statusLabel: t(`data_quality.status_${result.status}`),
      severityLabel: t(`data_quality.severity_${check.severity}`),
      dimensionLabel: t(`data_quality.category_${check.category}`),
      violated: counted ? percent(result.pctViolated) : null,
      threshold: percent(check.threshold),
      rows: counted ? `${count(result.violatedRows)} / ${count(result.totalRows)}` : null,
      error: result.errorMessage ?? null,
      sql: opts.includeSql ? result.sql.trim() : null,
    }
  })

  return {
    title: opts.title,
    description: opts.description ?? '',
    version: opts.version ?? null,
    databaseName: opts.databaseName,
    runAt: report.computedAt,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    locale,
    durationMs: report.results.reduce((sum, r) => sum + r.executionTimeMs, 0),
    score: scoreOf(tally),
    tally,
    ruleSets,
    byDimension: tallyByCategory(rows).map(({ key, tally: tl }) => ({ label: t(`data_quality.category_${key}`), tally: tl })),
    bySeverity: tallyBySeverity(rows).map(({ key, tally: tl }) => ({ label: t(`data_quality.severity_${key}`), tally: tl })),
    groups,
    checks,
    includePassed: opts.includePassed,
    includeSql: opts.includeSql,
  }
}
