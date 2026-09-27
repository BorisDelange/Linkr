import { queryDataSource, discoverTables, schemaName } from './engine'
import type { SchemaMapping } from '@/types/schema-mapping'
import type { DqCustomCheck } from '@/types'
import {
  buildSummary, customCheckToDqCheck, dedupeChecks, errorResult, evaluateCheck, generateEmptyTableCheck,
  generateFieldNullRateChecks, generateSchemaChecks, type ColumnInfo, type DqCheck, type DqCheckResult, type DqReport,
} from './data-quality-checks'

export * from './data-quality-checks'

async function discoverColumns(dataSourceId: string, tableName: string): Promise<ColumnInfo[]> {
  const schema = schemaName(dataSourceId)
  // Match discoverTables: a source may be schema-based (`<schema>`) or ATTACHed as
  // a single file (`<schema>.main`). Match both so column discovery is stable
  // regardless of how/when the source was mounted.
  const rows = await queryDataSource(
    dataSourceId,
    `SELECT column_name, data_type, ordinal_position FROM information_schema.columns
     WHERE (table_schema = '${schema}' OR (table_catalog = '${schema}' AND table_schema = 'main'))
     AND table_name = '${tableName}' ORDER BY ordinal_position`,
  )
  return rows.map((r) => ({
    tableName,
    columnName: String(r.column_name),
    dataType: String(r.data_type),
    ordinalPosition: Number(r.ordinal_position),
  }))
}

// ---------------------------------------------------------------------------
// Check generation
// ---------------------------------------------------------------------------

export async function generateChecks(
  dataSourceId: string,
  schemaMapping?: SchemaMapping,
  customChecks?: DqCustomCheck[],
): Promise<DqCheck[]> {
  const tables = await discoverTables(dataSourceId)
  const checks: DqCheck[] = []

  // Universal checks for every table
  for (const tableName of tables) {
    checks.push(generateEmptyTableCheck(tableName))

    try {
      const columns = await discoverColumns(dataSourceId, tableName)
      checks.push(...generateFieldNullRateChecks(tableName, columns))
    } catch {
      // Column discovery can fail for some table types
    }
  }

  // Schema-aware checks
  if (schemaMapping && schemaMapping.presetId !== 'none') {
    checks.push(...generateSchemaChecks(schemaMapping, tables))
  }

  if (customChecks) checks.push(...customChecks.map(customCheckToDqCheck))

  return dedupeChecks(checks)
}

// ---------------------------------------------------------------------------
// Check execution
// ---------------------------------------------------------------------------

async function runCheck(dataSourceId: string, check: DqCheck): Promise<DqCheckResult> {
  const start = performance.now()
  try {
    const rows = await queryDataSource(dataSourceId, check.sql)
    return evaluateCheck(check, rows, Math.round(performance.now() - start))
  } catch (err) {
    return errorResult(check, err, Math.round(performance.now() - start))
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
