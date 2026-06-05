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

// micropip in Pyodide 0.29 has no `target` option, so packages always land in the default
// site-packages. We persist that directory manually (tar blob in IndexedDB), restoring it
// on startup — same strategy as the R engine.
const IDB_NAME = 'linkr-pyodide'
const IDB_STORE = 'site'
const IDB_KEY = 'site-packages.tar'

// Discovered at init from sys: the writable site-packages micropip installs into.
let _sitePackages = '/lib/python3.13/site-packages'
// Files present in site-packages right after a clean boot (numpy, pandas, …). We only
// persist/restore packages added on top of these, to avoid clobbering Pyodide's builtins.
let _baselineEntries = new Set<string>()

function openSiteDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGetTar(): Promise<Uint8Array | null> {
  const db = await openSiteDB()
  try {
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function idbPutTar(data: Uint8Array): Promise<void> {
  const db = await openSiteDB()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put(data, IDB_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/**
 * Tar the user-installed packages (everything in site-packages not present at clean boot)
 * into a blob saved in IndexedDB, so they survive a refresh. Best-effort.
 */
async function persistPythonSite(pyodide: PyodideInterface): Promise<void> {
  try {
    const tarPath = '/tmp/_linkr_site.tar'
    const baseline = JSON.stringify(Array.from(_baselineEntries))
    await pyodide.runPythonAsync(`
import os, tarfile, json
_site = ${JSON.stringify(_sitePackages)}
_baseline = set(json.loads(${JSON.stringify(baseline)}))
_added = [e for e in os.listdir(_site) if e not in _baseline]
with tarfile.open(${JSON.stringify('/tmp/_linkr_site.tar')}, 'w') as _t:
    for _e in _added:
        _t.add(os.path.join(_site, _e), arcname=_e)
`)
    const data = (await pyodide.FS.readFile(tarPath)) as Uint8Array
    await idbPutTar(data)
    pyodide.FS.unlink(tarPath)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[pyodide] failed to persist site-packages:', e)
  }
}

/** Restore user-installed packages from IndexedDB into site-packages. */
async function restorePythonSite(pyodide: PyodideInterface): Promise<void> {
  const data = await idbGetTar().catch(() => null)
  if (!data || data.length === 0) return
  const tarPath = '/tmp/_linkr_site_restore.tar'
  pyodide.FS.writeFile(tarPath, data)
  await pyodide.runPythonAsync(`
import tarfile, importlib
with tarfile.open(${JSON.stringify('/tmp/_linkr_site_restore.tar')}, 'r') as _t:
    _t.extractall(${JSON.stringify(_sitePackages)})
import os; os.remove(${JSON.stringify('/tmp/_linkr_site_restore.tar')})
importlib.invalidate_caches()
`)
}

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

      // Resolve the writable site-packages micropip installs into, then record its
      // contents as the baseline (so persistence only tracks user-added packages).
      try {
        _sitePackages = await pyodide.runPythonAsync(`
import site
[p for p in site.getsitepackages() if p.endswith('site-packages')][0]
`) as string
      } catch {
        // keep the default _sitePackages
      }
      try {
        const entries = await pyodide.runPythonAsync(`
import os, json
json.dumps(os.listdir(${JSON.stringify(_sitePackages)}))
`) as string
        _baselineEntries = new Set(JSON.parse(entries) as string[])
      } catch {
        // leave baseline empty — we'd persist a bit more than needed, still correct.
      }

      // Restore user-installed packages saved in a previous session.
      try {
        await restorePythonSite(pyodide)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[pyodide] failed to restore site-packages:', e)
      }

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
    await pyodide.runPythonAsync(
      `import micropip, importlib; await micropip.install('${safeName}'); importlib.invalidate_caches()`,
    )
    // Snapshot site-packages to IndexedDB so the install survives a refresh.
    await persistPythonSite(pyodide)
    onLog?.(`Successfully installed ${name}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onLog?.(`Error: ${msg}`)
    throw err
  }
}

/**
 * Update a Python package by reinstalling the latest compatible version.
 */
export async function updatePythonPackage(
  name: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  const pyodide = await getPyodide()
  const safeName = name.replace(/'/g, "\\'")
  onLog?.(`Updating ${name}...`)
  try {
    await pyodide.runPythonAsync(
      `import micropip, importlib; await micropip.install('${safeName}'); importlib.invalidate_caches()`,
    )
    await persistPythonSite(pyodide)
    onLog?.(`Successfully updated ${name}`)
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
  // micropip.uninstall removes the package's files from site-packages; re-snapshot
  // afterwards so the removal is reflected after a refresh.
  await pyodide.runPythonAsync(
    `import micropip, importlib; micropip.uninstall('${safeName}'); importlib.invalidate_caches()`,
  )
  await persistPythonSite(pyodide)
}

/**
 * List installed Python packages (name + version).
 */
export async function listPythonPackages(): Promise<{ name: string; version: string }[]> {
  const pyodide = await getPyodide()
  // List via importlib.metadata (ground truth of what's importable) rather than
  // micropip.list() — micropip's in-memory state can drift from disk after uninstall,
  // leaving removed packages lingering in the list.
  const result = pyodide.runPython(`
import json, importlib.metadata as _md
_seen = {}
for _d in _md.distributions():
    _n = _d.metadata['Name']
    if _n and _n not in _seen:
        _seen[_n] = _d.version
json.dumps([{"name": k, "version": v} for k, v in _seen.items()])
`)
  return JSON.parse(result as string) as { name: string; version: string }[]
}

/**
 * Diagnostic helper for debugging Python package persistence.
 * Exposed as window.__linkrPyDiag().
 */
export async function diagnosePythonPersistence(): Promise<Record<string, unknown>> {
  const pyodide = await getPyodide()
  const added = await pyodide.runPythonAsync(`
import os, json
_base = set(json.loads(${JSON.stringify(JSON.stringify(Array.from(_baselineEntries)))}))
json.dumps(sorted(e for e in os.listdir(${JSON.stringify(_sitePackages)}) if e not in _base))
`) as string
  const savedTar = await idbGetTar().catch(() => null)
  const diag = {
    sitePackages: _sitePackages,
    userAddedEntries: JSON.parse(added) as string[],
    idbTarBytes: savedTar?.length ?? 0,
  }
  // eslint-disable-next-line no-console
  console.log('[pyodide persistence diagnostic]', diag)
  return diag
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__linkrPyDiag = diagnosePythonPersistence
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
