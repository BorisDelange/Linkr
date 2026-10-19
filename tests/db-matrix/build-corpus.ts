/**
 * Writes the SQL the app itself sends to a database, for the database matrix
 * (README.md): the real query builders, run on the test database's own mapping,
 * with the class relations injected as `queryDataSource` injects them. The
 * matrix then runs every query on every engine and compares the answers.
 *
 *   npx tsx --tsconfig tests/db-matrix/tsconfig.json tests/db-matrix/build-corpus.ts \
 *     <mapping.json> <facts.json> <corpus.json>
 *
 * `facts.json` (written by matrix.py from the data) names what a query needs
 * from the data: the tables, one patient with a visit and a stay, frequent
 * concepts per event table.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import { withClassRelations } from '@/lib/schema-classes/inject'
import {
  buildNotesQuery,
  buildPatientCountQuery,
  buildPatientDemographicsQuery,
  buildPatientListQuery,
  buildPatientSummaryQuery,
  buildPatientVisitSummaryQuery,
  buildTimelineQuery,
  buildVisitDetailListQuery,
  buildVisitListQuery,
} from '@/lib/duckdb/patient-data-queries'
import {
  buildOverviewDeathQuery,
  buildOverviewDensityQuery,
  buildOverviewEventsQuery,
  buildOverviewInventoryQuery,
  buildOverviewUnitStaysQuery,
} from '@/lib/duckdb/patient-overview-queries'
import { NO_SCOPE } from '@/lib/duckdb/patient-scope'
import { buildAttritionQueries, buildCohortCountSql, buildCohortResultsSql } from '@/lib/duckdb/cohort-query'
import {
  buildConceptCountQueries,
  buildConceptRankQuery,
  buildPatientBoundsQuery,
  buildServiceListQuery,
  buildSizeQuery,
  buildTotalsQuery,
} from '@/lib/duckdb/catalog-queries'
import { planConceptCountUnits } from '@/features/projects/warehouse/concepts/concept-count-plan'
import type { Cohort, CohortLevel, SchemaMapping } from '@/types'

interface Facts {
  tables: string[]
  patientId: string
  visitId: string
  visitDetailId: string | null
  /** The patient's first and last event, ISO, for the overview's time window. */
  from: string
  to: string
  /** Event-table label → its most frequent concept ids. */
  concepts: Record<string, number[]>
  /** Patient-id bounds cutting the patients in two, for a sliced count. */
  midPatientId: string | number
}

export interface CorpusQuery {
  key: string
  /** Builder the SQL comes from, so a failure points at the code. */
  source: string
  sql: string
  /** The rows are in a defined order: compare them in order, not as a set. */
  ordered: boolean
}

const [mappingPath, factsPath, outPath] = process.argv.slice(2)
if (!mappingPath || !factsPath || !outPath) {
  console.error('usage: build-corpus.ts <mapping.json> <facts.json> <corpus.json>')
  process.exit(2)
}

const mapping = sanitizeSchemaMapping(JSON.parse(readFileSync(mappingPath, 'utf8'))) as SchemaMapping
const facts = JSON.parse(readFileSync(factsPath, 'utf8')) as Facts
const queries: CorpusQuery[] = []

function add(key: string, source: string, sql: string | null | undefined, ordered = false) {
  if (!sql) throw new Error(`${source} built no SQL for ${key}: the mapping or the facts do not fit it`)
  queries.push({ key, source, sql: withClassRelations(sql, mapping, facts.tables), ordered })
}

function cohort(level: CohortLevel, children: unknown[]): Cohort {
  return {
    id: 'matrix', projectUid: 'matrix', name: { en: 'Matrix' }, description: {}, level,
    criteriaTree: { kind: 'group', id: 'root', operator: 'AND', children, exclude: false, enabled: true },
    schemaVersion: 4, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  } as unknown as Cohort
}

const [firstLabel, firstConcepts] = Object.entries(facts.concepts)[0] ?? []
if (!firstLabel || !firstConcepts?.length) throw new Error('facts.concepts names no event table with concepts')
const allConcepts = Object.values(facts.concepts).flat()
const conceptCriterion = (label: string, ids: number[]) => ({
  kind: 'criterion', id: `c-${label}`, type: 'concept', enabled: true, operator: 'AND', exclude: false,
  config: { eventTableLabel: label, conceptIds: ids, conceptNames: {} },
})
const ageCriterion = { kind: 'criterion', id: 'age', type: 'age', enabled: true, operator: 'AND', exclude: false, config: { ageReference: 'admission', min: 50 } }

