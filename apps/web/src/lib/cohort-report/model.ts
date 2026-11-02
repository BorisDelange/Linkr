/**
 * Everything a cohort report shows, computed once and already suppressed — the
 * HTML, PDF and Word renderers only lay it out. Built from the cohort's criteria
 * against its database; nothing here depends on the current execution result, so
 * the report describes the definition as it stands, run fresh.
 */
import type { TFunction } from 'i18next'
import { localized } from '@/lib/localized'
import { buildAttritionQueries, buildCohortMembershipSql, conceptCriterionRelations, CUSTOM_SQL_STEP_ID, type RelationNarrowing } from '@/lib/duckdb/cohort-query'
import { indent, subquerySql } from '@/lib/duckdb/sql-layout'
import type { Cohort, CohortLevel, ConceptCriteriaConfig, CriteriaTreeNode, DatabaseEngine, SchemaMapping } from '@/types'
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

export type CohortReportUnavailableReason = 'event-level' | 'no-query'

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

/**
 * Whether a database gets the report as one query. Oracle cannot be sent one of
 * its sections (the months' date format): in one query, the whole report would
 * be computed here on its tables' rows, rather than that section alone.
 */
export const reportInOneQuery = (engine: DatabaseEngine | undefined): boolean => engine !== 'oracle'

/** The members' CTE the sections read when the report is one query. */
const MEMBERS = 'cohort_members'

/** The columns the sections return, each with the one type every block gives it. */
const COLUMNS = {
  patients: 'BIGINT', units: 'BIGINT', visits: 'BIGINT', cnt: 'BIGINT', concept_id: 'BIGINT', rows: 'BIGINT',
  bin: 'BIGINT', n: 'BIGINT', gender: 'VARCHAR', month: 'VARCHAR', label: 'VARCHAR', unit: 'VARCHAR',
} as const
type Column = keyof typeof COLUMNS

/** One section of the report: the query over the members, and its columns. */
interface Section {
  block: string
  sql: string | null
  columns: Column[]
}

/**
 * Every section in one query: the members are computed once (`MATERIALIZED`;
 * a database the query is translated for decides by itself, and computes a CTE
 * read several times once), each section a block of rows named by `block`.
 * Every block lists every column, NULL where it has none, in one order: an
 * external database receives a plain UNION ALL.
 */
