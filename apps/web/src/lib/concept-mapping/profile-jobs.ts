/**
 * A run's profile queries as one server job (server mode).
 *
 * Once a run has ranked its concepts, every profile query it will send is known
 * (`buildBatchProfileQuery` needs no answer in between): `planRunQueries` lists
 * them the way `extractBatch` builds them, page after page, and the server runs
 * them as a job that goes on when the tab is closed. The run then walks its
 * pages as before, each query answered from the job when it planned it, from
 * the database otherwise (a concept gone since the ranking shifts the pages).
 */
import type { SchemaMapping } from '@/types/schema-mapping'
import { exactOptions, missingSections, sectionSet, variantOf, type SectionKey } from '@/lib/concept-profiles/profile-store'
import { availableSections, effectiveSections, plannedProfileQueries, type ProfileOptions, type ProfileSource } from './concept-profile'
import type { BatchProfileStore } from './source-extraction'

/** The most queries one server job takes (`QueryJobRequest.queries`). */
export const QUERY_JOB_MAX_QUERIES = 10_000

/** The server side of a run's job. */
export interface ProfileJobs {
  /** Run these queries, in order, as one job; its id. */
  start: (queries: readonly { key: string; sql: string }[]) => Promise<string>
  /** The most queries `start` takes at once; a longer run is several jobs, one
   *  after the other. QUERY_JOB_MAX_QUERIES when unset. */
  maxQueries?: number
  /** The rows of `key`, once the job has run it; null when it never will
   *  (failed, cancelled, gone). */
  rows: (jobId: string, key: string, signal: AbortSignal) => Promise<Record<string, unknown>[] | null>
  /** The keys the job has run; null when it is gone. */
  done: (jobId: string) => Promise<Set<string> | null>
  cancel: (jobId: string) => Promise<void>
}

/** A query's key in a job: 64 bits of its text, so two batches never share one. */
export function profileQueryKey(sql: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ sql.length
  for (let i = 0; i < sql.length; i++) {
    const c = sql.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15)
  }
  return `p${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`
}

export interface RunPlan {
  mapping: SchemaMapping
  sources: readonly ProfileSource[]
  options: ProfileOptions
  rankings: readonly (readonly number[])[]
  sizes: readonly number[]
  homes: readonly (Map<number, number> | undefined)[]
  recordTotals: readonly Map<number, number>[]
  /** The global offset the run resumes at. */
  offset: number
  /** Concepts per page, as the run walks them. */
  pageSize: number
  store?: BatchProfileStore
}

/**
 * The profile queries a ranked run sends from `offset` on, in order — what
 * `extractBatch` builds for each page: the concepts the store does not answer
 * whole, grouped by home table and missing sections, in batches.
 */
export async function planRunQueries(plan: RunPlan): Promise<string[]> {
  const { mapping, sources, options, rankings, sizes, homes, recordTotals, store } = plan
  const out: string[] = []
  let start = plan.offset
  for (const [index, source] of sources.entries()) {
    const size = sizes[index]
    if (start >= size) {
      start -= size
      continue
    }
    const ranking = rankings[index].slice(start, size)
    start = 0
    const opts = { ...options, sections: effectiveSections(options.sections, availableSections(mapping, source)) }
    const variant = variantOf(opts)
    const read = store?.readMeta ?? store?.read
    const stored = read ? await read(source.dictionary.key, ranking) : null
    const totals = recordTotals[index]
    for (let page = 0; page < ranking.length; page += plan.pageSize) {
      const groups = new Map<string, { home: number; missing: SectionKey[] | null; ids: number[] }>()
      for (const id of ranking.slice(page, page + plan.pageSize)) {
        const missing = store ? missingSections(stored?.get(id), opts.sections, variant, store.fingerprint) : null
        if (missing && missing.length === 0) continue
        const home = homes[index]?.get(id) ?? 0
        const key = `${home}|${missing?.join(',') ?? '*'}`
        const group = groups.get(key) ?? { home, missing, ids: [] }
        group.ids.push(id)
        groups.set(key, group)
      }
      for (const { home, missing, ids } of groups.values()) {
        const event = source.events[home] ?? source.event
        out.push(...plannedProfileQueries(
          mapping, event === source.event ? source : { ...source, event }, ids,
          missing ? exactOptions(opts, sectionSet(missing)) : opts,
          (id) => totals.get(id) ?? 0,
        ))
      }
    }
  }
  return out
}
