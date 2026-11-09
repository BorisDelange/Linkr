/**
 * Plans a database's concept counts for its server run (services/concept_runs):
 * the id types checked, the patients sliced, the run's manifest stored, and the
 * units still to count handed over with the SQL that assembles the list between
 * them (see `concept-count-plan.ts`). The server counts them, then computes the
 * statistics; the page only reads where it is (`use-concept-run.ts`).
 */

import type { SchemaMapping } from '@/types/schema-mapping'
import i18n from '@/lib/i18n'
import { localized } from '@/lib/localized'
import { queryDataSource, sourceTables } from '@/lib/duckdb/engine'
import { planSlices, type SerializedRange } from '@/lib/duckdb/catalog-compute'
import { classRelation, conceptRelations } from '@/lib/schema-classes/relations'
import { withClassRelations } from '@/lib/schema-classes/inject'
import type { RunSnapshotBase } from '@/lib/run-registry'
import type { JobGroup } from '@/lib/duckdb/query-log'
import type { RunCountSpec } from '@/lib/concept-mapping/run-spec'
import { cancelJob } from '@/lib/api/environments'
import { useDataSourceStore } from '@/stores/data-source-store'
import { getConceptCacheStatus, startConceptRun } from '@/lib/api/concept-cache'
import { buildConceptsAssembleQuery, computeAvailableColumns } from './concept-queries'
import {
  CONCEPT_COUNT_VERSION,
  CONCEPT_SLICE_ROWS,
  conceptCountSignature,
  findConceptIdTypeMismatches,
  planConceptCountUnits,
  resumable,
  stepJobItems,
  type ConceptCountManifest,
  type ConceptCountStep,
  type ConceptCountStepProgress,
  type ConceptCountUnit,
} from './concept-count-plan'

export type ConceptCountPhase = 'planning' | ConceptCountStep | 'assembling'

/** What planning is on: the id types check, the database's size and its patient
 *  slices, the run's registration. */
export type ConceptCountPlanningStep = 'ids' | 'size' | 'save'

export interface ConceptCountSnapshot extends RunSnapshotBase {
  phase: ConceptCountPhase | null
  records: ConceptCountStepProgress
  patients: ConceptCountStepProgress
  /** When the step under way began (epoch ms). */
  phaseStartedAt: number | null
  planningStep: ConceptCountPlanningStep | null
  /** Percent of its data the unit in flight has read, when the database can tell. */
  reading: number | null
  /** Bumped at each assembly, so a watching list reloads. */
  assembled: number
}

export interface ConceptCountInput {
  dataSourceId: string
  mapping: SchemaMapping
  /** Drop the units already counted instead of resuming. */
  restart: boolean
  /** The steps to run now; one left out waits for a later start, which
   *  resumes there. None loads the dictionary alone. */
  steps: readonly ConceptCountStep[]
  /** The statistics asked to follow the counts (`fresh`: from scratch), kept
   *  in the manifest as what the run was asked for. */
  stats: { fresh: boolean } | null
}

/** What the run was asked for, beyond the steps of its manifest. */
export interface ConceptCountAsked {
  steps: ConceptCountStep[]
  stats: { fresh: boolean } | null
}

/** The job a step ran in, which a manifest the browser stored before the
 *  server ran the counts still names: a restart stops it. */
interface StepJob {
  id: string
  step: ConceptCountStep
  keys: string[]
}

export type RunManifest = ConceptCountManifest & { job?: StepJob; asked?: ConceptCountAsked }

/** No count going on. */
export const IDLE_COUNT: ConceptCountSnapshot = {
  running: false,
  error: null,
  phase: null,
  records: { done: 0, total: 0 },
  patients: { done: 0, total: 0 },
  phaseStartedAt: null,
  planningStep: null,
  reading: null,
  assembled: 0,
}

/**
 * The jobs panel's row for a database's concepts: the counts, the statistics
 * (use-concept-profiles) and every query they send, whichever run sent them.
 */
export function conceptsJobGroup(dataSourceId: string): JobGroup {
  const source = useDataSourceStore.getState().dataSources.find((d) => d.id === dataSourceId)
  const name = source ? localized(source.name, i18n.language) : dataSourceId
  return { key: `concepts:${dataSourceId}`, label: i18n.t('concepts.job_group', { name }) }
}

