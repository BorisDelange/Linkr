/**
 * DuckDB Bridge — expose a sql_query(sql) function to Python and R
 * that routes through DuckDB-WASM via the existing engine.
 *
 * This avoids needing the native duckdb Python/R package (which would
 * conflict with DuckDB-WASM). Instead, all queries pass through our
 * single DuckDB-WASM instance.
 */

import type { PyodideInterface } from 'pyodide'
import type { WebR } from 'webr'
import * as duckdbEngine from '@/lib/duckdb/engine'

/**
 * Register `sql_query(sql)` in the Python runtime.
 * It calls through to DuckDB-WASM and returns a pandas DataFrame.
 */
export async function registerDuckDBBridgePython(
  pyodide: PyodideInterface,
  activeConnectionId: string | null,
): Promise<void> {
  // Create a JS function that Python can call
  const queryFn = async (sql: string): Promise<string> => {
    if (!activeConnectionId) throw new Error('No active database connection. Select a connection before using sql_query().')
    const rows = await duckdbEngine.queryDataSource(activeConnectionId, sql)
    return JSON.stringify(rows)
  }

  // Register as a JS module accessible from Python
  pyodide.registerJsModule('_linkr_bridge', { query: queryFn })

  // Define the sql_query() Python function.
  // _linkr_bridge.query() is an async JS function — calling it from Python
  // returns a JsProxy (JS Promise). User scripts run via runPythonAsync which
  // supports top-level await, so sql_query is async and users call it with:
  //   df = await sql_query("SELECT ...")
  await pyodide.runPythonAsync(`
import _linkr_bridge
import pandas as pd
import json

async def sql_query(sql: str) -> pd.DataFrame:
    """Query the active DuckDB connection and return a pandas DataFrame.

    Usage: df = await sql_query("SELECT * FROM person LIMIT 10")
    """
    result_json = await _linkr_bridge.query(sql)
    rows = json.loads(result_json)
    if len(rows) == 0:
        return pd.DataFrame()
    return pd.DataFrame(rows)
`)
}

/**
 * Register `sql_query(sql)` in the R runtime.
 * It calls through to DuckDB-WASM via JS interop and returns a data.frame.
 */
export async function registerDuckDBBridgeR(
  webR: WebR,
  activeConnectionId: string | null,
): Promise<void> {
  // Expose the query function on globalThis so R can call it via webr::eval_js
  (globalThis as Record<string, unknown>).__linkr_active_connection_id = activeConnectionId
  ;(globalThis as Record<string, unknown>).__linkr_query_fn = async (sql: string) => {
    if (!activeConnectionId) throw new Error('No active database connection. Select a connection before using sql_query().')
    console.log('[R bridge] sql_query called, connectionId:', activeConnectionId, 'sql:', sql.slice(0, 80))
    const rows = await duckdbEngine.queryDataSource(activeConnectionId, sql)
    console.log('[R bridge] queryDataSource returned', rows.length, 'rows')
    const json = JSON.stringify(rows)
    console.log('[R bridge] JSON length:', json.length, 'first 200 chars:', json.slice(0, 200))
    return json
  }

  // Define the R wrapper function.
  // IMPORTANT: eval_js without await runs in the worker, eval_js with await=TRUE
  // runs on the main thread — they have DIFFERENT globalThis scopes.
  // So we must do everything in a single eval_js(await=TRUE) call: set the arg
  // on main-thread globalThis, call the query fn, and return the result.
  await webR.evalRVoid(`
    sql_query <- function(sql) {
      js_code <- paste0(
        "globalThis.__linkr_sql_arg = ", jsonlite::toJSON(sql, auto_unbox = TRUE), "; ",
        "globalThis.__linkr_query_fn(globalThis.__linkr_sql_arg).then(r => { globalThis.__linkr_result = r })"
      )
      webr::eval_js(js_code, await = TRUE)
      result_json <- webr::eval_js("globalThis.__linkr_result", await = TRUE)
      if (is.null(result_json) || result_json == "[]") return(data.frame())
      jsonlite::fromJSON(result_json)
    }
  `)
}
