import { queryDataSource, discoverTables, schemaName } from './engine'
import type { SchemaMapping } from '@/types/schema-mapping'
import type { DqCustomCheck } from '@/types'
import { qualify, tableListHas } from '@/lib/schema-helpers'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DqCategory = 'completeness' | 'validity' | 'uniqueness' | 'consistency' | 'plausibility'
export type DqSeverity = 'error' | 'warning' | 'notice'
export type DqCheckLevel = 'table' | 'field'
export type DqCheckSource = 'builtin' | 'schema' | 'custom'
export type DqCheckStatus = 'pass' | 'fail' | 'error' | 'not_applicable'

export interface DqCheck {
  id: string
  name: string
  description: string
  category: DqCategory
  severity: DqSeverity
  level: DqCheckLevel
  source: DqCheckSource
  tableName?: string
  fieldName?: string
  /** Threshold: max % of violated rows allowed (0 = zero tolerance). */
  threshold: number
  /** SQL returning violated_rows (bigint) and total_rows (bigint). */
  sql: string
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

// ---------------------------------------------------------------------------
// SQL template helpers
// ---------------------------------------------------------------------------

/** Wrap a query to produce violated_rows + total_rows. */
function wrapCountSql(violationWhere: string, table: string): string {
  return `
    SELECT
      COUNT(*) FILTER (WHERE ${violationWhere})::BIGINT AS violated_rows,
      COUNT(*)::BIGINT AS total_rows
    FROM "${table}"
  `
}

// ---------------------------------------------------------------------------
// Universal checks (no schema mapping needed)
// ---------------------------------------------------------------------------

interface ColumnInfo {
  tableName: string
  columnName: string
  dataType: string
  ordinalPosition: number
}

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

function generateEmptyTableCheck(tableName: string): DqCheck {
  return {
    id: `builtin_empty_table_${tableName}`,
    name: 'emptyTable',
    description: `Table "${tableName}" has no rows`,
    category: 'completeness',
    severity: 'warning',
    level: 'table',
    source: 'builtin',
    tableName,
    threshold: 0,
    // If 0 rows, the table is "violated"; total=1 so we get 100% violated
    sql: `SELECT CASE WHEN cnt = 0 THEN 1 ELSE 0 END AS violated_rows, 1 AS total_rows FROM (SELECT COUNT(*)::BIGINT AS cnt FROM "${tableName}") sub`,
  }
}

function generateFieldNullRateChecks(tableName: string, columns: ColumnInfo[]): DqCheck[] {
  return columns.map((col) => ({
    id: `builtin_null_rate_${tableName}_${col.columnName}`,
    name: 'fieldNullRate',
    description: `NULL rate for "${tableName}"."${col.columnName}"`,
    category: 'completeness' as DqCategory,
    severity: 'notice' as DqSeverity,
    level: 'field' as DqCheckLevel,
    source: 'builtin' as DqCheckSource,
    tableName,
    fieldName: col.columnName,
    threshold: 100, // Informational — always passes; user sees the %
    sql: `SELECT (COUNT(*) - COUNT("${col.columnName}"))::BIGINT AS violated_rows, COUNT(*)::BIGINT AS total_rows FROM "${tableName}"`,
  }))
}

// ---------------------------------------------------------------------------
// Schema-aware checks
// ---------------------------------------------------------------------------

function generateSchemaChecks(
  mapping: SchemaMapping,
  discovered: readonly string[],
): DqCheck[] {
  // Matched through `tableListHas`: discovery reports qualified names
  // (`hosp.patients`) for a source with schemas, while a mapping keeps the schema
  // and the table apart. Comparing bare names silently skipped every schema check
  // on MIMIC-IV — each one reported its table as missing.
  const has = (ref: { schema?: string; table: string } | undefined) =>
    !!ref && tableListHas(discovered, ref)
  const checks: DqCheck[] = []

  // --- Validity: table exists ---
  const mappedTables: { role: string; ref: { schema?: string; table: string } }[] = []
  if (mapping.patientTable) mappedTables.push({ role: 'patient', ref: mapping.patientTable })
  if (mapping.visitTable) mappedTables.push({ role: 'visit', ref: mapping.visitTable })
  if (mapping.noteTable) mappedTables.push({ role: 'note', ref: mapping.noteTable })
  if (mapping.visitDetailTable) mappedTables.push({ role: 'visitDetail', ref: mapping.visitDetailTable })
  if (mapping.eventTables) {
    for (const [label, et] of Object.entries(mapping.eventTables)) {
      mappedTables.push({ role: `event:${label}`, ref: et })
    }
  }
  if (mapping.conceptTables) {
    for (const ct of mapping.conceptTables) {
      mappedTables.push({ role: `concept:${ct.key}`, ref: ct })
    }
  }

  for (const { role, ref } of mappedTables) {
    const table = ref.table
    const exists = has(ref)
    checks.push({
      id: `schema_table_exists_${table}`,
      name: 'tableExists',
      description: `Mapped table "${table}" (${role}) exists in database`,
      category: 'validity',
      severity: 'error',
      level: 'table',
      source: 'schema',
      tableName: table,
      threshold: 0,
      // If table doesn't exist, we can't query it — handle in executor
      sql: exists
        ? `SELECT 0::BIGINT AS violated_rows, 1::BIGINT AS total_rows`
        : `SELECT 1::BIGINT AS violated_rows, 1::BIGINT AS total_rows`,
    })
  }

  const pt = mapping.patientTable
  const vt = mapping.visitTable

  // --- Consistency: orphan visits (visit.patientId not in patient.id) ---
  if (pt && vt && has(pt) && has(vt)) {
    checks.push({
      id: `schema_orphan_visits_${vt.table}`,
      name: 'orphanRecords',
      description: `Visits in ${qualify(vt)} referencing non-existent patients`,
      category: 'consistency',
      severity: 'error',
      level: 'table',
      source: 'schema',
      tableName: vt.table,
      threshold: 0,
      sql: `
        SELECT COUNT(*)::BIGINT AS violated_rows,
               (SELECT COUNT(*)::BIGINT FROM ${qualify(vt)}) AS total_rows
        FROM ${qualify(vt)} v
        LEFT JOIN ${qualify(pt)} p ON v."${vt.patientIdColumn}" = p."${pt.idColumn}"
        WHERE p."${pt.idColumn}" IS NULL
      `,
    })

    // --- Plausibility: temporal order (visit start ≤ end) ---
    if (vt.endDateColumn) {
      checks.push({
        id: `schema_temporal_order_${vt.table}`,
        name: 'temporalOrder',
        description: `Visit start date ≤ end date in ${qualify(vt)}`,
        category: 'plausibility',
        severity: 'warning',
        level: 'table',
        source: 'schema',
        tableName: vt.table,
        threshold: 0,
        sql: wrapCountSql(
          `"${vt.startDateColumn}" IS NOT NULL AND "${vt.endDateColumn}" IS NOT NULL AND "${vt.startDateColumn}"::TIMESTAMP > "${vt.endDateColumn}"::TIMESTAMP`,
          vt.table,
        ),
      })
    }

    // --- Plausibility: plausible age (0–130) ---
    const birthExpr = pt.birthDateColumn
      ? `EXTRACT(YEAR FROM AGE(v."${vt.startDateColumn}"::TIMESTAMP, p."${pt.birthDateColumn}"::TIMESTAMP))`
      : pt.birthYearColumn
        ? `EXTRACT(YEAR FROM v."${vt.startDateColumn}"::TIMESTAMP) - p."${pt.birthYearColumn}"`
        : null

    if (birthExpr) {
      checks.push({
        id: `schema_plausible_age_${pt.table}`,
        name: 'plausibleAge',
        description: `Patient age at visit between 0 and 130`,
        category: 'plausibility',
        severity: 'error',
        level: 'table',
        source: 'schema',
        tableName: vt.table,
        threshold: 0,
        sql: `
          SELECT COUNT(*)::BIGINT AS violated_rows,
                 (SELECT COUNT(*)::BIGINT FROM ${qualify(vt)}) AS total_rows
          FROM ${qualify(vt)} v
          JOIN ${qualify(pt)} p ON v."${vt.patientIdColumn}" = p."${pt.idColumn}"
          WHERE v."${vt.startDateColumn}" IS NOT NULL
            AND (${birthExpr} < 0 OR ${birthExpr} > 130)
        `,
      })
    }
  }

  // --- Consistency: orphan events (event.patientId not in patient.id) ---
  if (pt && mapping.eventTables && has(pt)) {
    for (const [label, et] of Object.entries(mapping.eventTables)) {
      if (!has(et)) continue
      const patCol = et.patientIdColumn ?? pt.idColumn
      checks.push({
        id: `schema_orphan_events_${et.table}`,
        name: 'orphanRecords',
        description: `Records in ${qualify(et)} (${label}) referencing non-existent patients`,
        category: 'consistency',
        severity: 'error',
        level: 'table',
        source: 'schema',
        tableName: et.table,
        threshold: 0,
        sql: `
          SELECT COUNT(*)::BIGINT AS violated_rows,
                 (SELECT COUNT(*)::BIGINT FROM ${qualify(et)}) AS total_rows
          FROM ${qualify(et)} e
          LEFT JOIN ${qualify(pt)} p ON e."${patCol}" = p."${pt.idColumn}"
          WHERE p."${pt.idColumn}" IS NULL
        `,
      })
    }
  }

  // --- Plausibility: events after birth ---
  if (pt && mapping.eventTables && has(pt)) {
    const birthCol = pt.birthDateColumn ?? pt.birthYearColumn
    if (birthCol) {
      for (const [label, et] of Object.entries(mapping.eventTables)) {
        if (!has(et) || !et.dateColumn) continue
        const patCol = et.patientIdColumn ?? pt.idColumn

        const birthCheck = pt.birthDateColumn
          ? `e."${et.dateColumn}"::TIMESTAMP < p."${pt.birthDateColumn}"::TIMESTAMP`
          : `EXTRACT(YEAR FROM e."${et.dateColumn}"::TIMESTAMP) < p."${pt.birthYearColumn}"`

        checks.push({
          id: `schema_event_after_birth_${et.table}`,
          name: 'eventAfterBirth',
          description: `Events in ${qualify(et)} (${label}) occur after patient birth`,
          category: 'plausibility',
          severity: 'error',
          level: 'table',
          source: 'schema',
          tableName: et.table,
          threshold: 0,
          sql: `
            SELECT COUNT(*)::BIGINT AS violated_rows,
                   (SELECT COUNT(*)::BIGINT FROM ${qualify(et)}) AS total_rows
            FROM ${qualify(et)} e
            JOIN ${qualify(pt)} p ON e."${patCol}" = p."${pt.idColumn}"
            WHERE e."${et.dateColumn}" IS NOT NULL
              AND ${birthCheck}
          `,
        })
      }
    }
  }

  // --- Completeness: patient coverage per event table ---
  if (pt && mapping.eventTables && has(pt)) {
    for (const [label, et] of Object.entries(mapping.eventTables)) {
      if (!has(et)) continue
      const patCol = et.patientIdColumn ?? pt.idColumn
      checks.push({
        id: `schema_patient_coverage_${et.table}`,
        name: 'patientCoverage',
        description: `% of patients with ≥1 record in ${qualify(et)} (${label})`,
        category: 'completeness',
        severity: 'notice',
        level: 'table',
        source: 'schema',
        tableName: et.table,
        threshold: 100, // Informational — always passes, user sees the %
        sql: `
          SELECT
            (total_patients - patients_with_records)::BIGINT AS violated_rows,
            total_patients::BIGINT AS total_rows
          FROM (
            SELECT
              (SELECT COUNT(*) FROM ${qualify(pt)}) AS total_patients,
              COUNT(DISTINCT e."${patCol}") AS patients_with_records
            FROM ${qualify(et)} e
          ) sub
        `,
      })
    }
  }

  // TODO(data-quality): visit ↔ event foreign-key integrity. Every OMOP clinical
  // table carries visit_occurrence_id, but the mapping does not record which
  // column holds it, so the check needs column discovery on each event table
  // before it can be generated.

  return checks
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

  // Custom checks
  if (customChecks) {
    for (const cc of customChecks) {
      checks.push({
        id: cc.id,
        name: 'custom',
        description: cc.description || cc.name,
        category: cc.category,
        severity: cc.severity,
        level: 'table',
        source: 'custom',
        threshold: cc.threshold,
        sql: cc.sql,
      })
    }
  }

  // Deduplicate by ID (can happen if event tables share the same physical table)
  const seen = new Set<string>()
  return checks.filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })
}

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

    let status: DqCheckStatus
    if (totalRows === 0) {
      status = 'not_applicable'
    } else if (check.threshold === 0) {
      status = violatedRows > 0 ? 'fail' : 'pass'
    } else {
      status = pctViolated > check.threshold ? 'fail' : 'pass'
    }

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

function buildSummary(checks: DqCheck[], results: DqCheckResult[]): DqReportSummary {
  const categories: DqCategory[] = ['completeness', 'validity', 'uniqueness', 'consistency', 'plausibility']
  const severities: DqSeverity[] = ['error', 'warning', 'notice']

  const byCategory = {} as Record<DqCategory, { total: number; passed: number; failed: number }>
  for (const c of categories) byCategory[c] = { total: 0, passed: 0, failed: 0 }

  const bySeverity = {} as Record<DqSeverity, { total: number; passed: number; failed: number }>
  for (const s of severities) bySeverity[s] = { total: 0, passed: 0, failed: 0 }

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
