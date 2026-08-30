/**
 * Keeps a source-concept extraction running while nobody is watching it.
 *
 * The run belongs to the PROJECT, not to the tab that started it. Profiling a
 * real warehouse's dictionary takes minutes to hours, and a user who leaves the
 * tab to look at the mapping editor — or at another project entirely — has not
 * asked for the work to stop. Owning the loop in the component meant its unmount
 * cleanup aborted it, so every tab change silently paused the extraction.
 *
 * So the loop lives here, in a module-level registry keyed by project id, and
 * the tab subscribes to it: it renders whatever the run reports and re-attaches
 * on return. Only an explicit pause, a finished run, or an error stops it.
 *
 * One run per project at a time — the loop appends to a single CSV and writes it
 * back after each save point, so two concurrent runs on the same project would
 * interleave their writes and lose rows.
 */

import type { SchemaMapping } from '@/types/schema-mapping'
import type { SourceExtraction } from '@/types'
import {
  availableSections,
  effectiveSections,
  type ProfileOptions,
  type ProfileSource,
} from './concept-profile'
import {
  DEFAULT_EXTRACTION_SORT,
  buildConceptCountsQuery,
  buildDictionaryCountQuery,
  buildDictionaryIdsQuery,
  extractBatch,
  extractionCsvHeader,
  extractionCsvRows,
  rankConceptIds,
  sortNeedsCounts,
  type ConceptCounts,
  type ExtractionSort,
} from './source-extraction'

/**
 * Concepts profiled between two writes of the CSV.
 *
 * Not a user setting: progress is counted and resumed in concepts, so this only
 * trades how much work a crash could lose against how often a large CSV is
 * re-encoded. 500 keeps both small.
 */
const SAVE_EVERY = 500

/**
 * Where a run is: sizing the dictionaries, ranking them, or walking them.
 *
 * `counting` is its own phase because it takes long enough to be seen. It is one
 * COUNT per dictionary against a clinical database, before which neither the
 * offset nor the total is known — and a restart that shows the previous run's
 * numbers while it waits looks like a button that did nothing.
 *
 * `ranking` only happens for a sort by volume, and is the longer wait of the
 * two: a GROUP BY over the whole event table. It is named separately so the user
 * knows the extraction is paying for the priority they asked for.
 */
export type RunPhase = 'counting' | 'ranking' | 'extracting'

/** What a watcher needs to render, whether or not it started the run. */
export interface RunSnapshot {
  running: boolean
  phase: RunPhase | null
  /** Live concept offset, or null when no run is in flight. */
  extracted: number | null
  /**
   * Concepts this run is walking towards, or null until they are counted.
   *
   * The persisted total describes the PREVIOUS run, so a restart must not fall
   * back to it: this is what the view shows instead while counting.
   */
  total: number | null
  /** The concept being profiled right now, for a "what is it on" tooltip. */
  current: { conceptCode: string; conceptName: string } | null
  error: string | null
}

const IDLE: RunSnapshot = {
  running: false, phase: null, extracted: null, total: null, current: null, error: null,
}

interface Run {
  snapshot: RunSnapshot
  controller: AbortController
  watchers: Set<(snapshot: RunSnapshot) => void>
}

const runs = new Map<string, Run>()

function emit(projectId: string, patch: Partial<RunSnapshot>): void {
  const run = runs.get(projectId)
  if (!run) return
  run.snapshot = { ...run.snapshot, ...patch }
  for (const watcher of run.watchers) watcher(run.snapshot)
}

/** Current state of a project's run, for a first render. */
export function getRunSnapshot(projectId: string): RunSnapshot {
  return runs.get(projectId)?.snapshot ?? IDLE
}

/** Whether a run is in flight for this project. */
export function isRunning(projectId: string): boolean {
  return !!runs.get(projectId)?.snapshot.running
}

/**
 * Watch a project's run. Returns an unsubscribe.
 *
 * Unsubscribing does NOT stop the run — that is the whole point. A watcher that
 * goes away is a tab that was left, not a cancellation.
 */
export function watchRun(
  projectId: string,
  watcher: (snapshot: RunSnapshot) => void,
): () => void {
  const run = runs.get(projectId)
  if (run) {
    run.watchers.add(watcher)
    return () => { runs.get(projectId)?.watchers.delete(watcher) }
  }
  // No run yet: hold the watcher so a run started elsewhere can pick it up.
  pending.set(projectId, (pending.get(projectId) ?? new Set()).add(watcher))
  return () => { pending.get(projectId)?.delete(watcher) }
}

const pending = new Map<string, Set<(snapshot: RunSnapshot) => void>>()

/** Ask a project's run to stop after the concept in flight. */
export function pauseRun(projectId: string): void {
  runs.get(projectId)?.controller.abort()
}

/** Everything the loop needs that only the view can resolve. */
export interface StartRunInput {
  projectId: string
  mapping: SchemaMapping
  sources: ProfileSource[]
  options: ProfileOptions
  /** Which end of each dictionary to walk from. */
  sort: ExtractionSort
  /** Where a resume picks up, and what it is counting towards. */
  resumeFrom: { extracted: number; total: number } | null
  /** The CSV built so far, or null to start a fresh one. */
  existingCsv: string | null
  query: (sql: string) => Promise<Record<string, unknown>[]>
  /** Write progress and the CSV back to the project. */
  persist: (state: SourceExtraction, csv: string, rowCount: number) => Promise<void>
  /** Record a failure on the stored run, so a reload shows it. */
  persistError: (message: string) => Promise<void>
}