export function buildReportSectionsSql(membershipSql: string, sections: readonly Section[]): string {
  const all = Object.keys(COLUMNS) as Column[]
  const blocks = sections.filter((s) => s.sql).map((s) => [
    `SELECT '${s.block}' AS block,`,
    indent(all.map((c) => `CAST(${s.columns.includes(c) ? `b.${c}` : 'NULL'} AS ${COLUMNS[c]}) AS ${c}`).join(',\n')),
    `FROM ${subquerySql(s.sql!)} b`,
  ].join('\n'))
  return [`WITH ${MEMBERS} AS MATERIALIZED ${subquerySql(membershipSql)}`, blocks.join('\nUNION ALL\n')].join('\n')
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
  /** Each concept searched only in the tables the concept count found it in. */
  narrowing?: RelationNarrowing
  /** Every section in one query over the members computed once; otherwise one
   *  query per section, each computing them (a database that would compute a
   *  CTE read several times as often). */
  combine?: boolean
}): Promise<CohortReportModel> {
  const { cohort, mapping, run, t, locale, threshold, narrowing, combine = false } = args
  // Hand-written SQL replaces the criteria: they stay stored, but select nothing.
  const tree = cohort.customSql?.trim() ? { ...cohort.criteriaTree, children: [] } : cohort.criteriaTree
  if (cohort.level === 'event') throw new CohortReportUnavailable('event-level')
  const membership = buildCohortMembershipSql(cohort, mapping, narrowing)
  if (!membership) throw new CohortReportUnavailable('no-query')

  const count = (n: unknown) => suppress(num(n), threshold, locale)
  const unitLabel = t(`cohort_report.unit_${cohort.level}`)
  const members = combine ? `SELECT * FROM ${MEMBERS}` : membership
  const attrition = buildAttritionQueries(cohort, mapping, { withPatients: true, narrowing })
  const criteria = conceptCriteria(tree)
  const indexSql = buildIndexSql(members, cohort.level, mapping)

  const sections: Section[] = [
    { block: 'counts', sql: buildCountsSql(members), columns: ['patients', 'units'] },
    { block: 'visits', sql: buildVisitCountSql(members, cohort.level, mapping), columns: ['visits'] },
    { block: 'total', sql: attrition[0]?.sql ?? null, columns: ['cnt', 'patients'] },
    ...criteria.map(({ config }, i): Section => ({
      block: `concept_${i}`, sql: buildConceptSql(members, mapping, config), columns: ['concept_id', 'rows', 'patients'],
    })),
    { block: 'age', sql: indexSql ? buildAgeSql(indexSql, mapping) : null, columns: ['bin', 'n'] },
    { block: 'sex', sql: buildSexSql(members, mapping), columns: ['gender', 'n'] },
    { block: 'months', sql: indexSql ? buildMonthSql(indexSql) : null, columns: ['month', 'n'] },
    { block: 'events', sql: buildEventTablesSql(members, mapping), columns: ['label', 'rows', 'patients'] },
    { block: 'database', sql: buildDatabasePatientsSql(mapping), columns: ['n'] },
    { block: 'units', sql: buildCareUnitSql(members, cohort.level, mapping), columns: ['unit', 'n'] },
  ]
  const byBlock = new Map<string, Record<string, unknown>[]>()
  if (combine) {
    for (const row of await run(buildReportSectionsSql(membership, sections))) {
      const block = String(row.block)
      byBlock.set(block, [...(byBlock.get(block) ?? []), row])
    }
  } else {
    for (const section of sections) if (section.sql) byBlock.set(section.block, await run(section.sql))
  }
  const rowsOf = (block: string) => byBlock.get(block) ?? []
  const sectionRan = (block: string) => sections.some((s) => s.block === block && s.sql)

  const [counts] = rowsOf('counts')
  const patients = count(counts?.patients)
  const units = count(counts?.units)
  const kpis: CohortReportModel['kpis'] = [{ label: t('cohort_report.kpi_patients'), count: patients }]
  if (cohort.level !== 'patient') kpis.push({ label: unitLabel, count: units })
  if (sectionRan('visits')) kpis.push({ label: t('cohort_report.kpi_visits'), count: count(rowsOf('visits')[0]?.visits) })

  // Attrition, with patients beside the level's own count at every step. The
  // first step is the whole table, the last the cohort itself: both counted
  // above; only the steps between run their own query.
  const flow: CohortReportModel['flow'] = []
  const enabled = tree.children.filter((c) => c.enabled)
  for (const [i, q] of attrition.entries()) {
    const [row] = i === 0 ? rowsOf('total')
      : i === attrition.length - 1 ? [{ cnt: counts?.units, patients: counts?.patients }]
        : await run(q.sql)
    const label = i === 0 ? t('cohort_report.flow_total')
      : q.nodeId === CUSTOM_SQL_STEP_ID ? t('cohort_report.flow_custom_sql')
        : describeCriterion(enabled[i - 1], t, mapping)
    flow.push({
      label,
      units: count(row?.cnt),
      ...(cohort.level !== 'patient' ? { patients: count(row?.patients) } : {}),
    })
  }

  const concepts: CohortReportModel['concepts'] = []
  for (const [i, { node, config }] of criteria.entries()) {
    if (!sectionRan(`concept_${i}`)) continue
    const rows = rowsOf(`concept_${i}`)
    const table = conceptCriterionRelations(config, mapping).map((rel) => rel.key).join(', ')
    for (const id of config.conceptIds) {
      const r = rows.find((x) => num(x.concept_id) === id)
      const conceptPatients = count(r?.patients)
      concepts.push({
        criterion: describeCriterion(node, t, mapping),
        table,
        conceptId: id,
        name: config.conceptNames?.[id] ?? String(id),
        rows: count(r?.rows),
        patients: conceptPatients,
        coverage: suppressedShare(conceptPatients, patients, locale),
      })
    }
  }

  // A block's rows come back in no order: each section sorts its own.
  const age = [...rowsOf('age')].sort((a, b) => num(a.bin) - num(b.bin))
    .map((r) => ({ label: `${num(r.bin)}–${num(r.bin) + 9}`, count: count(r.n) }))

  const gv = mapping.patient?.genderValues
  const sexName = (v: string) =>
    v === gv?.male ? t('cohort_report.sex_male')
      : v === gv?.female ? t('cohort_report.sex_female')
        : v === gv?.unknown ? t('cohort_report.sex_unknown') : v || t('cohort_report.sex_missing')
  const sex = [...rowsOf('sex')].sort((a, b) => num(b.n) - num(a.n))
    .map((r) => ({ label: sexName(String(r.gender ?? '')), count: count(r.n) }))

  const months = fillMonths(rowsOf('months').map((r) => ({ month: String(r.month), n: num(r.n) })))
    .map((m) => ({ label: m.month, count: count(m.n) }))
  const eventTables = rowsOf('events')
    .map((r) => ({ label: String(r.label), rows: count(r.rows), patients: count(r.patients), raw: num(r.rows) }))
    // Largest first; a suppressed count sorts with the small ones it hides.
    .sort((a, b) => (b.rows.value ?? 0) - (a.rows.value ?? 0) || b.raw - a.raw)
    .map(({ raw: _raw, ...e }) => e)

  const databasePatients = sectionRan('database') ? count(rowsOf('database')[0]?.n) : null

  const careUnits = [...rowsOf('units')].sort((a, b) => num(b.n) - num(a.n))
    .map((r) => ({ label: String(r.unit ?? t('cohort_report.unit_missing')), count: count(r.n) }))

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
    criteria: describeCriteria(tree, t, mapping),
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
    // What the cohort's SQL tab shows, not the wrapper the figures ran on.
    sql: cohort.customSql?.trim() || membership,
  }
}
