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
  EMPTY_WALK,
  buildConceptCountsQuery,
  buildDictionaryCountQuery,
  buildDictionaryIdsQuery,
  computesMetadata,
  dictionaryWalkIds,
  extendWalk,
  extractBatch,
  extractionCsvHeader,
  extractionCsvRows,
  mergeTableCounts,
  planConceptWalk,
  sortNeedsCounts,
  walkKey,
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
 * Mirrors the server's MAX_QUERY_ROWS_ALL (db_connect.py): a one-request read
 * that comes back this long may have been cut, and is read again page by page.
 */
const ONE_REQUEST_ROW_CEILING = 2_000_000

/** Which dictionary a global offset falls in, and where inside it. */
function locate(offset: number, sizes: number[]): { index: number; local: number } {
  let index = 0
  let local = offset
  while (index < sizes.length && local >= sizes[index]) {
    local -= sizes[index]
    index++
  }
  return { index, local }
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

/**
 * Where a run is: sizing the dictionaries, ranking them, or walking them.
 *
 * `counting` is its own phase because it takes long enough to be seen. It is one
 * COUNT per dictionary against a clinical database, before which neither the
 * offset nor the total is known — and a restart that shows the previous run's
 * numbers while it waits looks like a button that did nothing.
 *
 * `ranking` happens for a sort by volume, a run keeping only the concepts with
 * records, or a dictionary spread over several event tables, and is the longer
 * wait of the two: a GROUP BY over each event table. It is named separately so
 * the user knows what the extraction is paying for.
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
  /**
   * Set from the moment Pause is pressed until the run has stopped: `stopping`
   * while the query in flight is cut off, `saving` while the concepts profiled
   * since the last save point are written.
   */
  pausing: 'stopping' | 'saving' | null
  error: string | null
}

const IDLE: RunSnapshot = {
  running: false, phase: null, extracted: null, total: null, current: null, pausing: null, error: null,
}

interface Run {
  snapshot: RunSnapshot
  controller: AbortController
  watchers: Set<(snapshot: RunSnapshot) => void>
  /** When the watchers were last told, for the progress throttle below. */
  lastNotifiedAt: number
}

const runs = new Map<string, Run>()

/**
 * Shortest gap between two progress notifications, in milliseconds.
 *
 * A concept can be profiled in under 20ms, and every one of them re-rendered the
 * panel: a progress bar and a reformatted localized count, thousands of times
 * over a run, all on the tab's one thread. Ten updates a second is past what
 * anyone can read and costs nothing.
 */
const PROGRESS_THROTTLE_MS = 100

/**
 * Tell the watchers, unless this is only progress and one just went out.
 *
 * Anything other than a bare position change — a phase, an error, the run
 * stopping — is delivered immediately: those are states the UI must not lag
 * behind, and they are rare.
 */
function emit(projectId: string, patch: Partial<RunSnapshot>): void {
  const run = runs.get(projectId)
  if (!run) return
  run.snapshot = { ...run.snapshot, ...patch }

  const onlyProgress = Object.keys(patch).every((k) => k === 'extracted' || k === 'current')
  const now = Date.now()
  if (onlyProgress && now - run.lastNotifiedAt < PROGRESS_THROTTLE_MS) return
  run.lastNotifiedAt = now
  for (const watcher of run.watchers) watcher(run.snapshot)
}

