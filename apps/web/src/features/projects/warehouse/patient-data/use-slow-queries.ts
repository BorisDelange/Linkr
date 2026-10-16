import { useEffect, useState } from 'react'
import { planQuery } from '@/lib/duckdb/engine'

export type SlowQueriesState =
  | { state: 'checking' }
  | { state: 'fast' }
  /** One of the queries would read the database's tables whole; `reason` says what kept it from the database. */
  | { state: 'slow'; reason: string | null }

const plans = new Map<string, Promise<SlowQueriesState>>()

/** Whether any of `sqls` would be computed by Linkr from whole tables (planQuery),
 *  asked once per database and set of queries. A failed check counts as fast:
 *  the widget then loads as it always did. */
export function slowQueries(dataSourceId: string, sqls: readonly string[]): Promise<SlowQueriesState> {
  const key = `${dataSourceId}\n${sqls.join('\n;\n')}`
  let plan = plans.get(key)
  if (!plan) {
    plan = Promise.all(sqls.map((sql) => planQuery(dataSourceId, sql)))
      .then((executions): SlowQueriesState => {
        const slow = executions.find((e) => e?.computedBy === 'linkr')
        return slow ? { state: 'slow', reason: slow.reason } : { state: 'fast' }
      })
      .catch((): SlowQueriesState => {
        plans.delete(key)
        return { state: 'fast' }
      })
    plans.set(key, plan)
  }
  return plan
}

/** slowQueries for a widget: `checking` until the server answers. */
export function useSlowQueries(dataSourceId: string | undefined, sqls: readonly string[] | null): SlowQueriesState {
  const key = dataSourceId && sqls ? `${dataSourceId}\n${sqls.join('\n;\n')}` : null
  const [answer, setAnswer] = useState<{ key: string; value: SlowQueriesState } | null>(null)

  useEffect(() => {
    if (!key || !dataSourceId || !sqls) return
    let cancelled = false
    void slowQueries(dataSourceId, sqls).then((value) => {
      if (!cancelled) setAnswer({ key, value })
    })
    return () => { cancelled = true }
    // `key` stands for both inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!key) return { state: 'fast' }
  return answer?.key === key ? answer.value : { state: 'checking' }
}
