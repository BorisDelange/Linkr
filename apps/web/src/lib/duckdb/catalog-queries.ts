import type { SchemaMapping, ConceptDictionary, EventTable } from '@/types/schema-mapping'
import type { CatalogVariableId, CatalogVariables, ConceptVariableConfig, PeriodGranularity, ServiceVariableConfig } from '@/types/catalog'
import { birthYearSql, getEventTablesForDictionary, qualify, qualifyIn } from '@/lib/schema-helpers'
import { escSql as esc } from '@/lib/format-helpers'
import { ageBucketLabels, canonicalCrossing, OTHER_MODALITY } from '@/lib/data-catalog/config'

/**
 * Resolve a column alias (e.g. 'domain_id') to the actual SQL column name for a concept dictionary.
 * Checks dict.categoryColumn / dict.subcategoryColumn first (direct match on value),
 * then falls back to extraColumns[alias].
 */
function resolveDictColumn(dict: ConceptDictionary, alias: string): string | undefined {
  if (dict.categoryColumn === alias) return alias
  if (dict.subcategoryColumn === alias) return alias
  return dict.extraColumns?.[alias]
}

const lit = (v: string | number) => (typeof v === 'number' ? String(v) : `'${esc(v)}'`)

// ---------------------------------------------------------------------------
// Concept list (per-concept counts, the Concepts tab)
// ---------------------------------------------------------------------------

/** SQL to list all distinct concept IDs for one dictionary. */
export interface ConceptListQuery {
  dictKey: string
  sql: string
  table: string
  idColumn: string
}

/** Per-concept aggregates for a batch of concept ids within one dictionary. */
export interface BatchQueryTemplate {
  dictKey: string
  buildSql: (conceptIds: (string | number)[]) => string
}

export interface ConceptListQueries {
  conceptListQueries: ConceptListQuery[]
  batchTemplates: BatchQueryTemplate[]
}

/**
 * One small query per dictionary listing its concept ids, and a template per
 * dictionary for the per-concept patient / record / visit counts.
 */
export function buildConceptListQueries(
  mapping: SchemaMapping,
  categoryColumn?: string,
  subcategoryColumn?: string,
): ConceptListQueries | null {
  const dicts = mapping.conceptTables
  const pt = mapping.patientTable
  const vt = mapping.visitTable
  if (!dicts?.length || !pt || !vt) return null

  const conceptListQueries: ConceptListQuery[] = []
  const batchTemplates: BatchQueryTemplate[] = []

  for (const dict of dicts) {
    if (!dict.idColumn) continue
    const eventParts = buildEventPartsForDict(mapping, dict, pt.idColumn)
    if (eventParts.length === 0) continue

    conceptListQueries.push({
      dictKey: dict.key,
      sql: `SELECT DISTINCT "${dict.idColumn}" AS cid FROM ${qualify(dict)}`,
      table: dict.table,
      idColumn: dict.idColumn,
    })

    const catCol = categoryColumn ? resolveDictColumn(dict, categoryColumn) : undefined
    const subcatCol = subcategoryColumn ? resolveDictColumn(dict, subcategoryColumn) : undefined
    const cnBaseSql = `SELECT "${dict.idColumn}" AS cid, "${dict.nameColumn}" AS cname${categoryColumn ? `, ${catCol ? `"${catCol}"` : 'NULL'} AS ccat` : ''}${subcategoryColumn ? `, ${subcatCol ? `"${subcatCol}"` : 'NULL'} AS csubcat` : ''} FROM ${qualify(dict)}`
    const conceptCols = ['cn.cid', 'cn.cname', ...(categoryColumn ? ['cn.ccat'] : []), ...(subcategoryColumn ? ['cn.csubcat'] : [])]
    const catSelect = `${categoryColumn ? ',\n    cn.ccat AS concept_category' : ''}${subcategoryColumn ? ',\n    cn.csubcat AS concept_subcategory' : ''}`
    const eventsSql = eventParts.join('\n    UNION ALL\n    ')

    batchTemplates.push({
      dictKey: dict.key,
      buildSql: (conceptIds) => {
        const inList = conceptIds.map(lit).join(', ')
        return `WITH events AS (
  SELECT cid, pid FROM (
    ${eventsSql}
  ) _evts
  WHERE cid IN (${inList})
),
concept_names AS (
  ${cnBaseSql}
  WHERE cid IN (${inList})
)
SELECT
    cn.cid AS concept_id,
    cn.cname AS concept_name,
    ${lit(dict.key)} AS dictionary_key${catSelect},
    COUNT(*)::BIGINT AS record_count,
    COUNT(DISTINCT e.pid)::BIGINT AS patient_count,
    COUNT(DISTINCT v."${vt.idColumn}")::BIGINT AS visit_count
FROM events e
JOIN ${qualify(pt)} p ON e.pid = p."${pt.idColumn}"
JOIN ${qualify(vt)} v ON e.pid = v."${vt.patientIdColumn}"
JOIN concept_names cn ON e.cid = cn.cid
GROUP BY ${conceptCols.join(', ')}`
      },
    })
  }

  return batchTemplates.length ? { conceptListQueries, batchTemplates } : null
}

