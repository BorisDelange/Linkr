/**
 * Run one ETL script server-side over a WebSocket, on a single connection.
 *
 * The HTTP `/etl-run` route takes ONE statement, so running a script meant one
 * request — and one DuckDB connection — per statement. Anything session-scoped
 * was lost between them: a `SET VARIABLE` set in statement 1 was gone by
 * statement 2, and `query(getvariable(...))` failed with `syntax error at or
 * near "NULL"`. Front-only never had the bug (DuckDB-WASM keeps one connection
 * for the tab), which is exactly why a portable script could pass in the
 * browser and fail on the server.
 *
 * Here the script is sent whole and the server reports each statement as it
 * starts, so progress stays per-statement without splitting the session.
 */
import { wsBaseUrl } from './terminal-ws'

/** Progress callback: same shape the runner already reports to the UI. */
export type EtlStatementProgress = (index: number, total: number, sql: string) => void

interface StatementMessage { type: 'statement'; index: number; total: number; sql: string }
interface DoneMessage { type: 'done'; rows: Record<string, unknown>[] }
interface ErrorMessage { type: 'error'; message: string }
type EtlRunMessage = StatementMessage | DoneMessage | ErrorMessage

/**
 * Thrown when the socket closes before the run reported `done` — the run may or
 * may not have completed server-side, so the caller must not treat it as a
 * success with no rows.
 */
export class EtlStreamClosedError extends Error {
  constructor(message = 'The connection to the server was lost during the run') {
    super(message)
    this.name = 'EtlStreamClosedError'
  }
}

export function runEtlStream(
  dataSourceId: string,
  sql: string,
  roles: Record<string, string>,
  mappingData: Record<string, string> = {},
  options: { onStatement?: EtlStatementProgress; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>[]> {
  const { onStatement, signal } = options
  const token = localStorage.getItem('linkr-access-token') ?? ''
  const params = new URLSearchParams({ token })
  const url = `${wsBaseUrl()}/api/v1/data-sources/${dataSourceId}/etl-run-stream?${params}`

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    // Stopping a run means closing the socket: the server cancels the run task,
    // which interrupts the statement in flight and waits for DuckDB to release
    // the target file before returning.
    function onAbort() {
      ws.close()
    }
    signal?.addEventListener('abort', onAbort)

    ws.onopen = () => ws.send(JSON.stringify({ sql, roles, mappingData }))

    ws.onmessage = (ev) => {
      let msg: EtlRunMessage
      try {
        msg = JSON.parse(ev.data as string) as EtlRunMessage
      } catch {
        return // ignore a frame we cannot read rather than failing the run
      }
      if (msg.type === 'statement') {
        onStatement?.(msg.index, msg.total, msg.sql)
      } else if (msg.type === 'done') {
        finish(() => resolve(msg.rows))
        ws.close()
      } else if (msg.type === 'error') {
        finish(() => reject(new Error(msg.message)))
        ws.close()
      }
    }

    // A close without `done` is a lost run, not an empty one.
    ws.onclose = () => finish(() => reject(new EtlStreamClosedError()))
    ws.onerror = () => finish(() => reject(new EtlStreamClosedError()))
  })
}
