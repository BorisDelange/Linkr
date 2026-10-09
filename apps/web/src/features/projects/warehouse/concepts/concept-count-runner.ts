/**
 * Runs the concept list's counts for a database, unit by unit (see
 * `concept-count-plan.ts`), in the browser like the data catalog: one run per
 * database whoever starts it, kept going while its tab is not shown, stopped
 * by a pause — which interrupts the unit in flight on the server.
 *
 * The list is re-assembled when the `records` step ends (it is usable from
 * then on), every `ASSEMBLE_EVERY_MS` while patients are counted, on pause and
 * at the end.
 */

import type { SchemaMapping } from '@/types/schema-mapping'
import i18n from '@/lib/i18n'
import { queryDataSource, sourceTables } from '@/lib/duckdb/engine'
import { planSlices, type SerializedRange } from '@/lib/duckdb/catalog-compute'
import { classRelation, conceptRelations } from '@/lib/schema-classes/relations'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { createRunRegistry, type RunSnapshotBase } from '@/lib/run-registry'
import {
  assembleConceptCache,
  getConceptCacheStatus,
  startConceptRun,
  writeConceptUnit,
} from '@/lib/api/concept-cache'
import { buildConceptsAssembleQuery, computeAvailableColumns } from './concept-queries'
import {
  CONCEPT_COUNT_VERSION,
  CONCEPT_SLICE_ROWS,
  conceptCountSignature,
  findConceptIdTypeMismatches,
  planConceptCountUnits,
  type ConceptCountManifest,
  type ConceptCountStepProgress,
  type ConceptCountUnit,
} from './concept-count-plan'

/** Shortest gap between two re-assemblies of the list while patients are counted. */
const ASSEMBLE_EVERY_MS = 30_000

export type ConceptCountPhase = 'planning' | 'records' | 'patients' | 'assembling'

export interface ConceptCountSnapshot extends RunSnapshotBase {
  phase: ConceptCountPhase | null
  records: ConceptCountStepProgress
  patients: ConceptCountStepProgress
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

const IDLE: ConceptCountSnapshot = {
  running: false,
  error: null,
  phase: null,
  records: { done: 0, total: 0 },
  patients: { done: 0, total: 0 },
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
  emit({ phase: 'planning' }, true)
  await checkConceptIdTypes(dataSourceId, mapping, signal)
  const status = await getConceptCacheStatus(dataSourceId)
  // Units run on the server as sent, outside queryDataSource: the relations go
  // with them, emptied where the database lacks their table.
  const tables = await sourceTables(dataSourceId)

  let units = restart ? null : resumable(status.run?.manifest, mapping, tables)
  let manifest: ConceptCountManifest
  const done = new Set<string>()
  if (units && status.run) {
    manifest = status.run.manifest as ConceptCountManifest
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
    await startConceptRun(dataSourceId, manifest, true)
  }

  const count = (step: ConceptCountUnit['step']) => {
    const of = units!.filter((u) => u.step === step)
    return { done: of.filter((u) => done.has(u.key)).length, total: of.length }
  }
  let assembled = 0
  const assemble = async () => {
    const records = count('records')
    const patients = count('patients')
    const sql = buildConceptsAssembleQuery(mapping, computeAvailableColumns(conceptRelations(mapping)), {
      recordsComplete: records.done === records.total,
      patientsComplete: patients.done === patients.total,
    })
    if (!sql) throw new Error('no_concept_table')
    await assembleConceptCache(dataSourceId, withClassRelations(sql, mapping, tables))
    emit({ assembled: ++assembled }, true)
  }

  emit({ records: count('records'), patients: count('patients') }, true)
  let assembledAt = Date.now()
  let unassembled = false
  try {
    for (const unit of units) {
      if (done.has(unit.key)) continue
      if (recordsOnly && unit.step === 'patients') {
        if (unassembled) {
          emit({ phase: 'assembling' }, true)
          await assemble()
        }
        return
      }
      signal.throwIfAborted()
      emit({ phase: unit.step }, true)
      await writeConceptUnit(dataSourceId, manifest.runId, unit.key, withClassRelations(unit.sql, mapping, tables), signal)
      done.add(unit.key)
      unassembled = true
      emit({ records: count('records'), patients: count('patients') })

      const recordsJustDone = unit.step === 'records' && count('records').done === count('records').total
      if (recordsJustDone || (unit.step === 'patients' && Date.now() - assembledAt >= ASSEMBLE_EVERY_MS)) {
        emit({ phase: 'assembling' }, true)
        await assemble()
        assembledAt = Date.now()
        unassembled = false
      }
    }
  } catch (err) {
    // A pause keeps what was counted visible: the list is assembled from it.
    if (signal.aborted && unassembled) {
      try { await assemble() } catch { /* the next run assembles it */ }
    }
    if (signal.aborted) return
    throw err
  }

  emit({ phase: 'assembling' }, true)
  await assemble()
  await startConceptRun(dataSourceId, { ...manifest, finishedAt: new Date().toISOString() }, false)
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
