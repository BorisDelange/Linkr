/** Pure helpers for data quality: the stored checks of a rule set as the page
 *  lists them, check validation, a run and its record, investigation summaries.
 *  The checks, their taxonomy and the run rules come from the app. */
import {
  buildSummary, checkStatus, runnableChecks, type DqCheck, type DqCheckResult, type DqReport, type DqReportSummary,
} from '@/lib/duckdb/data-quality-checks'
import {
  DQ_CATEGORIES, DQ_SEVERITIES, DQ_SUBCATEGORIES, normalizeDqCheck, subcategoryFor,
  type DqCategory, type DqCheckOrigin, type DqSeverity, type DqSubcategory,
} from '@/lib/dq-taxonomy'
import type { DqCheckTemplate } from '@/lib/dq-templates'
import type { DqCustomCheck, DqRunHistoryEntry } from '@/types'

export const CATEGORIES = [...DQ_CATEGORIES]
export const SEVERITIES = [...DQ_SEVERITIES]
export const SUBCATEGORIES = [...new Set(Object.values(DQ_SUBCATEGORIES).flat())]
export const ORIGINS: DqCheckOrigin[] = ['ddl', 'mapping', 'manual']
export const OTHER_GROUP = 'Other checks'

/** A stored check with every field filled, as the store reads it: rows written
 *  before the Kahn categories and the generated checks lack some. */
export function readCheck(check: DqCustomCheck): DqCustomCheck {
  return normalizeDqCheck({
    ...check,
    subcategory: check.subcategory ?? null,
    exploreSql: check.exploreSql ?? null,
    origin: check.origin ?? 'manual',
    templateKey: check.templateKey ?? null,
    tableName: check.tableName ?? null,
    disabled: check.disabled ?? false,
  })
}

export const byOrder = (checks: DqCustomCheck[]) => [...checks].sort((a, b) => a.order - b.order)

/** Where the next check goes: after every other one. */
export const nextOrder = (checks: DqCustomCheck[]) => checks.reduce((max, c) => Math.max(max, c.order + 1), 0)

/** A check's group is the `tableName` it shares with others; none is "Other checks". */
export const groupOf = (c: Pick<DqCustomCheck, 'tableName'>) => c.tableName ?? ''

/** The sidebar's groups: named ones in list order, "Other checks" last. */
export function groupChecks(checks: DqCustomCheck[]): { name: string; checks: DqCustomCheck[] }[] {
  const byName = new Map<string, DqCustomCheck[]>()
  for (const c of byOrder(checks)) byName.set(groupOf(c), [...(byName.get(groupOf(c)) ?? []), c])
  const other = byName.get('')
  byName.delete('')
  const named = [...byName].map(([name, list]) => ({ name, checks: list }))
  return other ? [...named, { name: '', checks: other }] : named
}

/** `""` or "Other checks" names the checks with no group. */
export const groupKey = (name: string | null | undefined) =>
  !name || name.trim().toLowerCase() === OTHER_GROUP.toLowerCase() ? '' : name.trim()

export interface CheckFilter {
  checkIds?: string[]
  origins?: DqCheckOrigin[]
  categories?: DqCategory[]
  groups?: string[]
  /** Default `all`. */
  state?: 'enabled' | 'disabled' | 'all'
  search?: string
}

export const isFiltered = (f: CheckFilter) =>
  !!(f.checkIds?.length || f.origins?.length || f.categories?.length || f.groups?.length || f.search?.trim()
    || (f.state && f.state !== 'all'))

/** Checks kept by the filter, in list order; unknown `checkIds` are returned so the caller can say so. */
export function selectChecks(checks: DqCustomCheck[], f: CheckFilter): { checks: DqCustomCheck[]; unknownIds: string[] } {
  const ids = f.checkIds?.length ? new Set(f.checkIds) : null
  const groups = f.groups?.length ? new Set(f.groups.map((g) => groupKey(g).toLowerCase())) : null
  const q = f.search?.trim().toLowerCase()
  const kept = byOrder(checks).filter((c) =>
    (!ids || ids.has(c.id))
    && (!f.origins?.length || f.origins.includes(c.origin))
    && (!f.categories?.length || f.categories.includes(c.category))
    && (!groups || groups.has(groupOf(c).toLowerCase()))
    && (!f.state || f.state === 'all' || (f.state === 'disabled') === c.disabled)
    && (!q || c.name.toLowerCase().includes(q) || groupOf(c).toLowerCase().includes(q)),
  )
  const known = new Set(checks.map((c) => c.id))
  return { checks: kept, unknownIds: (f.checkIds ?? []).filter((id) => !known.has(id)) }
}

