/** Pure helpers for data quality: the check list of a rule set, custom-check
 *  validation, and the run as text. The checks themselves come from the app. */
import {
  buildSummary, customCheckToDqCheck, dedupeChecks, generateEmptyTableCheck, generateFieldNullRateChecks,
  generateSchemaChecks, reportScore, type DqCategory, type DqCheck, type DqCheckResult, type DqCheckSource,
  type DqReport, type DqSeverity,
} from '@/lib/duckdb/data-quality-checks'
import type { DqCustomCheck, DqRunHistoryEntry, SchemaMapping } from '@/types'

export const CATEGORIES: DqCategory[] = ['completeness', 'validity', 'uniqueness', 'consistency', 'plausibility']
export const SEVERITIES: DqSeverity[] = ['error', 'warning', 'notice']
export const SOURCES: DqCheckSource[] = ['builtin', 'schema', 'custom']

/** What each generated check does, keyed by its `name`. */
export const CHECK_KINDS: Record<string, string> = {
  emptyTable: 'builtin, every table — warns when the table has no rows',
  fieldNullRate: 'builtin, every column — NULL rate (notice, informational: always passes, read the %)',
  tableExists: 'schema — each table named by the schema mapping exists',
  orphanRecords: 'schema — visits / events whose patient is not in the patient table',
  temporalOrder: 'schema — visit start ≤ visit end',
  plausibleAge: 'schema — patient age at visit between 0 and 130',
  eventAfterBirth: 'schema — events do not start before the patient\'s birth',
  patientCoverage: 'schema — % of patients with at least one record per event table (notice, informational)',
  relationContract: 'schema — each mapped relation fills its required columns',
  relationUniqueId: 'schema — one row per id at each relation\'s grain (patient, visit, …)',
  custom: 'custom — the rule set\'s own SQL checks',
}

export interface SchemaTable {
  name: string
  columns: { name: string }[]
}

/** The checks the app generates for a database, then the rule set's custom ones
 *  (same order and ids as the Data Quality page). Columns come from the
 *  database's schema. */
export function buildChecks(
  tables: SchemaTable[],
  mapping: SchemaMapping | null | undefined,
  customChecks: DqCustomCheck[],
): DqCheck[] {
  const checks: DqCheck[] = []
  for (const t of tables) {
    checks.push(generateEmptyTableCheck(t.name))
    checks.push(...generateFieldNullRateChecks(t.name, t.columns.map((c) => ({ columnName: c.name }))))
  }
  if (mapping && mapping.presetId !== 'none') {
    checks.push(...generateSchemaChecks(mapping, tables.map((t) => t.name)))
  }
  checks.push(...[...customChecks].sort((a, b) => a.order - b.order).map(customCheckToDqCheck))
  return dedupeChecks(checks)
}

export interface CheckFilter {
  checkIds?: string[]
  sources?: DqCheckSource[]
  categories?: DqCategory[]
  tables?: string[]
  disabledIds?: string[]
}

export function isFiltered(f: CheckFilter): boolean {
  return !!(f.checkIds?.length || f.sources?.length || f.categories?.length || f.tables?.length)
}

/** Checks kept by the filter; unknown `checkIds` are returned so the caller can say so. */
export function selectChecks(checks: DqCheck[], f: CheckFilter): { checks: DqCheck[]; unknownIds: string[] } {
  const disabled = new Set(f.disabledIds ?? [])
  const ids = f.checkIds?.length ? new Set(f.checkIds) : null
  const tables = f.tables?.length ? new Set(f.tables.map((t) => t.toLowerCase())) : null
  const kept = checks.filter((c) =>
    !disabled.has(c.id)
    && (!ids || ids.has(c.id))
    && (!f.sources?.length || f.sources.includes(c.source))
    && (!f.categories?.length || f.categories.includes(c.category))
    && (!tables || (!!c.tableName && (tables.has(c.tableName.toLowerCase())
      || tables.has(c.tableName.split('.').pop()!.toLowerCase())))),
  )
  const known = new Set(checks.map((c) => c.id))
  return { checks: kept, unknownIds: (f.checkIds ?? []).filter((id) => !known.has(id)) }
}

