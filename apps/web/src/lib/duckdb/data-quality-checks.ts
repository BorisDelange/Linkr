/**
 * The part of data quality that needs no DuckDB engine: check and result types,
 * which stored checks run, pass/fail, the summary. The MCP server reuses it.
 */
import type { DqCustomCheck } from '@/types'
import { DQ_CATEGORIES, DQ_SEVERITIES, type DqCategory, type DqCheckOrigin, type DqSeverity, type DqSubcategory } from '@/lib/dq-taxonomy'

export type { DqCategory, DqSeverity, DqSubcategory, DqCheckOrigin }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DqCheckStatus = 'pass' | 'fail' | 'error' | 'not_applicable'

/** A check as a run sees it: the stored check, without its bookkeeping. */
export interface DqCheck {
  id: string
  name: string
  description: string
  category: DqCategory
  subcategory: DqSubcategory | null
  severity: DqSeverity
  origin: DqCheckOrigin
  tableName: string | null
  /** Threshold: max % of violated rows allowed (0 = zero tolerance). */
  threshold: number
  /** SQL returning violated_rows (bigint) and total_rows (bigint). */
  sql: string
  /** Lists the violating rows; null when the check has none. */
  exploreSql: string | null
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

/** The enabled checks of a rule set, in list order. */
export function runnableChecks(stored: DqCustomCheck[]): DqCheck[] {
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
      tableName: c.tableName,
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
