import { queryDataSource } from './engine'
import { buildSummary, checkStatus, type DqCheck, type DqCheckResult, type DqReport } from './data-quality-checks'

export * from './data-quality-checks'

// ---------------------------------------------------------------------------
// Check execution
// ---------------------------------------------------------------------------

async function runCheck(dataSourceId: string, check: DqCheck): Promise<DqCheckResult> {
  const start = performance.now()
  try {
    const rows = await queryDataSource(dataSourceId, check.sql)
    const elapsed = performance.now() - start

    if (!rows.length) {
      return {
        checkId: check.id,
        status: 'not_applicable',
        violatedRows: 0,
        totalRows: 0,
        pctViolated: 0,
        executionTimeMs: Math.round(elapsed),
        sql: check.sql,
      }
    }

    const violatedRows = Number(rows[0].violated_rows ?? 0)
    const totalRows = Number(rows[0].total_rows ?? 0)
    const pctViolated = totalRows > 0 ? (violatedRows / totalRows) * 100 : 0

    const status = checkStatus(violatedRows, totalRows, check.threshold)

    return {
      checkId: check.id,
      status,
      violatedRows,
      totalRows,
      pctViolated,
      executionTimeMs: Math.round(elapsed),
      sql: check.sql,
    }
  } catch (err) {
    return {
      checkId: check.id,
      status: 'error',
      violatedRows: 0,
      totalRows: 0,
      pctViolated: 0,
      executionTimeMs: Math.round(performance.now() - start),
      sql: check.sql,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
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

  return {
    dataSourceId,
    computedAt: new Date().toISOString(),
    checks,
    results,
    summary: buildSummary(checks, results),
  }
}
