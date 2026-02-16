/**
 * Pyodide (Python WASM) singleton engine.
 *
 * Pattern: lazy-loaded singleton identical to DuckDB-WASM in engine.ts.
 * The ~30MB Pyodide binary is fetched from CDN on first use only.
 */

import type { PyodideInterface } from 'pyodide'
import type { RuntimeOutput, RuntimeFigure, RuntimeStatus } from './types'
import { registerDuckDBBridgePython } from './bridge'
import { syncToPyodide, syncFromPyodide } from './shared-fs'

let _pyodide: PyodideInterface | null = null
let _initPromise: Promise<PyodideInterface> | null = null
let _status: RuntimeStatus = 'idle'
let _onStatusChange: ((s: RuntimeStatus) => void) | null = null

export function getPyodideStatus(): RuntimeStatus {
  return _status
}

export function onPyodideStatusChange(cb: (s: RuntimeStatus) => void) {
  _onStatusChange = cb
}

function setStatus(s: RuntimeStatus) {
  _status = s
  _onStatusChange?.(s)
}

/**
 * Initialize the Pyodide runtime (lazy, singleton).
 * First call triggers download from CDN (~30MB). Subsequent calls return cached instance.
 */
export async function getPyodide(): Promise<PyodideInterface> {
  if (_pyodide) return _pyodide
  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    setStatus('loading')
    try {
      const { loadPyodide } = await import('pyodide')
      const pyodide = await loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/',
      })

      // Load micropip for package management + core data science packages
      await pyodide.loadPackage(['micropip', 'numpy', 'pandas', 'matplotlib'])

      // Set up matplotlib Agg backend + figure capture helper
      await pyodide.runPythonAsync(`
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import io

def _linkr_get_figures():
    """Capture all open matplotlib figures as SVG strings, then close them."""
    figs = []
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format='svg', bbox_inches='tight')
        buf.seek(0)
        figs.append(buf.read().decode('utf-8'))
    plt.close('all')
    return figs

def _linkr_capture_table(obj):
    """Convert a pandas DataFrame to {headers, rows} dict."""
    import pandas as pd
    if isinstance(obj, pd.DataFrame):
        headers = [str(c) for c in obj.columns]
        rows = obj.head(1000).astype(str).values.tolist()
        return {'headers': headers, 'rows': rows}
    return None
`)

      _pyodide = pyodide
      setStatus('ready')
      return pyodide
    } catch (err) {
      setStatus('error')
      _initPromise = null
      throw err
    }
  })()

  return _initPromise
}

/**
 * Install a Python package via micropip.
 * Accepts version specifiers like "pandas==2.0.0".
 * The optional `onLog` callback receives progress messages.
 */