/** Deliver now, whatever the throttle would have said. */
function emitNow(projectId: string, patch: Partial<RunSnapshot>): void {
  const run = runs.get(projectId)
  if (run) run.lastNotifiedAt = 0
  emit(projectId, patch)
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

/**
 * Stop a project's run now. The query in flight is cancelled (server mode
 * interrupts it) or, where it cannot be, no longer waited for; the concept it
 * belonged to is dropped and profiled again on resume. What remains is writing
 * the concepts profiled since the last save point.
 */
export function pauseRun(projectId: string): void {
  const run = runs.get(projectId)
  if (!run?.snapshot.running || run.controller.signal.aborted) return
  emitNow(projectId, { pausing: 'stopping' })
  run.controller.abort()
}

/** A query that settles as soon as `signal` aborts, whether or not the engine
 *  underneath can cancel it. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/** Everything the loop needs that only the view can resolve. */
export interface StartRunInput {
  projectId: string
  mapping: SchemaMapping
  sources: ProfileSource[]
  options: ProfileOptions
  /** Which end of each dictionary to walk from. */
  sort: ExtractionSort
  /** Walk only the concepts the event table has records for. */
  onlyWithRecords: boolean
  /**
   * Where a resume picks up, what it is counting towards, and the per-dictionary
   * sizes the interrupted run measured. `sizes` is absent on a run stored before
   * they were recorded; the loop then recounts, as it used to.
   */
  resumeFrom: { extracted: number; total: number; sizes?: number[]; walked?: string } | null
  query: (sql: string, signal?: AbortSignal) => Promise<Record<string, unknown>[]>
  /**
   * Like `query`, but guaranteed to return EVERY row.
   *
   * Server mode caps a single response at MAX_QUERY_ROWS and truncates silently,
   * so the two dictionary-wide passes below (the counts and the id list) must not
   * go through `query`: a ranking built from the first 10k rows would set
   * `sizes[i]` to that truncated length, and the run would report itself done
   * having profiled a fraction of the dictionary. Same reason
   * `source-concepts-loader` pages its own reads.
   */
  queryAll: (sql: string, signal?: AbortSignal) => Promise<Record<string, unknown>[]>
  /**
   * Every row of an aggregate in ONE request, when the engine can (server mode's
   * `allRows`). The counting pass is a GROUP BY over a whole event table, and
   * `queryAll` pages by re-running it once per 10k rows — on OMOP, seven full
   * scans times the pages. Its result is small, so it is read here whole; a
   * reply at the server's ceiling is read again through `queryAll`.
   */
  queryAggregate?: (sql: string, signal?: AbortSignal) => Promise<Record<string, unknown>[]>
  /**
   * Write progress and the newly extracted rows back to the project.
   *
   * Only the NEW rows: the run no longer keeps the whole CSV in memory, because
   * re-encoding and re-uploading tens of megabytes at every save point was
   * quadratic and froze the tab. `reset` marks the first write of a run, which
   * carries the header and replaces whatever was there.
   */
  persist: (
    state: SourceExtraction,
    csvChunk: string,
    rowCount: number,
    reset: boolean,
  ) => Promise<void>
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
      // Nothing is being profiled yet — the run is still counting.
      current: null,
      pausing: null,
      error: null,
    },
    controller,
    // Carry over the watchers already following this project: they subscribed to
    // the previous run's entry, and a restart must not orphan them.
    watchers: runs.get(projectId)?.watchers ?? pending.get(projectId) ?? new Set(),
    lastNotifiedAt: 0,
  }
  pending.delete(projectId)
  runs.set(projectId, run)
  for (const watcher of run.watchers) watcher(run.snapshot)

  void loop(input, controller)
}