export interface CheckFields {
  name?: string
  description?: string
  category?: string
  subcategory?: string | null
  severity?: string
  threshold?: number
  sql?: string
  explore_sql?: string | null
  group?: string | null
}

const SHAPE = 'SELECT COUNT(*) FILTER (WHERE <violation>)::BIGINT AS violated_rows, COUNT(*)::BIGINT AS total_rows FROM <table>'

/**
 * The editor's rules (the three Kahn categories, a subcategory of the category,
 * a severity, a 0–100 threshold, a name) plus the contract every check SQL
 * honours: one row with `violated_rows` and `total_rows`. `current` is the
 * check an update changes; without it every required field must be given.
 */
export function validateCheckFields(f: CheckFields, current?: DqCustomCheck): string[] {
  const errors: string[] = []
  if (!current || f.name !== undefined) {
    if (!f.name?.trim()) errors.push('name must not be empty.')
  }
  if (f.category !== undefined && !CATEGORIES.includes(f.category as DqCategory)) {
    errors.push(`category must be one of ${CATEGORIES.join(', ')} (Kahn et al. 2016).`)
  }
  const category = (f.category ?? current?.category ?? 'plausibility') as DqCategory
  if (f.subcategory && CATEGORIES.includes(category) && !DQ_SUBCATEGORIES[category].includes(f.subcategory as DqSubcategory)) {
    const allowed = DQ_SUBCATEGORIES[category]
    errors.push(allowed.length
      ? `subcategory of ${category} must be one of ${allowed.join(', ')}.`
      : `${category} has no subcategory: leave subcategory out.`)
  }
  if (f.severity !== undefined && !SEVERITIES.includes(f.severity as DqSeverity)) {
    errors.push(`severity must be one of ${SEVERITIES.join(', ')}.`)
  }
  if (f.threshold !== undefined && (!Number.isFinite(f.threshold) || f.threshold < 0 || f.threshold > 100)) {
    errors.push('threshold is a percentage of violated rows, between 0 and 100 (0 = no violated row allowed).')
  }
  if (!current || f.sql !== undefined) {
    const sql = f.sql ?? ''
    if (!sql.trim()) errors.push('sql must not be empty.')
    else if (!/\bviolated_rows\b/.test(sql) || !/\btotal_rows\b/.test(sql)) {
      errors.push(`sql must return one row with two columns named violated_rows and total_rows (e.g. ${SHAPE}).`)
    }
  }
  if (f.group != null && f.group.trim() && groupKey(f.group) === '') {
    errors.push(`"${OTHER_GROUP}" is the checks with no group: pass group null instead.`)
  }
  return errors
}

/** The subcategory a check ends with: the one asked for, else its own when it
 *  still fits the category, else the category's first — the editor's rule. */
export function resolveSubcategory(category: DqCategory, requested: string | null | undefined, current: DqSubcategory | null): DqSubcategory | null {
  if (requested !== undefined) return subcategoryFor(category, requested)
  return subcategoryFor(category, current) ?? DQ_SUBCATEGORIES[category][0] ?? null
}

/** What the Test button says of a test run's rows, or null when they are a check's. */
export function checkTestProblem(rows: Record<string, unknown>[]): string | null {
  if (!rows.length) return `The SQL returned no row; a check returns exactly one row (${SHAPE}).`
  const row = rows[0]
  if (!('violated_rows' in row) || !('total_rows' in row)) {
    return `The SQL result lacks violated_rows and/or total_rows (got: ${Object.keys(row).join(', ')}). Expected: ${SHAPE}.`
  }
  return null
}

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

export { runnableChecks }

/** One check's result from its rows — the page's runner, without its engine. */
export function evaluateRows(check: DqCheck, rows: Record<string, unknown>[], executionTimeMs: number): DqCheckResult {
  if (!rows.length) {
    return { checkId: check.id, status: 'not_applicable', violatedRows: 0, totalRows: 0, pctViolated: 0, executionTimeMs, sql: check.sql }
  }
  const violatedRows = Number(rows[0].violated_rows ?? 0)
  const totalRows = Number(rows[0].total_rows ?? 0)
  return {
    checkId: check.id,
    status: checkStatus(violatedRows, totalRows, check.threshold),
    violatedRows,
    totalRows,
    pctViolated: totalRows > 0 ? (violatedRows / totalRows) * 100 : 0,
    executionTimeMs,
    sql: check.sql,
  }
}