/**
 * Start (or resume) a project's extraction.
 *
 * Returns immediately; progress reaches watchers through `watchRun`. A no-op
 * when a run is already in flight for this project.
 */
export function startRun(input: StartRunInput): void {
  const { projectId } = input
  if (runs.get(projectId)?.snapshot.running) return

  const controller = new AbortController()
  const run: Run = {
    snapshot: {
      running: true,
      phase: 'counting',
      extracted: input.resumeFrom?.extracted ?? 0,
      // Unknown until the dictionaries are counted. A restart in particular must
      // NOT inherit the previous run's total — that is the stale "1066 of 5636"
      // a restart used to sit on while it counted.
      total: input.resumeFrom?.total || null,
      error: null,
    },
    controller,
    // Carry over the watchers already following this project: they subscribed to
    // the previous run's entry, and a restart must not orphan them.
    watchers: runs.get(projectId)?.watchers ?? pending.get(projectId) ?? new Set(),
  }
  pending.delete(projectId)
  runs.set(projectId, run)
  for (const watcher of run.watchers) watcher(run.snapshot)

  void loop(input, controller)
}

async function loop(input: StartRunInput, controller: AbortController): Promise<void> {
  const { projectId, mapping, sources, options, query, persist } = input
  try {
    // A restart re-counts: the dictionaries may have grown since the last run,
    // and resuming against a stale total would stop short of the new rows.
    let offset = input.resumeFrom?.extracted ?? 0
    let runTotal = input.resumeFrom?.total ?? 0

    const sort = input.sort ?? DEFAULT_EXTRACTION_SORT

    // Per-dictionary sizes, so a global offset can be mapped onto the right one.
    const sizes: number[] = []
    for (const source of sources) {
      const rows = await query(buildDictionaryCountQuery(source))
      sizes.push(Number(rows[0]?.total ?? 0))
    }

    // A volume sort needs the counts before anything can be profiled: one
    // GROUP BY per dictionary over its event table. Skipped entirely for the
    // sorts the dictionary can order by on its own.
    let rankings: (number[] | undefined)[] = sources.map(() => undefined)
    if (sortNeedsCounts(sort)) {
      emit(projectId, { phase: 'ranking' })
      rankings = []
      for (const [i, source] of sources.entries()) {
        if (controller.signal.aborted) return
        const [counts, ids] = await Promise.all([
          query(buildConceptCountsQuery(source)),
          query(buildDictionaryIdsQuery(source)),
        ])
        // Ranked over the WHOLE dictionary, not just the concepts the event
        // table mentions: one with no records still belongs in the CSV, with a
        // zero count. It simply sorts last.
        const ranked = rankConceptIds(
          counts as unknown as ConceptCounts[],
          sort,
          ids.map((r) => Number(r.concept_id)),
        )
        rankings.push(ranked)
        sizes[i] = ranked.length
      }
    }

    if (runTotal === 0) runTotal = sizes.reduce((a, b) => a + b, 0)

    let csv = input.existingCsv ?? extractionCsvHeader()
    const keys = sources.map((s) => s.dictionary.key)

    emit(projectId, { phase: 'extracting', extracted: offset, total: runTotal })

    // Runs until paused or finished. Concepts are the unit of progress — the
    // offset counts them, and a resume picks up at the next one — so the batch
    // below is only how often the CSV is written back, never something the run
    // stops on.
    while (!controller.signal.aborted && offset < runTotal) {
      // Which dictionary the global offset falls in, and where inside it.
      let index = 0
      let local = offset
      while (index < sizes.length && local >= sizes[index]) {
        local -= sizes[index]
        index++
      }
      if (index >= sources.length) break

      const source = sources[index]
      const sections = effectiveSections(options.sections, availableSections(mapping, source))
      const base = offset - local
      const batch = await extractBatch(
        mapping, source, { ...options, sections }, local,
        // Never read past this dictionary's end in one batch: the next one has
        // its own columns, and mixing them into one page would misread them.
        Math.min(SAVE_EVERY, sizes[index] - local),
        runTotal, query, controller.signal,
        (n, _total, concept) => emit(projectId, { extracted: base + n, current: concept }),
        sort, rankings[index],
      )
      if (batch.rows.length > 0) csv += `\n${extractionCsvRows(batch.rows)}`
      // A batch that yields nothing and is not done would spin forever.
      if (batch.rows.length === 0 && !batch.done) break
      offset += batch.rows.length

      await persist(
        {
          dictionaryKeys: keys, extracted: offset, total: runTotal,
          options: { ...options, sections }, sort,
          updatedAt: new Date().toISOString(),
        },
        csv, offset,
      )
      emit(projectId, { extracted: offset })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit(projectId, { error: message })
    try {
      await input.persistError(message)
    } catch {
      // The run already failed; failing to record that must not mask it.
    }
  } finally {
    const run = runs.get(projectId)
    // Keep the error visible to a watcher that mounts after the failure, but
    // drop the live counts so the view falls back to the persisted ones — which
    // by now describe this run, since every save point wrote them.
    const error = run?.snapshot.error ?? null
    emit(projectId, { running: false, phase: null, extracted: null, total: null })
    if (run) {
      run.snapshot = { running: false, phase: null, extracted: null, total: null, error }
      if (run.watchers.size === 0 && !error) runs.delete(projectId)
    }
  }
}

/** Forget a finished run's error, so the next start renders clean. */
export function clearRunError(projectId: string): void {
  const run = runs.get(projectId)
  if (!run || run.snapshot.running) return
  emit(projectId, { error: null })
  if (run.watchers.size === 0) runs.delete(projectId)
}