// ── Patient data ──────────────────────────────────────────────────────────────
add('patients.list', 'buildPatientListQuery', buildPatientListQuery(mapping, null, 50, 0), true)
add('patients.count', 'buildPatientCountQuery', buildPatientCountQuery(mapping, null))
add('patient.visits', 'buildVisitListQuery', buildVisitListQuery(mapping, facts.patientId))
add('patient.stays', 'buildVisitDetailListQuery', buildVisitDetailListQuery(mapping, facts.visitId))
add('patient.demographics', 'buildPatientDemographicsQuery', buildPatientDemographicsQuery(mapping, facts.patientId))
add('patient.summary', 'buildPatientSummaryQuery', buildPatientSummaryQuery(mapping, facts.patientId))
add('patient.visit-summary', 'buildPatientVisitSummaryQuery', buildPatientVisitSummaryQuery(mapping, facts.patientId))
add('patient.timeline', 'buildTimelineQuery', buildTimelineQuery(mapping, allConcepts, facts.patientId, NO_SCOPE))
add('patient.notes', 'buildNotesQuery', buildNotesQuery(mapping, facts.patientId, NO_SCOPE))

// ── Patient overview ──────────────────────────────────────────────────────────
add('overview.inventory', 'buildOverviewInventoryQuery', buildOverviewInventoryQuery(mapping, facts.patientId, NO_SCOPE))
add('overview.density', 'buildOverviewDensityQuery', buildOverviewDensityQuery(
  mapping, facts.patientId, NO_SCOPE, facts.from, facts.to, 40,
  Object.keys(facts.concepts).map((table) => ({ key: table, table, conceptIds: [] })) as never,
))
add('overview.events', 'buildOverviewEventsQuery', buildOverviewEventsQuery(
  mapping, facts.patientId, NO_SCOPE, firstLabel, firstConcepts.map(String), facts.from, facts.to, 500,
))
add('overview.unit-stays', 'buildOverviewUnitStaysQuery', buildOverviewUnitStaysQuery(mapping, facts.patientId, null))
const death = buildOverviewDeathQuery(mapping, facts.patientId)
if (death) add('overview.death', 'buildOverviewDeathQuery', death)

// ── Cohorts ───────────────────────────────────────────────────────────────────
const conceptCohort = cohort('patient', [conceptCriterion(firstLabel, firstConcepts)])
const mixedCohort = cohort('visit', [ageCriterion, conceptCriterion(firstLabel, firstConcepts.slice(0, 2))])
add('cohort.concept.count', 'buildCohortCountSql', buildCohortCountSql(conceptCohort, mapping))
add('cohort.concept.results', 'buildCohortResultsSql', buildCohortResultsSql(conceptCohort, mapping, 1000, 0))
add('cohort.visit-age-concept.count', 'buildCohortCountSql', buildCohortCountSql(mixedCohort, mapping))
buildAttritionQueries(mixedCohort, mapping, { withPatients: true }).forEach((q, i) => add(`cohort.attrition.${i}`, 'buildAttritionQueries', q.sql))

// ── Concept counts (the Concepts page) ────────────────────────────────────────
planConceptCountUnits(mapping, [{ hi: facts.midPatientId }, { lo: facts.midPatientId }])
  .forEach((unit) => add(`concept-counts.${unit.key}`, 'planConceptCountUnits', unit.sql))

// ── Data catalog ──────────────────────────────────────────────────────────────
add('catalog.size', 'buildSizeQuery', buildSizeQuery(mapping, facts.tables))
add('catalog.patient-bounds', 'buildPatientBoundsQuery', buildPatientBoundsQuery(mapping, 4), true)
add('catalog.totals', 'buildTotalsQuery', buildTotalsQuery(mapping))
add('catalog.services.visit', 'buildServiceListQuery', buildServiceListQuery(mapping, 'visit'))
add('catalog.services.stay', 'buildServiceListQuery', buildServiceListQuery(mapping, 'visit_detail'))
add('catalog.concept-rank', 'buildConceptRankQuery', buildConceptRankQuery(mapping, { enabled: true, level: 'concept' } as never))
;(buildConceptCountQueries(mapping, 'domain_id', 'concept_class_id') ?? [])
  .forEach((q) => add(`catalog.concept-counts.${q.dictKey}`, 'buildConceptCountQueries', q.sql))

writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), queries }, null, 1))
console.log(`  corpus: ${queries.length} queries → ${outPath}`)