export interface CheckFields {
  name?: string
  description?: string
  category?: string
  severity?: string
  threshold?: number
  sql?: string
}

/** The editor's rules for a custom check (enums, 0–100 threshold, a name) plus
 *  the contract every check SQL must honour: one row with `violated_rows` and
 *  `total_rows`. `partial` is for an update, where missing fields keep theirs. */
export function validateCheckFields(f: CheckFields, partial = false): string[] {
  const errors: string[] = []
  if (!partial || f.name !== undefined) {
    if (!f.name?.trim()) errors.push('name must not be empty.')
  }
  if (!partial || f.category !== undefined) {
    if (!CATEGORIES.includes(f.category as DqCategory)) errors.push(`category must be one of ${CATEGORIES.join(', ')}.`)
  }
  if (!partial || f.severity !== undefined) {
    if (!SEVERITIES.includes(f.severity as DqSeverity)) errors.push(`severity must be one of ${SEVERITIES.join(', ')}.`)
  }
  if (f.threshold !== undefined && (!Number.isFinite(f.threshold) || f.threshold < 0 || f.threshold > 100)) {
    errors.push('threshold is a percentage of violated rows, between 0 and 100 (0 = no violated row allowed).')
  }
  if (!partial || f.sql !== undefined) {
    const sql = f.sql ?? ''
    if (!sql.trim()) errors.push('sql must not be empty.')
    else if (!/\bviolated_rows\b/i.test(sql) || !/\btotal_rows\b/i.test(sql)) {
      errors.push('sql must return one row with two columns named violated_rows and total_rows '
        + '(e.g. SELECT COUNT(*) FILTER (WHERE <violation>)::BIGINT AS violated_rows, COUNT(*)::BIGINT AS total_rows FROM <table>).')
    }
  }
  return errors
}

/** Whether a test run of a check's SQL returned what a check needs. */
export function checkTestProblem(rows: Record<string, unknown>[]): string | null {
  if (!rows.length) return 'The SQL returned no row; a check must return exactly one row.'
  const keys = Object.keys(rows[0]).map((k) => k.toLowerCase())
  const missing = ['violated_rows', 'total_rows'].filter((k) => !keys.includes(k))
  if (missing.length) return `The SQL result lacks the column(s) ${missing.join(', ')} (got: ${Object.keys(rows[0]).join(', ')}).`
  return null
}

export function makeReport(dataSourceId: string, checks: DqCheck[], results: DqCheckResult[], computedAt: string): DqReport {
  return { dataSourceId, computedAt, checks, results, summary: buildSummary(checks, results) }
}

/** The run-history row the app records after a scan. */
export function runEntry(
  id: string, ruleSetId: string, report: DqReport, completedAt: string,
): DqRunHistoryEntry & { durationMs: number; score: number } {
  const durationMs = report.results.reduce((sum, r) => sum + r.executionTimeMs, 0)
  const s = report.summary
  return {
    id,
    ruleSetId,
    dataSourceId: report.dataSourceId,
    startedAt: report.computedAt,
    completedAt,
    status: 'success',
    score: reportScore(s),
    totalChecks: s.total,
    passed: s.passed,
    failed: s.failed,
    errors: s.errors,
    notApplicable: s.notApplicable,
    durationMs,
    report,
  }
}

const pct = (n: number) => (n >= 10 || n === 0 ? n.toFixed(0) : n.toFixed(2))