export async function installPythonPackage(
  name: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  const pyodide = await getPyodide()
  const safeName = name.replace(/'/g, "\\'")
  onLog?.(`Installing ${name}...`)
  try {
    await pyodide.runPythonAsync(`import micropip; await micropip.install('${safeName}')`)
    onLog?.(`Successfully installed ${name}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onLog?.(`Error: ${msg}`)
    throw err
  }
}

/**
 * Uninstall a Python package via micropip.
 */
export async function uninstallPythonPackage(name: string): Promise<void> {
  const pyodide = await getPyodide()
  const safeName = name.replace(/'/g, "\\'")
  await pyodide.runPythonAsync(`import micropip; micropip.uninstall('${safeName}')`)
}

/**
 * List installed Python packages (name + version).
 */
export async function listPythonPackages(): Promise<{ name: string; version: string }[]> {
  const pyodide = await getPyodide()
  const result = pyodide.runPython(`
import json, micropip
json.dumps([{"name": p.name, "version": p.version} for p in micropip.list()])
`)
  return JSON.parse(result as string) as { name: string; version: string }[]
}

/**
 * Execute Python code and return structured output.
 */
export async function executePython(
  code: string,
  activeConnectionId: string | null,
  _signal?: AbortSignal,
): Promise<RuntimeOutput> {
  const pyodide = await getPyodide()
  setStatus('executing')

  // Register/update DuckDB bridge with current connection
  await registerDuckDBBridgePython(pyodide, activeConnectionId)

  // Capture stdout/stderr
  let stdout = ''
  let stderr = ''
  pyodide.setStdout({ batched: (msg: string) => { stdout += msg + '\n' } })
  pyodide.setStderr({ batched: (msg: string) => { stderr += msg + '\n' } })

  const figures: RuntimeFigure[] = []
  let table: RuntimeOutput['table'] = null

  try {
    // Ensure common directories exist in Pyodide's virtual filesystem
    // so user scripts can write files (e.g. dataset.to_csv("data/datasets/foo.csv"))
    await pyodide.runPythonAsync(`
import os
for _d in ['data', 'data/databases', 'data/datasets']:
    os.makedirs(_d, exist_ok=True)
del _d
`)

    // Sync shared files into Pyodide FS (e.g. files created by R)
    await syncToPyodide(pyodide)

    // Auto-detect imports and load packages
    await pyodide.loadPackagesFromImports(code, {
      messageCallback: () => {},
      errorCallback: (msg: string) => { stderr += msg + '\n' },
    })

    // Execute the code
    const result = await pyodide.runPythonAsync(code)

    // Try to capture the result as a table (if it's a DataFrame)
    // Use the return value from runPythonAsync, or fall back to a `result` variable in globals
    let pythonResult = result
    if (pythonResult === undefined || pythonResult === null) {
      try {
        const globalResult = pyodide.globals.get('result')
        if (globalResult !== undefined && globalResult !== null) {
          pythonResult = globalResult
        }
      } catch {
        // No 'result' variable in globals
      }
    }
    if (pythonResult !== undefined && pythonResult !== null) {
      try {
        pyodide.globals.set('_linkr_last_result', pythonResult)
        const tableResult = pyodide.runPython(`_linkr_capture_table(_linkr_last_result)`) as {
          headers: string[]
          rows: string[][]
        } | null

        if (tableResult && typeof tableResult === 'object' && 'headers' in tableResult) {
          // Convert proxy to JS
          const headers = (tableResult.headers as unknown as { toJs: () => string[] }).toJs
            ? (tableResult.headers as unknown as { toJs: () => string[] }).toJs()
            : Array.from(tableResult.headers as Iterable<string>)
          const rawRows = (tableResult.rows as unknown as { toJs: () => unknown[][] }).toJs
            ? (tableResult.rows as unknown as { toJs: () => unknown[][] }).toJs()
            : Array.from(tableResult.rows as Iterable<unknown[]>)
          const rows = rawRows.map((r: unknown[]) =>
            Array.from(r as Iterable<unknown>).map(String),
          )
          table = { headers, rows }
        }
        pyodide.runPython(`del _linkr_last_result`)
      } catch {
        // Not a DataFrame — ignore
      }
    }

    // Capture matplotlib figures
    try {
      const figsProxy = pyodide.runPython('_linkr_get_figures()')
      if (figsProxy) {
        const figsList: string[] = (figsProxy as unknown as { toJs: () => string[] }).toJs
          ? (figsProxy as unknown as { toJs: () => string[] }).toJs()
          : []
        for (let i = 0; i < figsList.length; i++) {
          figures.push({
            id: `py-fig-${Date.now()}-${i}`,
            type: 'svg',
            data: figsList[i],
            label: `Figure ${i + 1}`,
          })
        }
        if (typeof (figsProxy as { destroy?: () => void }).destroy === 'function') {
          (figsProxy as { destroy: () => void }).destroy()
        }
      }
    } catch {
      // No figures
    }

    // Clean up result proxy
    if (result && typeof result === 'object' && 'destroy' in result) {
      (result as { destroy: () => void }).destroy()
    }

    // Sync files written by Python into the shared store (for R, IDE explorer)
    await syncFromPyodide(pyodide)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    stderr += message + '\n'
  } finally {
    setStatus('ready')
  }

  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), figures, table, html: null }
}