function buildEventPartsForDict(mapping: SchemaMapping, dict: ConceptDictionary, defaultPatientIdColumn: string): string[] {
  const parts: string[] = []
  for (const { eventTable: et } of getEventTablesForDictionary(mapping, dict.key)) {
    const patientCol = et.patientIdColumn ?? defaultPatientIdColumn
    parts.push(`SELECT "${et.conceptIdColumn}" AS cid, "${patientCol}" AS pid FROM ${qualify(et)}`)
    if (et.sourceConceptIdColumn) {
      parts.push(`SELECT "${et.sourceConceptIdColumn}" AS cid, "${patientCol}" AS pid FROM ${qualify(et)}`)
    }
  }
  return parts
}

// ---------------------------------------------------------------------------
// Totals and modality lists
// ---------------------------------------------------------------------------

/** Patients with a visit, visits, and event rows: the catalog's headline figures. */
export function buildTotalsQuery(mapping: SchemaMapping): string | null {
  const vt = mapping.visitTable
  if (!vt) return null
  const events = eventUnion(mapping, { level: 'concept' }, null, false)
  const records = events ? `(SELECT COUNT(*) FROM (\n  ${events}\n) _ev)::BIGINT` : '0::BIGINT'
  return `SELECT
  COUNT(DISTINCT v."${vt.patientIdColumn}")::BIGINT AS total_patients,
  COUNT(*)::BIGINT AS total_visits,
  ${records} AS total_records
FROM ${qualify(vt)} v`
}

/** Every service of the level, with its patients, largest first. */
export function buildServiceListQuery(mapping: SchemaMapping, level: ServiceVariableConfig['level']): string | null {
  const svc = serviceSource(mapping, level)
  const vt = mapping.visitTable
  if (!svc || !vt) return null
  return `SELECT svc, COUNT(DISTINCT pid)::BIGINT AS patients FROM (
  SELECT ${svc.rawExpr} AS svc, v."${vt.patientIdColumn}" AS pid
  FROM ${qualify(vt)} v
  ${svc.visitJoin}
) _s
WHERE svc IS NOT NULL
GROUP BY svc
ORDER BY patients DESC, svc`
}

// ---------------------------------------------------------------------------
// Variable expressions
// ---------------------------------------------------------------------------

export function periodExpr(dateExpr: string, granularity: PeriodGranularity): string {
  const d = `CAST(${dateExpr} AS TIMESTAMP)`
  if (granularity === 'year') return `strftime(${d}, '%Y')`
  if (granularity === 'quarter') return `(strftime(${d}, '%Y') || '-Q' || CAST(quarter(${d}) AS VARCHAR))`
  return `strftime(${d}, '%Y-%m')`
}

