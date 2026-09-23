/**
 * Everything a cohort report shows, computed once and already suppressed — the
 * HTML, PDF and Word renderers only lay it out. Built from the cohort's criteria
 * against its database; nothing here depends on the current execution result, so
 * the report describes the definition as it stands, run fresh.
 */
import type { TFunction } from 'i18next'
import { localized } from '@/lib/localized'
import { buildAttritionQueries, buildCohortMembershipSql } from '@/lib/duckdb/cohort-query'
import type { Cohort, CohortLevel, ConceptCriteriaConfig, CriteriaTreeNode, SchemaMapping } from '@/types'
import type { ChartItem } from './charts'
import { describeCriteria, describeCriterion, type DescribedCriterion } from './describe'
import {
  buildAgeSql, buildCareUnitSql, buildConceptSql, buildCountsSql, buildEventTablesSql,
  buildDatabasePatientsSql, buildIndexSql, buildMonthSql, buildSexSql, buildVisitCountSql,
} from './queries'
import { suppress, suppressedShare, type ReportCount } from './suppress'

export type RunQuery = (sql: string) => Promise<Record<string, unknown>[]>

export interface CohortReportModel {
  title: string
  description: string
  databaseName: string
  level: CohortLevel
  /** What one row of the cohort is, plural: "unit stays". */
  unitLabel: string
  generatedAt: string
  version: string
  threshold: number
  locale: string
  kpis: { label: string; count: ReportCount }[]
  flow: { label: string; units: ReportCount; patients?: ReportCount }[]
  criteria: DescribedCriterion[]
  concepts: {
    criterion: string
    table: string
    conceptId: number
    name: string
    rows: ReportCount
    patients: ReportCount
    coverage: string | null
  }[]
  age: ChartItem[]
  sex: ChartItem[]
  months: ChartItem[]
  /** Where the figures come from, so a reader outside Linkr can place them. */
  source: {
    databaseName: string
    databaseVersion?: string
    schemaLabel?: string
    /** Every patient of the database: the denominator of the cohort. */
    databasePatients: ReportCount | null
  }
  eventTables: { label: string; rows: ReportCount; patients: ReportCount }[]
  careUnits: ChartItem[]
  /** The membership query every figure is computed from. */
  sql: string
}

export type CohortReportUnavailableReason = 'custom-sql' | 'event-level' | 'no-query'

/** Why a cohort cannot have a report; `message` is the reason, for the dialog to translate. */
export class CohortReportUnavailable extends Error {
  readonly reason: CohortReportUnavailableReason
  constructor(reason: CohortReportUnavailableReason) {
    super(reason)
    this.reason = reason
  }
}

const num = (v: unknown): number => (v == null ? 0 : Number(v))

/**
 * Every month from the first to the last, zeros included: a month with no one
 * in it is a finding (a gap in recording, a unit closed), and dropping it would
 * draw the months either side as neighbours.
 */