async function loop(input: StartRunInput, controller: AbortController): Promise<void> {
  const { projectId, mapping, sources, options, persist } = input
  const { signal } = controller
  const query = (sql: string) => abortable(input.query(sql, signal), signal)
  const queryAll = (sql: string) => abortable(input.queryAll(sql, signal), signal)
  const queryAggregate = async (sql: string) => {
    if (!input.queryAggregate) return queryAll(sql)
    const rows = await abortable(input.queryAggregate(sql, signal), signal)
    return rows.length >= ONE_REQUEST_ROW_CEILING ? queryAll(sql) : rows
  }
  try {
    // A restart re-counts: the dictionaries may have grown since the last run,
    // and resuming against a stale total would stop short of the new rows.
    let offset = input.resumeFrom?.extracted ?? 0

    const sort = input.sort ?? DEFAULT_EXTRACTION_SORT

    // Per-dictionary sizes, so a global offset can be mapped onto the right one.
    //
    // A resume REUSES the sizes its run measured rather than recounting: the
    // offset is an index into those boundaries, so a dictionary that changed
    // size in between would move them and land the resume in the wrong
    // dictionary. Only a fresh run (or one stored before sizes were recorded)
    // counts.
    const storedSizes = input.resumeFrom?.sizes
    const reuseSizes = !!storedSizes && storedSizes.length === sources.length
    let sizes: number[] = []
    if (reuseSizes) {
      sizes.push(...storedSizes)
    } else {
      for (const source of sources) {
        if (signal.aborted) return
        const rows = await query(buildDictionaryCountQuery(source))
        sizes.push(Number(rows[0]?.total ?? 0))
      }
    }

    // The counts are needed before anything can be profiled for a volume sort,
    // for keeping only the concepts with records, and for a dictionary spread
    // over several event tables — there they say which table each concept is
    // profiled in. One GROUP BY per event table. Skipped entirely otherwise: the
    // dictionary then orders itself, page by page.
    //
    // Without metadata nothing is profiled and there is no volume to show, so
    // only an explicit "only concepts with records" pays for that scan: "metadata
    // off" is the promise that the clinical tables are left alone.
    const { onlyWithRecords } = input
    const metadata = computesMetadata(options)
    const needsCounts = onlyWithRecords
      || (metadata && (sortNeedsCounts(sort) || sources.some((s) => s.events.length > 1)))
    let rankings: (number[] | undefined)[] = sources.map(() => undefined)
    const homes: (Map<number, number> | undefined)[] = sources.map(() => undefined)
    const recordTotals: (Map<number, number> | undefined)[] = sources.map(() => undefined)
    if (needsCounts) {
      emit(projectId, { phase: 'ranking' })
      rankings = []
      for (const [i, source] of sources.entries()) {
        if (controller.signal.aborted) return
        // queryAll, not query: both return one row per concept, so on a real
        // vocabulary the server's row cap would truncate them and the ranking
        // would silently cover only the first page (see StartRunInput.queryAll).
        // The event tables one after another: a warehouse answers one big scan
        // faster than several competing ones.
        const perTable: ConceptCounts[][] = []
        for (const event of source.events) {
          if (controller.signal.aborted) return
          perTable.push(await queryAggregate(buildConceptCountsQuery(source, event)) as unknown as ConceptCounts[])
        }
        const ids = await queryAll(buildDictionaryIdsQuery(source, sort))
        const merged = mergeTableCounts(perTable)
        homes[i] = merged.homes
        recordTotals[i] = new Map(merged.counts.map((c) => [c.concept_id, c.record_count]))
        // Ranked over the WHOLE dictionary unless asked otherwise: a concept with
        // no records is still a source concept, and belongs in the CSV with a
        // zero count. It simply sorts last.
        const ranked = planConceptWalk(merged.counts, sort, dictionaryWalkIds(ids), onlyWithRecords)
        rankings.push(ranked)
        // A resume keeps the boundaries its run walked (see below); only a fresh
        // run adopts the ranking's length as this dictionary's size.
        if (!reuseSizes) sizes[i] = ranked.length
      }

      // A resume is an offset into a ranking just recomputed. The dictionaries
      // before the one in progress are written and keep their sizes; the one in
      // progress continues only if its new ranking starts with exactly the
      // concepts already written — else, rather than skip some and write others
      // twice, the run starts over (the CSV can be replaced, not cut). A run
      // stored without that record predates the current ranking scheme. Those
      // not started yet simply take their new length.
      if (input.resumeFrom && offset > 0) {
        const { index, local } = locate(offset, sizes)
        if (index < sources.length) {
          const prefix = rankings[index]!.slice(0, local)
          const same = local === 0 || (
            prefix.length === local && input.resumeFrom.walked === walkKey(extendWalk(EMPTY_WALK, prefix))
          )
          if (same) {
            for (let j = index; j < sources.length; j++) sizes[j] = rankings[j]!.length
          } else {
            offset = 0
            sizes = rankings.map((r) => r!.length)
          }
        }
      }
    }

    // A run stored before its sizes were kept walks towards the total it stored.
    let runTotal = !needsCounts && !reuseSizes && input.resumeFrom?.total
      ? input.resumeFrom.total
      : sum(sizes)

    // A fresh run writes the header and replaces the file; a resume appends to
    // what is already stored. The rows themselves are never held here — only the
    // chunk about to be written.
    let firstWrite = offset === 0
    const keys = sources.map((s) => s.dictionary.key)

    emit(projectId, { phase: 'extracting', extracted: offset, total: runTotal })

    // Runs until paused or finished. Concepts are the unit of progress — the
    // offset counts them, and a resume picks up at the next one — so the batch
    // below is only how often the CSV is written back, never something the run
    // stops on.
    let walkedIndex = -1
    let walked = EMPTY_WALK
    while (!controller.signal.aborted && offset < runTotal) {
      const { index, local } = locate(offset, sizes)
      if (index >= sources.length) break
      const ranking = rankings[index]
      if (walkedIndex !== index) {
        walkedIndex = index
        walked = extendWalk(EMPTY_WALK, ranking?.slice(0, local) ?? [])
      }

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
        sort, ranking, homes[index], recordTotals[index],
      )
      // A batch that yields nothing and is not done would spin forever.
      if (batch.rows.length === 0 && !batch.done) break
      offset += batch.rows.length
      if (ranking) walked = extendWalk(walked, ranking.slice(local, local + batch.rows.length))
      // The dictionary ended before the size it was given (it shrank, or ranked
      // ids are gone from it): close it where it ended, so the next one starts
      // there and the total stays what was written. Left as it was, the offset
      // never reached the boundary and the same empty page was asked forever.
      if (batch.done) {
        const reached = local + batch.rows.length
        if (reached < sizes[index]) {
          sizes[index] = reached
          runTotal = sum(sizes)
          emitNow(projectId, { total: runTotal })
        }
      }

      if (signal.aborted) {
        if (batch.rows.length === 0) break
        emitNow(projectId, { pausing: 'saving' })
      }

      // Only this batch's rows travel. A fresh run leads with the header and
      // replaces the file; every later write appends.
      const rows = extractionCsvRows(batch.rows)
      const chunk = firstWrite
        ? (rows ? `${extractionCsvHeader()}\n${rows}` : extractionCsvHeader())
        : (rows ? `\n${rows}` : '')

      await persist(
        {
          dictionaryKeys: keys, extracted: offset, total: runTotal, sizes: [...sizes],
          options: { ...options, sections }, sort, onlyWithRecords,
          ...(ranking ? { walked: walkKey(walked) } : {}),
          updatedAt: new Date().toISOString(),
        },
        chunk, offset, firstWrite,
      )
      firstWrite = false
      // Past the throttle: a save point is a real checkpoint, and letting the
      // bar sit short of it until the next tick would misreport what is stored.
      emitNow(projectId, { extracted: offset })
    }
  } catch (err) {
    // A pause that cut a query short is not a failure.
    if (signal.aborted) return
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
    // `current` goes with them: it names the concept being profiled, and leaving
    // the last one there would have the tooltip still pointing at it once the
    // run has stopped.
    emitNow(projectId, { running: false, phase: null, extracted: null, total: null, current: null, pausing: null })
    if (run) {
      run.snapshot = {
        running: false, phase: null, extracted: null, total: null, current: null, pausing: null, error,
      }
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