/**
 * Age in whole years at `dateExpr`: from the birth date, else the birth year.
 * Both are tried row by row — OMOP maps both columns and many ETLs fill only
 * `year_of_birth`.
 */
function ageYearsExpr(mapping: SchemaMapping, dateExpr: string): string | null {
  const pt = mapping.patientTable
  if (!pt) return null
  const d = `CAST(${dateExpr} AS TIMESTAMP)`
  const byDate = pt.birthDateColumn ? `EXTRACT(YEAR FROM AGE(${d}, CAST(p."${pt.birthDateColumn}" AS TIMESTAMP)))` : null
  const birthYear = birthYearSql(pt, 'p')
  const byYear = birthYear ? `(EXTRACT(YEAR FROM ${d}) - ${birthYear})` : null
  if (byDate && byYear) return `COALESCE(${byDate}, ${byYear})`
  return byDate ?? byYear
}

/** The age bracket label at `dateExpr`; labels match `ageBucketLabels`. */
export function ageBucketExpr(mapping: SchemaMapping, dateExpr: string, brackets: readonly number[]): string | null {
  const age = ageYearsExpr(mapping, dateExpr)
  if (!age) return null
  const labels = ageBucketLabels(brackets)
  const bounds = [...new Set(brackets)].filter((b) => b > 0).sort((a, b) => a - b)
  if (bounds.length === 0) return `CASE WHEN ${age} IS NULL THEN NULL ELSE ${lit(labels[0])} END`
  const whens = bounds.map((b, i) => `WHEN ${age} < ${b} THEN ${lit(labels[i])}`)
  return `CASE WHEN ${age} IS NULL THEN NULL ${whens.join(' ')} ELSE ${lit(labels[labels.length - 1])} END`
}

export function sexExpr(mapping: SchemaMapping): string | null {
  const pt = mapping.patientTable
  const gv = mapping.genderValues
  if (!pt?.genderColumn || !gv) return null
  const g = `CAST(p."${pt.genderColumn}" AS VARCHAR)`
  return `CASE WHEN ${g} = ${lit(gv.male)} THEN 'male' WHEN ${g} = ${lit(gv.female)} THEN 'female' ELSE 'other' END`
}

interface ServiceSource {
  /** The service name, null when unknown. */
  rawExpr: string
  /** Joins after `FROM visit v` that bring the service in. */
  visitJoin: string
  /** Joins after the events CTE `ev` that attach each event to the stay containing it. */
  eventJoin: string
}

/**
 * Where a service name comes from at each level.
 *
 * visit_detail: the verbatim source value (the actual ward) first, then the
 * looked-up care-site name, then the raw unit column — on MIMIC it is a name,
 * on OMOP an id that may not resolve. Events carry no stay id, so an event is
 * attached to the stay that contains its date.
 */
function serviceSource(mapping: SchemaMapping, level: ServiceVariableConfig['level']): ServiceSource | null {
  const vt = mapping.visitTable
  if (!vt) return null
  const contains = (alias: string, start: string, end: string | undefined) =>
    `ev.edate >= CAST(${alias}."${start}" AS TIMESTAMP) AND ev.edate < CAST(${alias}."${end ?? start}" AS DATE) + INTERVAL 1 DAY`

  if (level === 'visit_detail') {
    const vd = mapping.visitDetailTable
    if (!vd) return null
    const hasLookup = !!(vd.unitColumn && vd.unitNameTable && vd.unitNameIdColumn && vd.unitNameColumn)
    const candidates = [
      vd.unitSourceValueColumn ? `vd."${vd.unitSourceValueColumn}"` : null,
      hasLookup ? `un."${vd.unitNameColumn}"` : null,
      vd.unitColumn ? `vd."${vd.unitColumn}"` : null,
    ].filter((c): c is string => !!c)
    if (candidates.length === 0) return null
    const lookup = hasLookup ? `\n  LEFT JOIN ${qualifyIn(vd, vd.unitNameTable)} un ON un."${vd.unitNameIdColumn}" = vd."${vd.unitColumn}"` : ''
    return {
      rawExpr: `COALESCE(${candidates.map((c) => `NULLIF(CAST(${c} AS VARCHAR), '')`).join(', ')})`,
      visitJoin: `JOIN ${qualify(vd)} vd ON vd."${vd.visitIdColumn}" = v."${vt.idColumn}"${lookup}`,
      eventJoin: `JOIN ${qualify(vd)} vd ON vd."${vd.patientIdColumn}" = ev.pid AND ${contains('vd', vd.startDateColumn, vd.endDateColumn)}${lookup}`,
    }
  }
  if (!vt.typeColumn) return null
  return {
    rawExpr: `NULLIF(CAST(v."${vt.typeColumn}" AS VARCHAR), '')`,
    visitJoin: '',
    eventJoin: `JOIN ${qualify(vt)} v ON v."${vt.patientIdColumn}" = ev.pid AND ${contains('v', vt.startDateColumn, vt.endDateColumn)}`,
  }
}