async function plan(dataSourceId: string, mapping: SchemaMapping, signal: AbortSignal): Promise<SerializedRange[]> {
  // Without a patient table there is nothing to cut the patients by.
  if (!classRelation(mapping, 'patient')) return [{}]
  const group = conceptsJobGroup(dataSourceId)
  return planSlices(
    mapping,
    (sql, s) => queryDataSource(dataSourceId, sql, { signal: s, allRows: true, origin: 'Concepts · count records per concept', group }),
    signal,
    CONCEPT_SLICE_ROWS,
    await sourceTables(dataSourceId),
  )
}

/** Refuses a mapping whose event and dictionary ids cannot be joined, before
 *  any unit runs — rather than fail on DuckDB's cast deep into the run. */
async function checkConceptIdTypes(dataSourceId: string, mapping: SchemaMapping, signal: AbortSignal): Promise<void> {
  const mismatches = await findConceptIdTypeMismatches(mapping, (sql) => queryDataSource(dataSourceId, sql, { signal, origin: 'Concepts · check concept id types', group: conceptsJobGroup(dataSourceId) }))
  if (!mismatches.length) return
  throw new Error(mismatches.map((m) => i18n.t('concepts.count_id_type_mismatch', { ...m })).join(' '))
}

/**
 * Server mode: what the server run counts (`RunCountSpec`), planned here — the
 * id types checked, the patients sliced, the manifest stored — for the units of
 * `steps` still to count; the server then counts them, assembling the list as it
 * goes, and the statistics after (services/concept_runs).
 */
export async function prepareCountSpec(
  { dataSourceId, mapping, restart, steps, stats }: ConceptCountInput,
  signal: AbortSignal,
): Promise<RunCountSpec> {
  await checkConceptIdTypes(dataSourceId, mapping, signal)
  const status = await getConceptCacheStatus(dataSourceId)
  const tables = await sourceTables(dataSourceId)
  const left = (status.run?.manifest as RunManifest | undefined)?.job
  if (restart && left) await cancelJob(left.id).catch(() => {})
  let units = restart ? null : resumable(status.run?.manifest, mapping, tables)
  const resuming = !!units && !!status.run
  let manifest: RunManifest
  const done = new Set<string>()
  if (units && status.run) {
    manifest = status.run.manifest as RunManifest
    for (const key of status.run.doneUnits) done.add(key)
  } else {
    const slices = await plan(dataSourceId, mapping, signal)
    units = planConceptCountUnits(mapping, slices)
    manifest = {
      runId: crypto.randomUUID(),
      version: CONCEPT_COUNT_VERSION,
      signature: conceptCountSignature(units, mapping, tables),
      slices,
      units: units.map(({ key, step }) => ({ key, step })),
      startedAt: new Date().toISOString(),
    }
  }
  delete manifest.job
  manifest = { ...manifest, asked: { steps: [...steps], stats } }
  await startConceptRun(dataSourceId, manifest, !resuming)
  return countSpecOf(mapping, tables, manifest.runId, units, done, steps)
}

/** The units of `steps` not yet `done`, with the assemblies between them and at
 *  the end (`stepJobItems`): what the server counts. */
export function countSpecOf(
  mapping: SchemaMapping,
  tables: readonly string[] | null,
  runId: string,
  units: readonly ConceptCountUnit[],
  done: ReadonlySet<string>,
  steps: readonly ConceptCountStep[],
): RunCountSpec {
  const counted = (step: ConceptCountStep) => units.every((u) => u.step !== step || done.has(u.key))
  const complete = (step: ConceptCountStep) => counted(step) || steps.includes(step)
  const assembleSql = (recordsComplete: boolean, patientsComplete: boolean) => {
    const sql = buildConceptsAssembleQuery(mapping, computeAvailableColumns(conceptRelations(mapping)), { recordsComplete, patientsComplete })
    if (!sql) throw new Error('no_concept_table')
    return withClassRelations(sql, mapping, tables)
  }
  const sqlOf = (u: ConceptCountUnit) => ({ key: u.key, sql: withClassRelations(u.sql, mapping, tables) })
  return {
    runId,
    steps: (['records', 'patients'] as const)
      .filter((step) => steps.includes(step))
      .map((step) => ({
        step,
        items: stepJobItems(step, units.filter((u) => u.step === step && !done.has(u.key)).map(sqlOf), (final) =>
          step === 'records' ? assembleSql(final, counted('patients')) : assembleSql(complete('records'), final)),
      }))
      .filter((s) => s.items.length > 0),
    finalAssembleSql: assembleSql(complete('records'), complete('patients')),
  }
}
