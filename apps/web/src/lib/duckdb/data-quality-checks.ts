/**
 * The part of data quality that needs no DuckDB engine: check and result types,
 * which stored checks run, pass/fail, the summary. The MCP server reuses it.
 */
import type { DqCheckGroup, DqCustomCheck, LocalizedString } from '@/types'
import { groupPath, type DqGroupStep } from '@/lib/dq-groups'
import { DQ_CATEGORIES, DQ_SEVERITIES, normalizeDqCheck, type DqCategory, type DqCheckOrigin, type DqSeverity, type DqSubcategory } from '@/lib/dq-taxonomy'
import { toLocalized } from '@/lib/localized'

export type { DqCategory, DqSeverity, DqSubcategory, DqCheckOrigin }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DqCheckStatus = 'pass' | 'fail' | 'error' | 'not_applicable'

/** A check as a run sees it: the stored check, without its bookkeeping. */
export interface DqCheck {
  id: string
  name: LocalizedString
  description: LocalizedString
  category: DqCategory
  subcategory: DqSubcategory | null
  severity: DqSeverity
  origin: DqCheckOrigin
  /** Its category and the ones above it, root first, named as at run time; empty: "Other checks". */
  groupPath: DqGroupStep[]
  /** Threshold: max % of violated rows allowed (0 = zero tolerance). */
  threshold: number
  /** SQL returning violated_rows (bigint) and total_rows (bigint). */
  sql: string
  /** Lists the violating rows; null when the check has none. */
  exploreSql: string | null
  /** Where the check comes from, set when a quality profile runs it: its
   *  rule set (name and version at run time) and its key there. */
  ruleSetId?: string
  ruleSetName?: string
  ruleSetVersion?: string
  checkKey?: string
}

export interface DqCheckResult {
  checkId: string
  status: DqCheckStatus
  violatedRows: number
  totalRows: number
  pctViolated: number
  executionTimeMs: number
  sql: string
  errorMessage?: string
}

export interface DqReportSummary {
  total: number
  passed: number
  failed: number
  errors: number
  notApplicable: number
  byCategory: Record<DqCategory, { total: number; passed: number; failed: number }>
  bySeverity: Record<DqSeverity, { total: number; passed: number; failed: number }>
}

export interface DqReport {
  dataSourceId: string
  computedAt: string
  checks: DqCheck[]
  results: DqCheckResult[]
  summary: DqReportSummary
}

/** What a finished run records: its score (passed / applicable checks, %) and
 *  the time its checks took. */
export function runOutcome(report: DqReport): { score: number; durationMs: number } {
  const applicable = report.summary.total - report.summary.notApplicable
  return {
    score: applicable > 0 ? Math.round((report.summary.passed / applicable) * 100) : 100,
    durationMs: report.results.reduce((sum, r) => sum + r.executionTimeMs, 0),
  }
}

/** A check's name or description as stored before checks were multilingual:
 *  a plain string, filed under English (its real language is unknown). */
export const readCheckText = (value: LocalizedString | string | null | undefined): LocalizedString =>
  toLocalized(value, ['en'])

/** A stored or imported check with every field filled: rows written before the
 *  Kahn categories, the generated checks, multilingual names and categories lack some. */
export function readStoredCheck(stored: DqCustomCheck): DqCustomCheck {
  const { tableName, ...check } = stored as DqCustomCheck & { tableName?: string | null }
  return normalizeDqCheck({
    ...check,
    name: readCheckText(check.name),
    description: readCheckText(check.description),
    subcategory: check.subcategory ?? null,
    exploreSql: check.exploreSql ?? null,
    origin: check.origin ?? 'manual',
    templateKey: check.templateKey ?? null,
    groupKey: check.groupKey ?? tableName ?? null,
    disabled: check.disabled ?? false,
  })
}

type LegacyCheck = Omit<DqCheck, 'name' | 'description' | 'groupPath'> & {
  name: LocalizedString | string
  description?: LocalizedString | string | null
  groupPath?: DqGroupStep[]
  /** Before categories: the one level a check was grouped by. */
  tableName?: string | null
}

/**
 * A recorded run's report as today's code reads it. A run snapshots its checks,
 * so the ones recorded earlier carry the shapes of their time: plain-text names,
 * a `tableName` for a category, the categories before the Kahn taxonomy.
 */
export function readStoredReport(raw: unknown): DqReport | null {
  if (!raw || typeof raw !== 'object') return null
  const past = raw as Omit<DqReport, 'checks'> & { checks: LegacyCheck[] }
  return {
    ...past,
    checks: past.checks.map(({ tableName, ...c }) => normalizeDqCheck({
      ...c,
      name: readCheckText(c.name),
      description: readCheckText(c.description),
      subcategory: c.subcategory ?? null,
      groupPath: c.groupPath ?? (tableName ? [{ key: tableName, name: { en: tableName } }] : []),
    })),
  }
}

/** The enabled checks of a rule set, in list order. */
export function runnableChecks(stored: DqCustomCheck[], groups: DqCheckGroup[]): DqCheck[] {
  return stored
    .filter((c) => !c.disabled)
    .sort((a, b) => a.order - b.order)
    .map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      category: c.category,
      subcategory: c.subcategory,
      severity: c.severity,
      origin: c.origin,
      groupPath: groupPath(groups, c.groupKey),
      threshold: c.threshold,
      sql: c.sql,
      exploreSql: usableExploreSql(c),
    }))
}

/** A check's listing query, or null when it has none — a blank one counts as none. */
export function usableExploreSql(check: { exploreSql?: string | null }): string | null {
  return check.exploreSql?.trim() ? check.exploreSql : null
}

/** Pass or fail for a count, the one rule the Test button and a run share. */
export function checkStatus(violatedRows: number, totalRows: number, threshold: number): DqCheckStatus {
  if (totalRows === 0) return 'not_applicable'
  if (threshold === 0) return violatedRows > 0 ? 'fail' : 'pass'
  return (violatedRows / totalRows) * 100 > threshold ? 'fail' : 'pass'
}

export function buildSummary(checks: DqCheck[], results: DqCheckResult[]): DqReportSummary {
  const byCategory = {} as Record<DqCategory, { total: number; passed: number; failed: number }>
  for (const c of DQ_CATEGORIES) byCategory[c] = { total: 0, passed: 0, failed: 0 }

  const bySeverity = {} as Record<DqSeverity, { total: number; passed: number; failed: number }>
  for (const s of DQ_SEVERITIES) bySeverity[s] = { total: 0, passed: 0, failed: 0 }

  let passed = 0
  let failed = 0
  let errors = 0
  let notApplicable = 0

  const checkMap = new Map(checks.map((c) => [c.id, c]))

  for (const r of results) {
    const check = checkMap.get(r.checkId)
    if (!check) continue

    byCategory[check.category].total++
    bySeverity[check.severity].total++

    switch (r.status) {
      case 'pass':
        passed++
        byCategory[check.category].passed++
        bySeverity[check.severity].passed++
        break
      case 'fail':
        failed++
        byCategory[check.category].failed++
        bySeverity[check.severity].failed++
        break
      case 'error':
        errors++
        break
      case 'not_applicable':
        notApplicable++
        break
    }
  }

  return {
    total: results.length,
    passed,
    failed,
    errors,
    notApplicable,
    byCategory,
    bySeverity,
  }
}
