import { useCallback, useEffect, useState } from 'react'
import { clearWorkspaceQueries, listWorkspaceQueries, type Job } from '@/lib/api/environments'
import { clearLoggedQueries, loggedQueries, onQueryLogged, type LoggedQuery } from '@/lib/duckdb/query-log'

export const QUERY_KIND = 'sql_query'

/** What a front-only query answered, as its job's output says it. */
function outcome(q: LoggedQuery): string {
  if (q.error) return q.error
  if (q.rows == null) return ''
  return `${q.rows.toLocaleString('en')} row${q.rows === 1 ? '' : 's'}`
}

/** A front-only query, shaped like the job the server would have recorded. */
function asJob(q: LoggedQuery): Job {
  return {
    id: q.id,
    projectUid: null,
    workspaceId: null,
    kind: QUERY_KIND,
    label: q.origin,
    status: q.status,
    progress: 0,
    logTail: outcome(q),
    input: q.sql,
    createdAt: new Date(q.startedAt).toISOString(),
    startedAt: new Date(q.startedAt).toISOString(),
    finishedAt: q.finishedAt == null ? null : new Date(q.finishedAt).toISOString(),
  }
}

/**
 * The queries the jobs panel lists: the workspace's query jobs in server mode,
 * read while `active`; this tab's own in front-only mode (`workspaceId` null).
 * A front-only query carries its SQL; a server one's comes with `getJob`.
 */
export function useQueryLog(server: boolean, workspaceId: string | undefined, active: boolean) {
  const [queries, setQueries] = useState<Job[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (server) return
    const read = () => setQueries(loggedQueries().map(asJob))
    read()
    return onQueryLogged(read)
  }, [server])

  useEffect(() => {
    if (!server || !workspaceId || !active) return
    let cancelled = false
    const read = () => {
      listWorkspaceQueries(workspaceId)
        .then((rows) => { if (!cancelled) setQueries(rows) })
        .catch(() => {})
    }
    read()
    const id = setInterval(read, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [server, workspaceId, active, tick])

  const clear = useCallback(async () => {
    if (!server) return clearLoggedQueries()
    if (workspaceId) await clearWorkspaceQueries(workspaceId)
    setTick((n) => n + 1)
  }, [server, workspaceId])

  return { queries, clear }
}
