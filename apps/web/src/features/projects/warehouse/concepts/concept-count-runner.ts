/**
 * Runs the concept list's counts for a database, unit by unit (see
 * `concept-count-plan.ts`): one run per database whoever starts it, kept going
 * while its tab is not shown. Each step — the rows, then the patients — is one
 * server query job (`lib/api/query-jobs.ts`), so no request outlasts a
 * gateway's timeout, the units never run beside another heavy query, and a
 * closed tab leaves the job counting: the next start follows it. A pause
 * cancels the job, which interrupts the unit in flight.
 *
 * The list is re-assembled by the job itself, between two units — at the end of
 * the rows (it is usable from then on), up to `ASSEMBLIES_PER_STEP` times while
 * patients are counted, and at the end — and by the run on a pause.
 */

import type { SchemaMapping } from '@/types/schema-mapping'
import i18n from '@/lib/i18n'
import { localized } from '@/lib/localized'
import { queryDataSource, sourceTables } from '@/lib/duckdb/engine'
import { planSlices, type SerializedRange } from '@/lib/duckdb/catalog-compute'
import { classRelation, conceptRelations } from '@/lib/schema-classes/relations'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { createRunRegistry, type RunSnapshotBase } from '@/lib/run-registry'
import { followQueryJob, getJob } from '@/lib/api/query-jobs'
import { useDataSourceStore } from '@/stores/data-source-store'
import {
  assembleConceptCache,
  getConceptCacheStatus,
  startConceptRun,
  startConceptUnitsJob,
} from '@/lib/api/concept-cache'
import { buildConceptsAssembleQuery, computeAvailableColumns } from './concept-queries'
import {
  CONCEPT_COUNT_VERSION,
  CONCEPT_SLICE_ROWS,
  conceptCountSignature,
  findConceptIdTypeMismatches,
  planConceptCountUnits,
  stepJobItems,
  ASSEMBLE_PREFIX,
  type ConceptCountManifest,
  type ConceptCountStep,
  type ConceptCountStepProgress,
  type ConceptCountUnit,
} from './concept-count-plan'

export type ConceptCountPhase = 'planning' | 'records' | 'patients' | 'assembling'

export interface ConceptCountSnapshot extends RunSnapshotBase {
  phase: ConceptCountPhase | null
  records: ConceptCountStepProgress
  patients: ConceptCountStepProgress
  /** When the step under way began (epoch ms). */
  phaseStartedAt: number | null
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
  /** Stop once the rows are counted, as a pause would: the patients are left
   *  for a later start, which resumes there. */
  recordsOnly?: boolean
}

/** The job a step runs in, kept in the manifest so a later start follows it. */
interface StepJob {
  id: string
  step: ConceptCountStep
  keys: string[]
}

type RunManifest = ConceptCountManifest & { job?: StepJob }

const ENDED = new Set(['done', 'error', 'cancelled'])

const IDLE: ConceptCountSnapshot = {
  running: false,
  error: null,
  phase: null,
  records: { done: 0, total: 0 },
  patients: { done: 0, total: 0 },
  phaseStartedAt: null,
  reading: null,
  assembled: 0,
}

/** The stored run's units if it can be resumed, re-planned over its own slices. */
function resumable(manifest: Partial<ConceptCountManifest> | undefined, mapping: SchemaMapping, tables: readonly string[] | null): ConceptCountUnit[] | null {
  if (!manifest || !manifest.runId || manifest.finishedAt || manifest.version !== CONCEPT_COUNT_VERSION || !Array.isArray(manifest.slices)) return null
  const units = planConceptCountUnits(mapping, manifest.slices)
  return conceptCountSignature(units, mapping, tables) === manifest.signature ? units : null
}

async function plan(dataSourceId: string, mapping: SchemaMapping, signal: AbortSignal): Promise<SerializedRange[]> {
  // Without a patient table there is nothing to cut the patients by.
  if (!classRelation(mapping, 'patient')) return [{}]
  return planSlices(
    mapping,
    (sql, s) => queryDataSource(dataSourceId, sql, { signal: s, allRows: true }),
    signal,
    CONCEPT_SLICE_ROWS,
  )
}

/** Refuses a mapping whose event and dictionary ids cannot be joined, before
 *  any unit runs — rather than fail on DuckDB's cast deep into the run. */
async function checkConceptIdTypes(dataSourceId: string, mapping: SchemaMapping, signal: AbortSignal): Promise<void> {
  const mismatches = await findConceptIdTypeMismatches(mapping, (sql) => queryDataSource(dataSourceId, sql, { signal }))
  if (!mismatches.length) return
  throw new Error(mismatches.map((m) => i18n.t('concepts.count_id_type_mismatch', { ...m })).join(' '))
}

