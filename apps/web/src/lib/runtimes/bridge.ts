/**
 * DuckDB Bridge — expose a linkr_query(sql) function to Python and R
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
 * Register `linkr_query(sql)` in the Python runtime.
 * It calls through to DuckDB-WASM and returns a pandas DataFrame.
 */
export async function registerDuckDBBridgePython(
  pyodide: PyodideInterface,
  activeConnectionId: string | null,
): Promise<void> {
  // Create a JS function that Python can call
  const queryFn = async (sql: string): Promise<string> => {
    if (!activeConnectionId) throw new Error('No active database connection. Select a connection before using linkr_query().')
    const rows = await duckdbEngine.queryDataSource(activeConnectionId, sql)
    return JSON.stringify(rows)
  }

  // Register as a JS module accessible from Python
  pyodide.registerJsModule('_linkr_bridge', { query: queryFn })

  // Define the linkr_query() Python function
  await pyodide.runPythonAsync(`
import _linkr_bridge
import pandas as pd
import json
from pyodide.ffi import to_js

def linkr_query(sql: str) -> pd.DataFrame:
    """Query the active DuckDB connection and return a pandas DataFrame."""
    result_json = _linkr_bridge.query(sql)
    rows = json.loads(result_json)
    if len(rows) == 0:
        return pd.DataFrame()
    return pd.DataFrame(rows)
`)
}

/**
 * Register `linkr_query(sql)` in the R runtime.
 * It calls through to DuckDB-WASM via JS interop and returns a data.frame.
 */
export async function registerDuckDBBridgeR(
  webR: WebR,
  activeConnectionId: string | null,
): Promise<void> {
  // Expose the query function on globalThis so R can call it via webr::eval_js
  (globalThis as Record<string, unknown>).__linkr_active_connection_id = activeConnectionId
  ;(globalThis as Record<string, unknown>).__linkr_query_fn = async (sql: string) => {
    if (!activeConnectionId) throw new Error('No active database connection. Select a connection before using linkr_query().')
    const rows = await duckdbEngine.queryDataSource(activeConnectionId, sql)
    return JSON.stringify(rows)
  }

  // Define the R wrapper function
  await webR.evalRVoid(`
    linkr_query <- function(sql) {
      result_json <- webr::eval_js(paste0(
        "await globalThis.__linkr_query_fn('",
        gsub("'", "\\\\'", sql),
        "')"
      ))
      jsonlite::fromJSON(result_json)
    }
  `)
}