export function errorResult(check: DqCheck, err: unknown, executionTimeMs: number): DqCheckResult {
  return {
    checkId: check.id, status: 'error', violatedRows: 0, totalRows: 0, pctViolated: 0, executionTimeMs, sql: check.sql,
    errorMessage: err instanceof Error ? err.message : String(err),
  }
}

/** % of applicable checks passed; 100 when none applies. */
export function runScore(s: DqReportSummary): number {
  const applicable = s.total - s.notApplicable
  return applicable > 0 ? Math.round((s.passed / applicable) * 100) : 100
}

export function makeReport(dataSourceId: string, checks: DqCheck[], results: DqCheckResult[], computedAt: string): DqReport {
  return { dataSourceId, computedAt, checks, results, summary: buildSummary(checks, results) }
}

/** What a finished run writes: the rule set's last run, and its history row. */
export function runRecord(
  id: string, ruleSet: { id: string; dataSourceId: string }, report: DqReport, completedAt: string,
): { ruleSetChanges: Record<string, unknown>; entry: DqRunHistoryEntry & { durationMs: number; score: number } } {
  const s = report.summary
  const score = runScore(s)
  const durationMs = report.results.reduce((sum, r) => sum + r.executionTimeMs, 0)
  return {
    ruleSetChanges: {
      status: s.failed > 0 ? 'error' : 'success',
      lastRunAt: report.computedAt,
      lastRunDurationMs: durationMs,
      lastScore: score,
    },
    entry: {
      id,
      ruleSetId: ruleSet.id,
      dataSourceId: ruleSet.dataSourceId,
      startedAt: report.computedAt,
      completedAt,
      status: 'success',
      score,
      totalChecks: s.total,
      passed: s.passed,
      failed: s.failed,
      errors: s.errors,
      notApplicable: s.notApplicable,
      durationMs,
      report,
    },
  }
}

// ---------------------------------------------------------------------------
// Schema checks
// ---------------------------------------------------------------------------

/** The templates a rule set does not hold yet (matched on `templateKey`), and how many it has. */
export function missingTemplates(templates: DqCheckTemplate[], stored: DqCustomCheck[]) {
  const have = new Set(stored.map((c) => c.templateKey).filter((k): k is string => !!k))
  const missing = templates.filter((tpl) => !have.has(tpl.templateKey))
  return { missing, presentCount: templates.length - missing.length }
}

