/**
 * Server mode's catalog executor: each phase runs as one server query job
 * (`lib/api/query-jobs.ts`), so no request outlasts a gateway's timeout, two
 * heavy queries never run at once, and closing the tab leaves the job running.
 */

import { followQueryJob, startQueryJob } from '@/lib/api/query-jobs'
import { prepareQuerySql } from './engine'
import { CatalogPhaseCancelled, type CatalogPhase, type CatalogPhaseExecutor, type CatalogPhaseQuery } from './catalog-run'

/** A query's key in its job: the unit's position in the run, stable across resumes. */
const keyOf = (q: CatalogPhaseQuery) => `u${q.offset}`

export function jobExecutor(dataSourceId: string, label: (phase: CatalogPhase) => string): CatalogPhaseExecutor {
  return async ({ name, queries, resumeJob, jobStarted, starting, onRows, signal }) => {
    let pending = queries
    const follow = async (jobId: string) => {
      const list = pending
      let delivered = 0
      try {
        return await followQueryJob(dataSourceId, jobId, list.map(keyOf), async (i, rows) => {
          await onRows(list[i].offset, rows)
          delivered++
        }, { signal, onWaiting: (i) => starting(list[i].offset) })
      } finally {
        pending = list.slice(delivered)
      }
    }

    if (resumeJob) {
      // The job a paused run left: take what it finished, and the rest if it
      // still runs. One that ended short (cancelled, cut by a restart) or is gone
      // leaves the rest to a new job.
      try {
        await follow(resumeJob)
      } catch (err) {
        if (signal.aborted) throw err
      }
      if (pending.length === 0) return
    }

    signal.throwIfAborted()
    const items = await Promise.all(pending.map(async (q) => ({ key: keyOf(q), sql: await prepareQuerySql(dataSourceId, q.sql) })))
    const job = await startQueryJob(dataSourceId, label(name), items)
    await jobStarted(job.id)
    const outcome = await follow(job.id)
    if (pending.length === 0) return
    if (outcome.status === 'cancelled') throw new CatalogPhaseCancelled()
    throw new Error(outcome.error ?? `the query job ended ${outcome.status}`)
  }
}
