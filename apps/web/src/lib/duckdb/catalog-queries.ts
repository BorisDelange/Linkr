import type { SchemaMapping } from '@/types/schema-mapping'
import { DEFAULT_CATALOG_COUNTS, type CatalogCounts, type CatalogVariableId, type CatalogVariables, type ConceptVariableConfig, type PeriodGranularity, type ServiceVariableConfig } from '@/types/catalog'
import { escSql as esc } from '@/lib/format-helpers'
import { classRelation, conceptRelations, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { fieldColumn } from '@/lib/schema-classes/spec'
import { ageBucketLabels, canonicalCrossing, OTHER_MODALITY } from '@/lib/data-catalog/config'
import { KEY_SPACE, patientKeySql } from '@/lib/data-catalog/perturbation'

/*
 * Every query here reads the class relations (`linkr_patient`, `linkr_visit`…)
 * and their contract columns; the engine injects their definitions. See
 * lib/schema-classes.
 */

const lit = (v: string | number) => (typeof v === 'number' ? String(v) : `'${esc(v)}'`)

/**
 * Resolve a catalog column key (e.g. 'domain_id') to the dictionary relation's
 * column: the category or subcategory when the key names it, or names the source
 * column it is read from, else the extra column declared under that key.
 */
export function resolveDictColumn(mapping: SchemaMapping, rel: ClassRelation, key: string): string | undefined {
  const spec = mapping.concepts?.find((c) => c.key === rel.key)
  for (const column of ['category', 'subcategory'] as const) {
    if (key === column || fieldColumn(spec, column)?.column === key) return column
  }
  return rel.extras?.[key]
}

/** The event relations whose concepts a dictionary names. */
function eventsOf(mapping: SchemaMapping, dict: ClassRelation): ClassRelation[] {
  return eventRelations(mapping).filter((e) => e.dictionary === dict.name)
}

/** An event's instant as a timestamp: `start_datetime` is required by the contract. */
const eventDate = (alias: string) => `CAST(${alias}.start_datetime AS TIMESTAMP)`

/** Event rows as (concept, patient, date), a repeated source concept dropped. */
function eventParts(mapping: SchemaMapping, dict: ClassRelation, range?: PatientRange | null): string[] {
  const parts: string[] = []
  for (const event of eventsOf(mapping, dict)) {
    parts.push(`SELECT e.concept_id AS cid, e.patient_id AS pid, ${eventDate('e')} AS edate FROM ${event.name} e${whereRange('e.patient_id', range)}`)
    // A source column repeating the standard one would count the row twice for that concept.
    if (has(event, 'source_concept_id')) {
      parts.push(`SELECT e.source_concept_id AS cid, e.patient_id AS pid, ${eventDate('e')} AS edate FROM ${event.name} e WHERE e.source_concept_id IS DISTINCT FROM e.concept_id${andRange('e.patient_id', range)}`)
    }
  }
  return parts
}

/** `alias` stays that contain `ev.edate`, from the start to the end of the end day. */
function contains(rel: ClassRelation, alias: string): string {
  const end = has(rel, 'end_datetime') ? `COALESCE(${alias}.end_datetime, ${alias}.start_datetime)` : `${alias}.start_datetime`
  return `ev.edate >= CAST(${alias}.start_datetime AS TIMESTAMP) AND ev.edate < CAST(${end} AS DATE) + INTERVAL 1 DAY`
}

// ---------------------------------------------------------------------------
// Patient ranges
// ---------------------------------------------------------------------------

/**
 * A slice of the patients, `lo <= patient_id < hi` (an open end is absent).
 *
 * A large warehouse is counted one slice at a time: every count the catalog
 * takes — distinct patients, stays, records — adds up exactly across disjoint
 * sets of patients, since a stay and an event belong to one patient. Each query
 * then holds one slice's groups in memory, and a pause loses at most one slice.
 * Ranges rather than a hash, so a warehouse stored in patient order skips the
 * row groups outside the slice.
 */
export interface PatientRange {
  lo?: string | number | bigint
  hi?: string | number | bigint
}

const rangeLit = (v: string | number | bigint) => (typeof v === 'string' ? lit(v) : String(v))

/** `AND`-able conditions putting `column` inside the range; '' for the whole warehouse. */
export function rangeCondition(column: string, range?: PatientRange | null): string {
  if (!range) return ''
  const parts: string[] = []
  if (range.lo != null) parts.push(`${column} >= ${rangeLit(range.lo)}`)
  if (range.hi != null) parts.push(`${column} < ${rangeLit(range.hi)}`)
  return parts.join(' AND ')
}

const andRange = (column: string, range?: PatientRange | null) => {
  const c = rangeCondition(column, range)
  return c ? ` AND ${c}` : ''
}
const whereRange = (column: string, range?: PatientRange | null) => {
  const c = rangeCondition(column, range)
  return c ? ` WHERE ${c}` : ''
}

/** Event rows and patients: whether the warehouse is large enough to be counted in slices. */
export function buildSizeQuery(mapping: SchemaMapping): string | null {
  const patient = classRelation(mapping, 'patient')
  if (!patient) return null
  const events = eventRelations(mapping).map((e) => `(SELECT COUNT(*) FROM ${e.name})`)
  return `SELECT
  (SELECT COUNT(*) FROM ${patient.name})::BIGINT AS patients,
  (${events.length ? events.join(' + ') : '0'})::BIGINT AS event_rows`
}

/** The patient ids cutting the patients into `slices` slices of equal size, in order. */
export function buildPatientBoundsQuery(mapping: SchemaMapping, slices: number): string | null {
  const patient = classRelation(mapping, 'patient')
  if (!patient || slices < 2) return null
  const qs = Array.from({ length: slices - 1 }, (_, i) => ((i + 1) / slices).toFixed(6))
  return `SELECT DISTINCT b FROM (
  SELECT unnest(quantile_disc(patient_id, [${qs.join(', ')}])) AS b FROM ${patient.name} WHERE patient_id IS NOT NULL
) _q
ORDER BY b`
}

// ---------------------------------------------------------------------------
// Concept list (per-concept counts, the Concepts tab)
// ---------------------------------------------------------------------------

/** One dictionary's per-concept counts, for a slice of the patients. */
export interface ConceptCountQuery {
  dictKey: string
  sql: string
}

/**
 * Per dictionary, the patient / record counts of every concept its events
 * use — and visits with `withVisits` — with the concept's name and categories.
 *
 * Concepts are matched with a join on the dictionary, never a literal list of
 * its ids: a full OMOP vocabulary holds millions of them.
 */
export function buildConceptCountQueries(
  mapping: SchemaMapping,
  categoryColumn?: string,
  subcategoryColumn?: string,
  range?: PatientRange | null,
  withVisits = true,
  keySalt?: string,
): ConceptCountQuery[] | null {
  const visit = classRelation(mapping, 'visit')
  if (!visit || !classRelation(mapping, 'patient')) return null

  const queries: ConceptCountQuery[] = []
  for (const dict of conceptRelations(mapping)) {
    const parts = eventParts(mapping, dict, range)
    if (parts.length === 0) continue
    const dictKey = dict.key ?? ''
    const catCol = categoryColumn ? resolveDictColumn(mapping, dict, categoryColumn) : undefined
    const subcatCol = subcategoryColumn ? resolveDictColumn(mapping, dict, subcategoryColumn) : undefined
    const catSelect = `${categoryColumn ? `,\n    ${catCol ? `d."${catCol}"` : 'NULL'} AS concept_category` : ''}${subcategoryColumn ? `,\n    ${subcatCol ? `d."${subcatCol}"` : 'NULL'} AS concept_subcategory` : ''}`
    // Records and patients come from the events alone; a visit counts when one
    // of the concept's events falls within it. Joining every event to all of its
    // patient's visits multiplied the records by the visits.
    const perVisit = withVisits ? `,
per_visit AS (
  SELECT ev.cid, COUNT(DISTINCT v.visit_id)::BIGINT AS visit_count
  FROM events ev
  JOIN ${visit.name} v ON v.patient_id = ev.pid AND ${contains(visit, 'v')}
  GROUP BY ev.cid
)` : ''
    queries.push({
      dictKey,
      sql: `WITH events AS (
  SELECT cid, pid, edate FROM (
    ${parts.join('\n    UNION ALL\n    ')}
  ) _evts
  WHERE cid IN (SELECT concept_id FROM ${dict.name})
),
per_concept AS (
  SELECT cid, SUM(n)::BIGINT AS record_count, COUNT(*)::BIGINT AS patient_count${keySalt ? `, (SUM(${patientKeySql('pid', keySalt)}) % ${KEY_SPACE})::BIGINT AS patient_key` : ''}
  FROM (SELECT cid, pid, COUNT(*) AS n FROM events GROUP BY cid, pid) _cp
  GROUP BY cid
)${perVisit}
SELECT
    pc.cid AS concept_id,
    d.concept_name AS concept_name,
    ${lit(dictKey)} AS dictionary_key${catSelect},
    pc.record_count,
    pc.patient_count${keySalt ? ',\n    pc.patient_key' : ''}${withVisits ? ',\n    COALESCE(pv.visit_count, 0)::BIGINT AS visit_count' : ''}
FROM per_concept pc
JOIN ${dict.name} d ON d.concept_id = pc.cid${withVisits ? '\nLEFT JOIN per_visit pv ON pv.cid = pc.cid' : ''}`,
    })
  }
  return queries.length ? queries : null
}

// ---------------------------------------------------------------------------
// Totals and modality lists
// ---------------------------------------------------------------------------

/**
 * Patients with a visit, visits, and event rows: the catalog's headline
 * figures — and unit stays when counted and mapped.
 */
export function buildTotalsQuery(mapping: SchemaMapping, range?: PatientRange | null, counts: CatalogCounts = DEFAULT_CATALOG_COUNTS, keySalt?: string): string | null {
  const visit = classRelation(mapping, 'visit')
  if (!visit) return null
  const events = eventUnion(mapping, { level: 'concept' }, null, false, range)
  const records = events ? `(SELECT COUNT(*) FROM (\n  ${events}\n) _ev)::BIGINT` : '0::BIGINT'
  const vd = counts.unitStays ? classRelation(mapping, 'visit_detail') : undefined
  const unitStays = vd ? `,\n  (SELECT COUNT(*) FROM ${vd.name} vd${whereRange('vd.patient_id', range)})::BIGINT AS total_unit_stays` : ''
  const key = keySalt
    ? `,\n  (SELECT (SUM(${patientKeySql('pid', keySalt)}) % ${KEY_SPACE})::BIGINT FROM (SELECT DISTINCT patient_id AS pid FROM ${visit.name}${whereRange('patient_id', range)}) _p) AS total_key`
    : ''
  return `SELECT
  COUNT(DISTINCT v.patient_id)::BIGINT AS total_patients,
  COUNT(*)::BIGINT AS total_visits,
  ${records} AS total_records${unitStays}${key}
FROM ${visit.name} v${whereRange('v.patient_id', range)}`
}

/** Every service of the level, with its patients, largest first. */
export function buildServiceListQuery(mapping: SchemaMapping, level: ServiceVariableConfig['level'], range?: PatientRange | null): string | null {
  const svc = serviceSource(mapping, level)
  const visit = classRelation(mapping, 'visit')
  if (!svc || !visit) return null
  return `SELECT svc, COUNT(DISTINCT pid)::BIGINT AS patients FROM (
  SELECT ${svc.rawExpr} AS svc, v.patient_id AS pid
  FROM ${visit.name} v
  ${svc.visitJoin}${whereRange('v.patient_id', range)}
) _s
WHERE svc IS NOT NULL
GROUP BY svc
ORDER BY patients DESC, svc`
}

// ---------------------------------------------------------------------------
// Variable expressions
// ---------------------------------------------------------------------------

/**
 * A period modality, written as its first unit: '2024', '2024-Q1', '2024-03'.
 * With a step, units are numbered from year 0 and grouped by `step`, so
 * two-year periods start on even years whatever the data.
 */
export function periodExpr(dateExpr: string, granularity: PeriodGranularity, step = 1): string {
  const d = `CAST(${dateExpr} AS TIMESTAMP)`
  if (step <= 1) {
    if (granularity === 'year') return `strftime(${d}, '%Y')`
    if (granularity === 'quarter') return `(strftime(${d}, '%Y') || '-Q' || CAST(quarter(${d}) AS VARCHAR))`
    return `strftime(${d}, '%Y-%m')`
  }
  const s = Math.floor(step)
  const unit = granularity === 'year' ? `year(${d})` : granularity === 'quarter' ? `(year(${d}) * 4 + quarter(${d}) - 1)` : `(year(${d}) * 12 + month(${d}) - 1)`
  const b = `(${unit} - (${unit} % ${s}))`
  if (granularity === 'year') return `CAST(${b} AS VARCHAR)`
  if (granularity === 'quarter') return `(CAST(${b} // 4 AS VARCHAR) || '-Q' || CAST(${b} % 4 + 1 AS VARCHAR))`
  return `(CAST(${b} // 12 AS VARCHAR) || '-' || lpad(CAST(${b} % 12 + 1 AS VARCHAR), 2, '0'))`
}

/**
 * Age in whole years at `dateExpr`, from the patient relation aliased `p`: the
 * exact birth date when present, else the birth year (MIMIC-IV leaves every
 * OMOP birth_datetime empty).
 */
function ageYearsExpr(mapping: SchemaMapping, dateExpr: string): string | null {
  const patient = classRelation(mapping, 'patient')
  const d = `CAST(${dateExpr} AS TIMESTAMP)`
  const byYear = has(patient, 'birth_year') ? `(EXTRACT(YEAR FROM ${d}) - p.birth_year)` : null
  const byDate = has(patient, 'birth_date') ? `EXTRACT(YEAR FROM AGE(${d}, CAST(p.birth_date AS TIMESTAMP)))` : null
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

/** The contract's gender is already 'male' / 'female' / 'unknown'. */
export function sexExpr(mapping: SchemaMapping): string | null {
  if (!has(classRelation(mapping, 'patient'), 'gender')) return null
  return `CASE p.gender WHEN 'male' THEN 'male' WHEN 'female' THEN 'female' ELSE 'other' END`
}

interface ServiceSource {
  /** The service name, null when unknown. */
  rawExpr: string
  /** Joins after `FROM linkr_visit v` that bring the service in. */
  visitJoin: string
  /** Joins after the events CTE `ev` that attach each event to the stay containing it. */
  eventJoin: string
}

/**
 * Where a service name comes from at each level.
 *
 * visit_detail: the unit's category first (the ward as the site groups it), then
 * its name, then its raw id. Events carry no dependable stay id across sources,
 * so an event is attached to the stay that contains its date.
 */
function serviceSource(mapping: SchemaMapping, level: ServiceVariableConfig['level']): ServiceSource | null {
  const visit = classRelation(mapping, 'visit')
  if (!visit) return null
  if (level === 'visit_detail') {
    const vd = classRelation(mapping, 'visit_detail')
    if (!vd) return null
    const candidates = (['unit_category', 'unit_name', 'unit_id'] as const).filter((c) => has(vd, c)).map((c) => `vd.${c}`)
    if (candidates.length === 0) return null
    return {
      rawExpr: `COALESCE(${candidates.map((c) => `NULLIF(CAST(${c} AS VARCHAR), '')`).join(', ')})`,
      visitJoin: `JOIN ${vd.name} vd ON vd.visit_id = v.visit_id`,
      eventJoin: `JOIN ${vd.name} vd ON vd.patient_id = ev.pid AND ${contains(vd, 'vd')}`,
    }
  }
  if (!has(visit, 'visit_type')) return null
  return {
    rawExpr: `NULLIF(CAST(v.visit_type AS VARCHAR), '')`,
    visitJoin: '',
    eventJoin: `JOIN ${visit.name} v ON v.patient_id = ev.pid AND ${contains(visit, 'v')}`,
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
 * are several, since ids collide across dictionaries — or its category. An
 * event's source concept adds a row too, unless it repeats the standard one
 * (counting that row twice).
 */
function eventUnion(
  mapping: SchemaMapping,
  concept: Pick<ConceptVariableConfig, 'level' | 'categoryColumn' | 'subcategoryColumn'>,
  filter: ConceptFilter | null,
  withDate: boolean,
  range?: PatientRange | null,
): string | null {
  if (!classRelation(mapping, 'patient')) return null
  const dicts = conceptRelations(mapping)
  const multi = dicts.length > 1
  const parts: string[] = []

  for (const dict of dicts) {
    const dictKey = dict.key ?? ''
    const byLevel = concept.level === 'category' ? concept.categoryColumn : concept.level === 'subcategory' ? concept.subcategoryColumn : undefined
    const catCol = byLevel ? resolveDictColumn(mapping, dict, byLevel) : undefined
    if (concept.level !== 'concept' && !catCol) continue
    const ids = filter?.find((f) => f.dictKey === dictKey)?.ids
    if (filter && !ids?.length) continue

    for (const event of eventsOf(mapping, dict)) {
      const date = withDate ? `, ${eventDate('e')} AS edate` : ''
      const columns = ['concept_id', ...(has(event, 'source_concept_id') ? ['source_concept_id'] : [])]
      columns.forEach((col, i) => {
        const skipDuplicate = i > 0 ? ` AND e.${col} IS DISTINCT FROM e.concept_id` : ''
        const idFilter = (ids ? ` AND e.${col} IN (${ids.map(lit).join(', ')})` : '') + andRange('e.patient_id', range)
        if (concept.level === 'concept') {
          const idExpr = `CAST(e.${col} AS VARCHAR)`
          const modality = multi ? `(${lit(`${dictKey}:`)} || ${idExpr})` : idExpr
          parts.push(`SELECT ${modality} AS concept, e.patient_id AS pid${date} FROM ${event.name} e WHERE e.${col} IS NOT NULL${skipDuplicate}${idFilter}`)
        } else {
          parts.push(`SELECT CAST(d."${catCol}" AS VARCHAR) AS concept, e.patient_id AS pid${date} FROM ${event.name} e JOIN ${dict.name} d ON e.${col} = d.concept_id WHERE d."${catCol}" IS NOT NULL${skipDuplicate}${idFilter}`)
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
export function buildConceptRankQuery(mapping: SchemaMapping, concept: ConceptVariableConfig, range?: PatientRange | null): string | null {
  const events = eventUnion(mapping, concept, null, false, range)
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
  /** The slice of patients to count; absent for all of them. */
  range?: PatientRange | null
  /** What a cell over visits counts beside patients; absent = stays only. */
  counts?: CatalogCounts
  /** Salt of the patient keys (the database id): each cell then carries its key. Absent: no keys. */
  keySalt?: string
}

/** Column holding a variable's modality in a crossing query's result. */
export const variableColumn = (v: CatalogVariableId) => `v_${v}`

/**
 * One crossing's non-empty cells: a `v_<variable>` column per variable, then
 * `patients`, and `stays` (visits) and `unit_stays` as `ctx.counts` asks — and
 * `records` (event rows) when the concept variable is part of it.
 *
 * Without the concept variable a cell counts visits: period and age at the
 * visit's start, the service of the visit or of each of its unit stays; its
 * unit stays are those of its visits (of its unit, with the service). With
 * it, a cell counts events: period and age at the event's date, the service of
 * the stay containing it; its stays are those containing one of its events, as
 * the concept list counts them. They come from a second aggregate, so a stay
 * joined to an event never counts that event's record twice.
 */
export function buildCrossingQuery(ctx: CrossingQueryContext, vars: readonly CatalogVariableId[]): string | null {
  const { mapping, variables } = ctx
  const patient = classRelation(mapping, 'patient')
  const visit = classRelation(mapping, 'visit')
  if (!patient || !visit) return null
  const crossing = canonicalCrossing(vars)
  if (crossing.length === 0) return null
  const withConcept = crossing.includes('concept')
  const counts = ctx.counts ?? DEFAULT_CATALOG_COUNTS
  const dateExpr = withConcept ? 'ev.edate' : 'v.start_datetime'

  const selects: string[] = []
  const joins: string[] = []
  const needsPatient = crossing.includes('age') || crossing.includes('sex')

  for (const v of crossing) {
    let expr: string | null = null
    if (v === 'concept') {
      expr = 'ev.concept'
    } else if (v === 'period') {
      expr = periodExpr(dateExpr, variables.period?.granularity ?? 'year', variables.period?.step ?? 1)
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

  const patientJoin = `JOIN ${patient.name} p ON p.patient_id = ${withConcept ? 'ev.pid' : 'v.patient_id'}`
  const columns = crossing.map(variableColumn)
  const notNull = columns.map((c) => `${c} IS NOT NULL`).join(' AND ')

  if (withConcept) {
    const concept = variables.concept ?? { level: 'concept' as const }
    const events = eventUnion(mapping, concept, ctx.conceptFilter ?? null, true, ctx.range)
    if (!events) return null
    const counted = `WITH ev AS (
  ${events}
),
cells AS (
  SELECT ${selects.join(',\n    ')},
    ev.pid AS pid, ev.edate AS edate
  FROM ev
  ${needsPatient ? patientJoin : ''}
  ${joins.join('\n  ')}
)`
    const stayJoins: string[] = []
    const stayCounts: string[] = []
    if (counts.visits) {
      stayJoins.push(`LEFT JOIN ${visit.name} sv ON sv.patient_id = ev.pid AND ${contains(visit, 'sv')}`)
      stayCounts.push('COUNT(DISTINCT sv.visit_id)::BIGINT AS stays')
    }
    const vd = counts.unitStays ? classRelation(mapping, 'visit_detail') : undefined
    if (vd) {
      stayJoins.push(`LEFT JOIN ${vd.name} su ON su.patient_id = ev.pid AND ${contains(vd, 'su')}`)
      stayCounts.push('COUNT(DISTINCT su.visit_detail_id)::BIGINT AS unit_stays')
    }
    // One row per (cell, patient) first: the patients are its rows, the records
    // their counts, and each patient's key is hashed once, not once per event.
    const key = ctx.keySalt ? `, (SUM(${patientKeySql('pid', ctx.keySalt)}) % ${KEY_SPACE})::BIGINT AS cell_key` : ''
    const perCell = `SELECT ${columns.join(', ')}, COUNT(*)::BIGINT AS patients, SUM(n)::BIGINT AS records${key}
FROM (
  SELECT ${columns.join(', ')}, pid, COUNT(*) AS n
  FROM cells
  WHERE ${notNull}
  GROUP BY ${columns.join(', ')}, pid
) _pc
GROUP BY ${columns.join(', ')}`
    if (stayCounts.length === 0) return `${counted}\n${perCell}`
    const stayColumns = [...(counts.visits ? ['stays'] : []), ...(vd ? ['unit_stays'] : [])]
    return `${counted},
per_cell AS (
${perCell}
),
per_stay AS (
  SELECT ${columns.map((c) => `ev.${c}`).join(', ')}, ${stayCounts.join(', ')}
  FROM cells ev
  ${stayJoins.join('\n  ')}
  WHERE ${columns.map((c) => `ev.${c} IS NOT NULL`).join(' AND ')}
  GROUP BY ${columns.map((c) => `ev.${c}`).join(', ')}
)
SELECT pc.*, ${stayColumns.map((m) => `COALESCE(ps.${m}, 0)::BIGINT AS ${m}`).join(', ')}
FROM per_cell pc
LEFT JOIN per_stay ps ON ${columns.map((c) => `ps.${c} = pc.${c}`).join(' AND ')}`
  }

  const measures = ['COUNT(DISTINCT pid)::BIGINT AS patients']
  const ids = ['v.patient_id AS pid']
  if (counts.visits) {
    ids.push('v.visit_id AS vid')
    measures.push('COUNT(DISTINCT vid)::BIGINT AS stays')
  }
  const vd = counts.unitStays ? classRelation(mapping, 'visit_detail') : undefined
  if (vd) {
    // The service of a unit-level crossing already joined the unit stays.
    const unitJoined = crossing.includes('service') && variables.service?.level === 'visit_detail'
    if (!unitJoined) joins.push(`LEFT JOIN ${vd.name} uvd ON uvd.visit_id = v.visit_id`)
    ids.push(`${unitJoined ? 'vd' : 'uvd'}.visit_detail_id AS uid`)
    measures.push('COUNT(DISTINCT uid)::BIGINT AS unit_stays')
  }
  const cells = `WITH cells AS (
  SELECT ${selects.join(',\n    ')},
    ${ids.join(',\n    ')}
  FROM ${visit.name} v
  ${needsPatient ? patientJoin : ''}
  ${joins.join('\n  ')}
  WHERE v.start_datetime IS NOT NULL${andRange('v.patient_id', ctx.range)}
)`
  const perCell = `SELECT ${columns.join(', ')}, ${measures.join(', ')}
FROM cells
WHERE ${notNull}
GROUP BY ${columns.join(', ')}`
  if (!ctx.keySalt) return `${cells}\n${perCell}`
  return `${cells},
per_cell AS (
${perCell}
),
keyed AS (
  SELECT ${columns.join(', ')}, (SUM(${patientKeySql('pid', ctx.keySalt)}) % ${KEY_SPACE})::BIGINT AS cell_key
  FROM (SELECT DISTINCT ${columns.join(', ')}, pid FROM cells WHERE ${notNull}) _pc
  GROUP BY ${columns.join(', ')}
)
SELECT pc.*, k.cell_key
FROM per_cell pc
JOIN keyed k ON ${columns.map((c) => `k.${c} = pc.${c}`).join(' AND ')}`
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
  // The yield is about patients: no distinct count of stays to pay for.
  ctx = { ...ctx, counts: { visits: false, unitStays: false } }
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