function checkLine(c: DqCheck | undefined, r: DqCheckResult, withSql: boolean): string {
  const where = c?.tableName ? `${c.tableName}${c.fieldName ? `.${c.fieldName}` : ''} · ` : ''
  const head = `- [${r.status}${c ? ` · ${c.severity}` : ''}] ${c?.description ?? r.checkId} — ${where}`
    + (r.status === 'error'
      ? `error: ${(r.errorMessage ?? '').slice(0, 300)}`
      : `${r.violatedRows}/${r.totalRows} violated (${pct(r.pctViolated)}%, threshold ${c?.threshold ?? 0}%)`)
    + ` · id ${r.checkId}`
  return withSql && c ? `${head}\n  SQL: ${c.sql.replace(/\s+/g, ' ').trim()}` : head
}

export interface ReportView {
  statuses?: DqCheckResult['status'][]
  withSql?: boolean
  maxLines?: number
}

/**
 * A report as text: totals, score, per category, then the checks. By default
 * the failures and errors (errors first, then by severity); `statuses` picks
 * others. Informational notices that pass are never listed unless asked.
 */
export function formatReport(report: DqReport, view: ReportView = {}): string {
  const s = report.summary
  const lines = [
    `Score ${reportScore(s)}% · ${s.total} check(s): ${s.passed} passed, ${s.failed} failed, `
      + `${s.errors} error(s), ${s.notApplicable} not applicable · database ${report.dataSourceId} · ${report.computedAt}`,
    `Failed by severity: ${SEVERITIES.map((sev) => `${sev} ${s.bySeverity[sev]?.failed ?? 0}`).join(', ')}`,
    'By category (passed/total): '
      + CATEGORIES.filter((c) => s.byCategory[c]?.total).map((c) => `${c} ${s.byCategory[c].passed}/${s.byCategory[c].total}`).join(', '),
  ]
  const statuses = view.statuses?.length ? view.statuses : ['error', 'fail']
  const byId = new Map(report.checks.map((c) => [c.id, c]))
  const rank = (r: DqCheckResult) =>
    (r.status === 'error' ? 0 : 1) * 10 + SEVERITIES.indexOf(byId.get(r.checkId)?.severity ?? 'notice')
  const shown = report.results.filter((r) => statuses.includes(r.status)).sort((a, b) => rank(a) - rank(b))
  const max = view.maxLines ?? 60
  lines.push('', shown.length ? `Checks (${statuses.join(', ')}): ${shown.length}` : `No check with status ${statuses.join(' / ')}.`)
  for (const r of shown.slice(0, max)) lines.push(checkLine(byId.get(r.checkId), r, !!view.withSql))
  if (shown.length > max) lines.push(`… ${shown.length - max} more (filter with statuses, or run fewer checks).`)
  return lines.join('\n')
}

/** One line per check for a listing; field null-rate checks are summarised per
 *  table unless `detailFields`, since a database has one per column. */
export function formatCheckList(
  checks: DqCheck[], disabled: Set<string>, opts: { detailFields?: boolean; withSql?: boolean; max?: number } = {},
): string {
  const lines: string[] = []
  const nullRates = new Map<string, number>()
  for (const c of checks) {
    if (c.name === 'fieldNullRate' && !opts.detailFields) {
      nullRates.set(c.tableName ?? '', (nullRates.get(c.tableName ?? '') ?? 0) + 1)
      continue
    }
    const where = c.tableName ? ` · ${c.tableName}${c.fieldName ? `.${c.fieldName}` : ''}` : ''
    let line = `- ${c.id}${disabled.has(c.id) ? ' (disabled)' : ''} — ${c.description} [${c.source} · ${c.category} · `
      + `${c.severity} · threshold ${c.threshold}%${where}]`
    if (opts.withSql) line += `\n  SQL: ${c.sql.replace(/\s+/g, ' ').trim()}`
    lines.push(line)
  }
  const max = opts.max ?? 150
  const out = lines.slice(0, max)
  if (lines.length > max) out.push(`… ${lines.length - max} more (filter by source, category or table).`)
  if (nullRates.size) {
    out.push(`Field NULL-rate checks (notice, id builtin_null_rate_<table>_<column>): `
      + [...nullRates].map(([t, n]) => `${t} ${n}`).join(', ')
      + ' — pass detail_fields to list them.')
  }
  return out.join('\n')
}