/**
 * The service modality after grouping: as is, the top N kept and the rest
 * "Other", or the user's named groups.
 */
export function serviceGroupingExpr(rawExpr: string, cfg: ServiceVariableConfig, topServices: readonly string[]): string {
  const other = lit(OTHER_MODALITY)
  if (cfg.grouping === 'top') {
    if (topServices.length === 0) return `CASE WHEN ${rawExpr} IS NULL THEN NULL ELSE ${other} END`
    return `CASE WHEN ${rawExpr} IS NULL THEN NULL WHEN ${rawExpr} IN (${topServices.map(lit).join(', ')}) THEN ${rawExpr} ELSE ${other} END`
  }
  if (cfg.grouping === 'manual') {
    const byGroup = new Map<string, string[]>()
    for (const [service, group] of Object.entries(cfg.groups ?? {})) {
      const name = group.trim()
      if (!name) continue
      byGroup.set(name, [...(byGroup.get(name) ?? []), service])
    }
    const whens = [...byGroup].map(([group, services]) => `WHEN ${rawExpr} IN (${services.map(lit).join(', ')}) THEN ${lit(group)}`)
    const fallback = cfg.unassigned === 'keep' ? rawExpr : other
    return `CASE WHEN ${rawExpr} IS NULL THEN NULL ${whens.join(' ')} ELSE ${fallback} END`
  }
  return rawExpr
}

// ---------------------------------------------------------------------------
// Events (the concept variable)
// ---------------------------------------------------------------------------

/** Concept modalities to keep, per dictionary: the top N, or one chunk of the concept list. */
export type ConceptFilter = Array<{ dictKey: string; ids: (string | number)[] }>

/**
 * Every event as (concept modality, patient, date).
 *
 * The modality is the concept id — prefixed with its dictionary key when there
 * are several, since ids collide across dictionaries — or its category. A
 * table's source concept column adds its events too, unless it repeats the
 * standard one (counting that row twice).
 */
