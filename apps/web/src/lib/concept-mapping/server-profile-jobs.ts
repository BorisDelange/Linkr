import { cancelJob } from '@/lib/api/environments'
import { queryJobKeyRows, queryJobProgress, startQueryJob } from '@/lib/api/query-jobs'
import { prepareQuerySql } from '@/lib/duckdb/engine'
import { QUERY_JOB_MAX_QUERIES, type ProfileJobs } from './profile-jobs'

/**
 * A run's profile queries as server query jobs: keep-going (a batch that fails
 * is profiled again by the browser, concept by concept), and sharing the heavy
 * lane (hours of profiles must not hold a cohort's query up).
 */
export function serverProfileJobs(dataSourceId: string, label: string): ProfileJobs {
  return {
    maxQueries: QUERY_JOB_MAX_QUERIES,
    start: async (queries) => {
      const items = await Promise.all(queries.map(async (q) => ({ key: q.key, sql: await prepareQuerySql(dataSourceId, q.sql) })))
      return (await startQueryJob(dataSourceId, label, items, { keepGoing: true, shareLane: true })).id
    },
    rows: (jobId, key, signal) => queryJobKeyRows(dataSourceId, jobId, key, signal),
    done: async (jobId) => (await queryJobProgress(jobId))?.done ?? null,
    cancel: (jobId) => cancelJob(jobId).catch(() => {}),
  }
}