async function execute(
  { dataSourceId, mapping, restart, recordsOnly }: ConceptCountInput,
  signal: AbortSignal,
  emit: (patch: Partial<ConceptCountSnapshot>, immediate?: boolean) => void,
): Promise<void> {
  emit({ phase: 'planning', phaseStartedAt: Date.now() }, true)
  await checkConceptIdTypes(dataSourceId, mapping, signal)
  const status = await getConceptCacheStatus(dataSourceId)
  // Units run on the server as sent, outside queryDataSource: the relations go
  // with them, emptied where the database lacks their table.
  const tables = await sourceTables(dataSourceId)

  let units = restart ? null : resumable(status.run?.manifest, mapping, tables)
  let manifest: RunManifest
  const done = new Set<string>()
  // Units counted since the list was last assembled.
  let unassembled = false
  if (units && status.run) {
    manifest = status.run.manifest as RunManifest
    for (const key of status.run.doneUnits) done.add(key)
    unassembled = status.run.lastUnitAt != null && (status.refreshedAt == null || status.run.lastUnitAt > status.refreshedAt)
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
    await startConceptRun(dataSourceId, manifest, true)
  }
  const all = units

  const count = (step: ConceptCountStep) => {
    const of = all.filter((u) => u.step === step)
    return { done: of.filter((u) => done.has(u.key)).length, total: of.length }
  }
  const complete = () => all.every((u) => done.has(u.key))
  const assembleSql = (recordsComplete: boolean, patientsComplete: boolean) => {
    const sql = buildConceptsAssembleQuery(mapping, computeAvailableColumns(conceptRelations(mapping)), { recordsComplete, patientsComplete })
    if (!sql) throw new Error('no_concept_table')
    return withClassRelations(sql, mapping, tables)
  }
  let assembled = 0
  const assemble = async () => {
    const records = count('records')
    const patients = count('patients')
    await assembleConceptCache(dataSourceId, assembleSql(records.done === records.total, patients.done === patients.total))
    unassembled = false
    emit({ assembled: ++assembled }, true)
  }

  const source = useDataSourceStore.getState().dataSources.find((d) => d.id === dataSourceId)
  const name = source ? localized(source.name, i18n.language) : dataSourceId
  /** Follow a step's job until it ends; whether it counted every key. */
  const follow = async (job: StepJob): Promise<{ finished: boolean; cancelled: boolean; error: string | null }> => {
    const outcome = await followQueryJob(dataSourceId, job.id, job.keys, async (i) => {
      const key = job.keys[i]
      if (key.startsWith(ASSEMBLE_PREFIX)) {
        unassembled = false
        emit({ assembled: ++assembled }, true)
        return
      }
      done.add(key)
      unassembled = true
      emit({ records: count('records'), patients: count('patients'), reading: null })
    }, {
      signal,
      fetchRows: false,
      onWaiting: (i, reading) => {
        const phase = job.keys[i].startsWith(ASSEMBLE_PREFIX) ? 'assembling' : job.step
        emit({ phase, reading }, phase === 'assembling')
      },
    })
    return { finished: outcome.delivered === job.keys.length, cancelled: outcome.status === 'cancelled', error: outcome.error }
  }

  emit({ records: count('records'), patients: count('patients') }, true)
  try {
    // A job a closed tab left counting: take what it did, and the rest if it runs on.
    // One already stopped (by the pause this start resumes from) is simply over;
    // only a cancel from the jobs panel while it is followed is a pause.
    if (manifest.job) {
      emit({ phase: manifest.job.step, phaseStartedAt: Date.now(), reading: null }, true)
      try {
        const live = !ENDED.has((await getJob(manifest.job.id)).status)
        const { cancelled } = await follow(manifest.job)
        if (cancelled && live) return
      } catch (err) {
        // Gone (cleared from the panel): the units it wrote are counted all the same.
        if (signal.aborted) throw err
      }
    }

    for (const step of ['records', 'patients'] as const) {
      const todo = all.filter((u) => u.step === step && !done.has(u.key))
      if (!todo.length) continue
      if (recordsOnly && step === 'patients') break
      signal.throwIfAborted()
      emit({ phase: step, phaseStartedAt: Date.now(), reading: null }, true)
      const items = stepJobItems(step, todo.map((u) => ({ key: u.key, sql: withClassRelations(u.sql, mapping, tables) })), (final) =>
        step === 'records'
          ? assembleSql(final, count('patients').done === count('patients').total)
          : assembleSql(true, final))
      const label = i18n.t(`concepts.count_job_${step}`, { name })
      const started = await startConceptUnitsJob(dataSourceId, label, manifest.runId, items)
      const job: StepJob = { id: started.id, step, keys: items.map((it) => it.key) }
      manifest = { ...manifest, job }
      await startConceptRun(dataSourceId, manifest, false)
      const { finished, cancelled, error } = await follow(job)
      // Cancelled from the jobs panel: a pause.
      if (cancelled) return
      if (!finished) throw new Error(error ?? 'the counting job ended early')
    }
  } catch (err) {
    if (!signal.aborted) throw err
    return
  } finally {
    // Stopped short — a pause, a cancel, a failure: what was counted stays visible.
    if (unassembled && !complete()) {
      emit({ phase: 'assembling', reading: null }, true)
      try { await assemble() } catch { /* the next run assembles it */ }
    }
  }

  if (!complete()) return
  // Cut between the last unit and the job's own assembly.
  if (unassembled) {
    emit({ phase: 'assembling', reading: null }, true)
    await assemble()
  }
  const finished: RunManifest = { ...manifest, finishedAt: new Date().toISOString() }
  delete finished.job
  await startConceptRun(dataSourceId, finished, false)
}

const registry = createRunRegistry<ConceptCountInput, ConceptCountSnapshot>({
  idle: IDLE,
  execute,
})

export const getConceptCountRun = registry.get
export const watchConceptCountRun = registry.watch
export const pauseConceptCount = registry.pause
export const clearConceptCountError = registry.clearError

export function startConceptCount(input: ConceptCountInput): void {
  registry.clearError(input.dataSourceId)
  registry.start(input.dataSourceId, input)
}
