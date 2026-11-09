import { useEffect, useState } from 'react'
import type { Job } from '@/lib/api/environments'
import { loggedQueries, onQueryLogged, type LoggedQuery } from '@/lib/duckdb/query-log'
import { localized } from '@/lib/localized'
import { useDataSourceStore } from '@/stores/data-source-store'

export const QUERY_KIND = 'sql_query'

/** What a front-only query answered, as its job's output says it. */
function outcome(q: LoggedQuery): string {
  if (q.error) return q.error
  if (q.rows == null) return ''
  return `${q.rows.toLocaleString('en')} row${q.rows === 1 ? '' : 's'}`
}

/** A front-only query, shaped like the job the server would have recorded:
 *  for its database, as the server says it. */
function asJob(q: LoggedQuery): Job {
  const source = useDataSourceStore.getState().dataSources.find((d) => d.id === q.dataSourceId)
  return {
    id: q.id,
    projectUid: null,
    workspaceId: null,
    kind: QUERY_KIND,
    label: q.origin,
    status: q.status,
    progress: 0,
    logTail: outcome(q),
    summary: outcome(q).split('\n')[0] || null,
    input: q.sql,
    createdAt: new Date(q.startedAt).toISOString(),
    startedAt: new Date(q.startedAt).toISOString(),
    finishedAt: q.finishedAt == null ? null : new Date(q.finishedAt).toISOString(),
    groupKey: q.group?.key ?? null,
    groupLabel: q.group?.label ?? null,
    entityType: 'database',
    entityId: q.dataSourceId,
    entityName: source ? localized(source.name, 'en') || source.alias : null,
  }
}

/** Front-only mode's jobs: the queries this tab ran, each carrying its SQL. */
export function useLocalQueries(enabled: boolean): Job[] {
  const [queries, setQueries] = useState<Job[]>([])
  useEffect(() => {
    if (!enabled) return
    const read = () => setQueries(loggedQueries().map(asJob))
    read()
    return onQueryLogged(read)
  }, [enabled])
  return queries
}