export function fillMonths(rows: { month: string; n: number }[]): { month: string; n: number }[] {
  const valid = rows.filter((r) => /^\d{4}-\d{2}$/.test(r.month)).sort((a, b) => a.month.localeCompare(b.month))
  if (valid.length === 0) return []
  const byMonth = new Map(valid.map((r) => [r.month, r.n]))
  const out: { month: string; n: number }[] = []
  let [y, m] = valid[0].month.split('-').map(Number)
  const [ly, lm] = valid[valid.length - 1].month.split('-').map(Number)
  while (y < ly || (y === ly && m <= lm)) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    out.push({ month: key, n: byMonth.get(key) ?? 0 })
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

function conceptCriteria(node: CriteriaTreeNode): { node: CriteriaTreeNode; config: ConceptCriteriaConfig }[] {
  if (!node.enabled) return []
  if (node.kind === 'group') return node.children.flatMap(conceptCriteria)
  return node.type === 'concept' && !node.exclude
    ? [{ node, config: node.config as ConceptCriteriaConfig }]
    : []
}

export async function buildCohortReportModel(args: {
  cohort: Cohort
  mapping: SchemaMapping
  databaseName: string
  databaseVersion?: string
  /** The schema the database follows (its preset's label). */
  schemaLabel?: string
  run: RunQuery
  t: TFunction
  locale: string
  threshold: number
  now?: Date
}): Promise<CohortReportModel> {
  const { cohort, mapping, run, t, locale, threshold } = args
  // A hand-written query returns whatever columns its author chose; the report
  // needs the membership (`id`, `patient_id`) the criteria builder guarantees.
  if (cohort.customSql) throw new CohortReportUnavailable('custom-sql')
  if (cohort.level === 'event') throw new CohortReportUnavailable('event-level')
  const membership = buildCohortMembershipSql(cohort, mapping)
  if (!membership) throw new CohortReportUnavailable('no-query')

  const count = (n: unknown) => suppress(num(n), threshold, locale)
  const unitLabel = t(`cohort_report.unit_${cohort.level}`)

  const [counts] = await run(buildCountsSql(membership))
  const patients = count(counts?.patients)
  const units = count(counts?.units)
  const kpis: CohortReportModel['kpis'] = [{ label: t('cohort_report.kpi_patients'), count: patients }]
  if (cohort.level !== 'patient') kpis.push({ label: unitLabel, count: units })
  const visitSql = buildVisitCountSql(membership, cohort.level, mapping)
  if (visitSql) {
    const [v] = await run(visitSql)
    kpis.push({ label: t('cohort_report.kpi_visits'), count: count(v?.visits) })
  }

  // Attrition, with patients beside the level's own count at every step.
  const flow: CohortReportModel['flow'] = []
  const enabled = cohort.criteriaTree.children.filter((c) => c.enabled)
  const attrition = buildAttritionQueries(cohort, mapping, { withPatients: true })
  for (const [i, q] of attrition.entries()) {
    const [row] = await run(q.sql)
    const label = i === 0 ? t('cohort_report.flow_total') : describeCriterion(enabled[i - 1], t, mapping)
    flow.push({
      label,
      units: count(row?.cnt),
      ...(cohort.level !== 'patient' ? { patients: count(row?.patients) } : {}),
    })
  }

  const concepts: CohortReportModel['concepts'] = []
  for (const { node, config } of conceptCriteria(cohort.criteriaTree)) {
    const sql = buildConceptSql(membership, mapping, config)
    if (!sql) continue
    const rows = await run(sql)
    for (const id of config.conceptIds) {
      const r = rows.find((x) => num(x.concept_id) === id)
      const conceptPatients = count(r?.patients)
      concepts.push({
        criterion: describeCriterion(node, t, mapping),
        table: config.eventTableLabel,
        conceptId: id,
        name: config.conceptNames?.[id] ?? String(id),
        rows: count(r?.rows),
        patients: conceptPatients,
        coverage: suppressedShare(conceptPatients, patients, locale),
      })
    }
  }

  const indexSql = buildIndexSql(membership, cohort.level, mapping)
  const ageSql = indexSql ? buildAgeSql(indexSql, mapping) : null
  const age = ageSql
    ? (await run(ageSql)).map((r) => ({ label: `${num(r.bin)}–${num(r.bin) + 9}`, count: count(r.n) }))
    : []

  const gv = mapping.genderValues
  const sexName = (v: string) =>
    v === gv?.male ? t('cohort_report.sex_male')
      : v === gv?.female ? t('cohort_report.sex_female')
        : v === gv?.unknown ? t('cohort_report.sex_unknown') : v || t('cohort_report.sex_missing')
  const sexSql = buildSexSql(membership, mapping)
  const sex = sexSql
    ? (await run(sexSql)).map((r) => ({ label: sexName(String(r.gender ?? '')), count: count(r.n) }))
    : []

  const months = indexSql
    ? fillMonths((await run(buildMonthSql(indexSql))).map((r) => ({ month: String(r.month), n: num(r.n) })))
        .map((m) => ({ label: m.month, count: count(m.n) }))
    : []
  const eventSql = buildEventTablesSql(membership, mapping)
  const eventTables = eventSql
    ? (await run(eventSql))
        .map((r) => ({ label: String(r.label), rows: count(r.rows), patients: count(r.patients), raw: num(r.rows) }))
        // Largest first; a suppressed count sorts with the small ones it hides.
        .sort((a, b) => (b.rows.value ?? 0) - (a.rows.value ?? 0) || b.raw - a.raw)
        .map(({ raw: _raw, ...e }) => e)
    : []

  const databasePatientsSql = buildDatabasePatientsSql(mapping)
  const databasePatients = databasePatientsSql
    ? count((await run(databasePatientsSql))[0]?.n)
    : null

  const unitSql = buildCareUnitSql(membership, cohort.level, mapping)
  const careUnits = unitSql
    ? (await run(unitSql)).map((r) => ({ label: String(r.unit ?? t('cohort_report.unit_missing')), count: count(r.n) }))
    : []

  return {
    title: localized(cohort.name, locale),
    description: localized(cohort.description, locale),
    databaseName: args.databaseName,
    level: cohort.level,
    unitLabel,
    generatedAt: (args.now ?? new Date()).toISOString(),
    version: cohort.version ?? '0.1.0',
    threshold,
    locale,
    kpis,
    flow,
    criteria: describeCriteria(cohort.criteriaTree, t, mapping),
    concepts,
    age,
    sex,
    months,
    source: {
      databaseName: args.databaseName,
      ...(args.databaseVersion ? { databaseVersion: args.databaseVersion } : {}),
      ...(args.schemaLabel ? { schemaLabel: args.schemaLabel } : {}),
      databasePatients,
    },
    eventTables,
    careUnits,
    sql: membership,
  }
}