function eventUnion(
  mapping: SchemaMapping,
  concept: Pick<ConceptVariableConfig, 'level' | 'categoryColumn' | 'subcategoryColumn'>,
  filter: ConceptFilter | null,
  withDate: boolean,
): string | null {
  const pt = mapping.patientTable
  const dicts = mapping.conceptTables ?? []
  if (!pt || dicts.length === 0) return null
  const multi = dicts.length > 1
  const parts: string[] = []

  for (const dict of dicts) {
    const byLevel = concept.level === 'category' ? concept.categoryColumn : concept.level === 'subcategory' ? concept.subcategoryColumn : undefined
    const catCol = byLevel ? resolveDictColumn(dict, byLevel) : undefined
    if (concept.level !== 'concept' && (!catCol || !dict.idColumn)) continue
    const ids = filter?.find((f) => f.dictKey === dict.key)?.ids
    if (filter && !ids?.length) continue

    for (const { eventTable: et } of getEventTablesForDictionary(mapping, dict.key)) {
      const pid = `e."${et.patientIdColumn ?? pt.idColumn}"`
      const date = withDate ? `, ${et.dateColumn ? `CAST(e."${et.dateColumn}" AS TIMESTAMP)` : 'NULL::TIMESTAMP'} AS edate` : ''
      const columns = [et.conceptIdColumn, ...(et.sourceConceptIdColumn ? [et.sourceConceptIdColumn] : [])]
      columns.forEach((col, i) => {
        const skipDuplicate = i > 0 ? ` AND e."${col}" IS DISTINCT FROM e."${et.conceptIdColumn}"` : ''
        const idFilter = ids ? ` AND e."${col}" IN (${ids.map(lit).join(', ')})` : ''
        if (concept.level === 'concept') {
          const idExpr = `CAST(e."${col}" AS VARCHAR)`
          const modality = multi ? `(${lit(`${dict.key}:`)} || ${idExpr})` : idExpr
          parts.push(`SELECT ${modality} AS concept, ${pid} AS pid${date} FROM ${qualify(et)} e WHERE e."${col}" IS NOT NULL${skipDuplicate}${idFilter}`)
        } else {
          parts.push(`SELECT CAST(d."${catCol}" AS VARCHAR) AS concept, ${pid} AS pid${date} FROM ${qualify(et)} e JOIN ${qualify(dict)} d ON e."${col}" = d."${dict.idColumn}" WHERE d."${catCol}" IS NOT NULL${skipDuplicate}${idFilter}`)
        }
      })
    }
  }
  return parts.length ? parts.join('\n  UNION ALL\n  ') : null
}

/**
 * Every concept modality with its patients and records, largest first: the
 * concept variable's 1-way marginal, and where its top N comes from.
 */
export function buildConceptRankQuery(mapping: SchemaMapping, concept: ConceptVariableConfig): string | null {
  const events = eventUnion(mapping, concept, null, false)
  if (!events) return null
  return `SELECT concept, COUNT(DISTINCT pid)::BIGINT AS patients, COUNT(*)::BIGINT AS records FROM (
  ${events}
) _ev
GROUP BY concept
ORDER BY patients DESC, concept`
}

// ---------------------------------------------------------------------------
// Crossings
// ---------------------------------------------------------------------------

export interface CrossingQueryContext {
  mapping: SchemaMapping
  variables: CatalogVariables
  /** Services kept by a top-N grouping, from `buildServiceListQuery`. */
  topServices?: readonly string[]
  /** Concept modalities to restrict to (top N, or one chunk). */
  conceptFilter?: ConceptFilter | null
}

/** Column holding a variable's modality in a crossing query's result. */
export const variableColumn = (v: CatalogVariableId) => `v_${v}`

/**
 * One crossing's non-empty cells: a `v_<variable>` column per variable, then
 * `patients` and `stays` (visits) — or `records` (event rows) when the concept
 * variable is part of it.
 *
 * Without the concept variable a cell counts visits: period and age at the
 * visit's start, the service of the visit or of each of its unit stays. With
 * it, a cell counts events: period and age at the event's date, the service of
 * the stay containing it.
 */