export function formatTemplates(templates: DqCheckTemplate[], max = 200): string {
  const byTable = new Map<string, DqCheckTemplate[]>()
  for (const tpl of templates) byTable.set(tpl.tableName, [...(byTable.get(tpl.tableName) ?? []), tpl])
  const lines: string[] = []
  for (const [table, list] of byTable) {
    lines.push(`${table} (${list.length})`)
    for (const tpl of list) lines.push(`  - ${tpl.templateKey} — ${tpl.name} [${tpl.category}${tpl.subcategory ? `/${tpl.subcategory}` : ''} · ${tpl.severity}]`)
  }
  const out = lines.slice(0, max)
  if (lines.length > max) out.push(`… ${lines.length - max} more lines (filter with tables).`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const pct = (n: number) => (n >= 10 || n === 0 ? n.toFixed(0) : n.toFixed(2))
const taxon = (c: { category: DqCategory; subcategory: DqSubcategory | null }) =>
  `${c.category}${c.subcategory ? `/${c.subcategory}` : ''}`

export function describeCheck(c: DqCustomCheck, withSql = false): string {
  const head = `- ${c.name}${c.disabled ? ' (disabled)' : ''} — check_id: ${c.id} [${taxon(c)} · ${c.severity} · `
    + `threshold ${c.threshold}% · ${c.origin}]`
  if (!withSql) return head
  return `${head}\n  SQL: ${oneLine(c.sql)}${c.exploreSql?.trim() ? `\n  Explore SQL: ${oneLine(c.exploreSql)}` : ''}`
}

/** The checks by group, as the sidebar lists them. */
export function formatCheckList(checks: DqCustomCheck[], opts: { withSql?: boolean; max?: number } = {}): string {
  const max = opts.max ?? 200
  const lines: string[] = []
  let shown = 0
  for (const g of groupChecks(checks)) {
    const disabled = g.checks.filter((c) => c.disabled).length
    lines.push(`${g.name || OTHER_GROUP} (${disabled ? `${g.checks.length - disabled}/${g.checks.length} enabled` : g.checks.length})`)
    for (const c of g.checks) {
      if (shown++ >= max) continue
      lines.push(`  ${describeCheck(c, opts.withSql).replace(/\n/g, '\n  ')}`)
    }
  }
  if (shown > max) lines.push(`… ${shown - max} more checks (filter by group, origin, category, or search).`)
  return lines.join('\n')
}

/** Counts a rule set's checks the way its overview does. */
export function checkCounts(checks: DqCustomCheck[]): string {
  const count = <K extends string>(keys: readonly K[], of: (c: DqCustomCheck) => K) =>
    keys.map((k) => `${k} ${checks.filter((c) => of(c) === k).length}`).join(', ')
  const disabled = checks.filter((c) => c.disabled).length
  return `${checks.length} check(s), ${checks.length - disabled} enabled · by origin: ${count(ORIGINS, (c) => c.origin)} · `
    + `by category: ${count(CATEGORIES, (c) => c.category)} · ${groupChecks(checks).length} group(s)`
}

function resultLine(c: DqCheck | undefined, r: DqCheckResult, withSql: boolean): string {
  const where = c?.tableName ? `${c.tableName} · ` : ''
  const head = `- [${r.status}${c ? ` · ${c.severity}` : ''}] ${c?.name ?? r.checkId} — ${where}`
    + (r.status === 'error'
      ? `error: ${(r.errorMessage ?? '').slice(0, 300)}`
      : `${r.violatedRows}/${r.totalRows} violated (${pct(r.pctViolated)}%, threshold ${c?.threshold ?? 0}%)`)
    + ` · check_id ${r.checkId}`
  return withSql ? `${head}\n  SQL: ${oneLine(r.sql)}` : head
}

export interface ReportView {
  statuses?: DqCheckResult['status'][]
  withSql?: boolean
  maxLines?: number
}

/** A report as text: score, totals, per category and severity, then the checks
 *  with the chosen statuses (default: errors, then failures by severity). */
export function formatReport(report: DqReport, view: ReportView = {}): string {
  const s = report.summary
  const lines = [
    `Score ${runScore(s)}% · ${s.total} check(s): ${s.passed} passed, ${s.failed} failed, `
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
  for (const r of shown.slice(0, max)) lines.push(resultLine(byId.get(r.checkId), r, !!view.withSql))
  if (shown.length > max) lines.push(`… ${shown.length - max} more (filter with statuses, or run fewer checks).`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Investigation
// ---------------------------------------------------------------------------

/** The explore query without its trailing `LIMIT n` (and `;`), so the caller bounds it. */
export function unboundedExplore(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '').replace(/\s+LIMIT\s+\d+\s*$/i, '')
}

/** A query wrapped so the server returns at most `limit` rows of it. */
export const boundedQuery = (sql: string, limit: number) => `SELECT *\nFROM (\n${unboundedExplore(sql)}\n) AS dq_explore\nLIMIT ${limit}`

const ID_LIKE = /(^|_)id$/i
const isDateLike = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)

/**
 * What a sample of failing rows looks like, without echoing a row: per column,
 * how many are filled and distinct, the range of numbers and dates, and the
 * most frequent values of the few-valued columns. Identifier columns only get
 * their distinct count.
 */
export function summarizeRows(rows: Record<string, unknown>[], topN = 5): string[] {
  if (!rows.length) return []
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  return columns.map((col) => {
    const values = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== '')
    const distinct = new Map<string, number>()
    for (const v of values) {
      const key = typeof v === 'object' ? JSON.stringify(v) : String(v)
      distinct.set(key, (distinct.get(key) ?? 0) + 1)
    }
    const parts = [`${values.length}/${rows.length} filled`, `${distinct.size} distinct`]
    if (!ID_LIKE.test(col) && values.length) {
      const numbers = values.map((v) => (typeof v === 'number' || typeof v === 'bigint' ? Number(v) : NaN))
      if (numbers.every(Number.isFinite)) {
        parts.push(`min ${Math.min(...numbers)}, max ${Math.max(...numbers)}`)
      } else if (values.every(isDateLike)) {
        const sorted = (values as string[]).slice().sort()
        parts.push(`from ${sorted[0]} to ${sorted[sorted.length - 1]}`)
      } else if (distinct.size <= 20) {
        const top = [...distinct].sort((a, b) => b[1] - a[1]).slice(0, topN)
        parts.push(`top: ${top.map(([v, n]) => `${JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v)} ×${n}`).join(', ')}`)
      }
    }
    return `- ${col}: ${parts.join(' · ')}`
  })
}
