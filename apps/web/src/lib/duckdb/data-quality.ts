import { queryDataSource } from './engine'
import { buildSummary, checkStatus, type DqCheck, type DqCheckResult, type DqReport } from './data-quality-checks'

export * from './data-quality-checks'

// ---------------------------------------------------------------------------
// Check execution
// ---------------------------------------------------------------------------

/** A check's verdict from its query's rows, or from the error it failed with. */
export function checkResult(check: DqCheck, rows: readonly Record<string, unknown>[], executionTimeMs: number, error: string | null = null): DqCheckResult {
  const base = { checkId: check.id, executionTimeMs: Math.round(executionTimeMs), sql: check.sql }
  if (error != null) {
    return { ...base, status: 'error', violatedRows: 0, totalRows: 0, pctViolated: 0, errorMessage: error }
  }
  if (!rows.length) {
    return { ...base, status: 'not_applicable', violatedRows: 0, totalRows: 0, pctViolated: 0 }
  }
  const violatedRows = Number(rows[0].violated_rows ?? 0)
  const totalRows = Number(rows[0].total_rows ?? 0)
  const pctViolated = totalRows > 0 ? (violatedRows / totalRows) * 100 : 0
  return { ...base, status: checkStatus(violatedRows, totalRows, check.threshold), violatedRows, totalRows, pctViolated }
}

export function checkReport(dataSourceId: string, checks: DqCheck[], results: DqCheckResult[]): DqReport {
  return {
    dataSourceId,
    computedAt: new Date().toISOString(),
    checks,
    results,
    summary: buildSummary(checks, results),
  }
}

/** A check's query: the app's own checks may run on an external database, a hand-written one never. */
export const checkPushdown = (check: DqCheck) => check.origin !== 'manual'

async function runCheck(dataSourceId: string, check: DqCheck): Promise<DqCheckResult> {
  const start = performance.now()
  try {
    const rows = await queryDataSource(dataSourceId, check.sql, { pushdown: checkPushdown(check) })
    return checkResult(check, rows, performance.now() - start)
  } catch (err) {
    return checkResult(check, [], performance.now() - start, err instanceof Error ? err.message : String(err))
  }
}

export async function runAllChecks(
  dataSourceId: string,
  checks: DqCheck[],
  onProgress?: (completed: number, total: number) => void,
): Promise<DqReport> {
  const results: DqCheckResult[] = []

  for (let i = 0; i < checks.length; i++) {
    const result = await runCheck(dataSourceId, checks[i])
    results.push(result)
    onProgress?.(i + 1, checks.length)
  }

  return checkReport(dataSourceId, checks, results)
}