export function buildCrossingQuery(ctx: CrossingQueryContext, vars: readonly CatalogVariableId[]): string | null {
  const { mapping, variables } = ctx
  const pt = mapping.patientTable
  const vt = mapping.visitTable
  if (!pt || !vt) return null
  const crossing = canonicalCrossing(vars)
  if (crossing.length === 0) return null
  const withConcept = crossing.includes('concept')
  const dateExpr = withConcept ? 'ev.edate' : `v."${vt.startDateColumn}"`

  const selects: string[] = []
  const joins: string[] = []
  const needsPatient = crossing.includes('age') || crossing.includes('sex')

  for (const v of crossing) {
    let expr: string | null = null
    if (v === 'concept') {
      expr = 'ev.concept'
    } else if (v === 'period') {
      expr = periodExpr(dateExpr, variables.period?.granularity ?? 'year')
    } else if (v === 'age') {
      expr = ageBucketExpr(mapping, dateExpr, variables.age?.brackets ?? [])
    } else if (v === 'sex') {
      expr = sexExpr(mapping)
    } else if (v === 'service') {
      const cfg = variables.service
      const src = cfg ? serviceSource(mapping, cfg.level) : null
      if (cfg && src) {
        joins.push(withConcept ? src.eventJoin : src.visitJoin)
        expr = serviceGroupingExpr(src.rawExpr, cfg, ctx.topServices ?? [])
      }
    }
    if (!expr) return null
    selects.push(`${expr} AS ${variableColumn(v)}`)
  }

  const patientJoin = `JOIN ${qualify(pt)} p ON p."${pt.idColumn}" = ${withConcept ? 'ev.pid' : `v."${vt.patientIdColumn}"`}`
  const columns = crossing.map(variableColumn)
  const notNull = columns.map((c) => `${c} IS NOT NULL`).join(' AND ')

  if (withConcept) {
    const concept = variables.concept ?? { level: 'concept' as const }
    const events = eventUnion(mapping, concept, ctx.conceptFilter ?? null, true)
    if (!events) return null
    return `WITH ev AS (
  ${events}
),
cells AS (
  SELECT ${selects.join(',\n    ')},
    ev.pid AS pid
  FROM ev
  ${needsPatient ? patientJoin : ''}
  ${joins.join('\n  ')}
)
SELECT ${columns.join(', ')}, COUNT(DISTINCT pid)::BIGINT AS patients, COUNT(*)::BIGINT AS records
FROM cells
WHERE ${notNull}
GROUP BY ${columns.join(', ')}`
  }

  return `WITH cells AS (
  SELECT ${selects.join(',\n    ')},
    v."${vt.patientIdColumn}" AS pid,
    v."${vt.idColumn}" AS vid
  FROM ${qualify(vt)} v
  ${needsPatient ? patientJoin : ''}
  ${joins.join('\n  ')}
  WHERE v."${vt.startDateColumn}" IS NOT NULL
)
SELECT ${columns.join(', ')}, COUNT(DISTINCT pid)::BIGINT AS patients, COUNT(DISTINCT vid)::BIGINT AS stays
FROM cells
WHERE ${notNull}
GROUP BY ${columns.join(', ')}`
}

/**
 * The yield of one crossing at a threshold, without fetching its cells: the
 * non-empty cells, those reaching the threshold, and the patient-cell mass of
 * each. When the period variable is in it, the cells are restricted to the
 * periods the published tables keep (see `trimPeriods`).
 */
export function buildCrossingEstimateQuery(
  ctx: CrossingQueryContext,
  vars: readonly CatalogVariableId[],
  threshold: number,
): string | null {
  const crossing = canonicalCrossing(vars)
  const sql = buildCrossingQuery(ctx, crossing)
  if (!sql) return null
  const t = Math.max(0, Math.floor(threshold))
  let trim = ''
  let where = ''
  if (crossing.includes('period')) {
    const marginal = buildCrossingQuery(ctx, ['period'])
    if (!marginal) return null
    trim = `,\npm AS (\n${marginal}\n),\nrng AS (SELECT MIN(v_period) AS lo, MAX(v_period) AS hi FROM pm WHERE patients >= ${t})`
    where = '\nWHERE v_period BETWEEN (SELECT lo FROM rng) AND (SELECT hi FROM rng)'
  }
  return `WITH x AS (
${sql}
)${trim}
SELECT
  COUNT(*)::BIGINT AS cells,
  COUNT(*) FILTER (WHERE patients >= ${t})::BIGINT AS published,
  COALESCE(SUM(patients), 0)::BIGINT AS mass,
  COALESCE(SUM(patients) FILTER (WHERE patients >= ${t}), 0)::BIGINT AS published_mass
FROM x${where}`
}
