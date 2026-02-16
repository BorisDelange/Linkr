/**
 * Cell executor abstraction for marimo notebooks.
 *
 * PyodideCellExecutor uses the existing Pyodide singleton for local mode.
 * FastAPICellExecutor (future) will POST to the backend for server mode.
 */

import { getPyodide } from './runtimes/pyodide-engine'
import { registerDuckDBBridgePython } from './runtimes/bridge'
import type { PyodideInterface } from 'pyodide'

export interface CellResult {
  success: boolean
  stdout: string
  stderr: string
  figures: { type: 'svg' | 'png'; data: string }[]
  table: { headers: string[]; rows: string[][] } | null
  html?: string
  error?: string
}

export interface CellExecutor {
  execute(code: string, cellId: string): Promise<CellResult>
  reset(): Promise<void>
  isReady(): boolean
}

/**
 * Executes notebook cells using the browser's Pyodide WASM runtime.
 * All cells share the same Pyodide globals (namespace), so variables
 * defined in one cell are visible to other cells.
 */
export class PyodideCellExecutor implements CellExecutor {
  private _pyodide: PyodideInterface | null = null
  private _ready = false
  private _activeConnectionId: string | null = null

  setActiveConnectionId(id: string | null) {
    this._activeConnectionId = id
  }

  isReady(): boolean {
    return this._ready
  }

  async execute(code: string, _cellId: string): Promise<CellResult> {
    const pyodide = await this._ensurePyodide()

    let stdout = ''
    let stderr = ''
    const figures: CellResult['figures'] = []
    let table: CellResult['table'] = null

    // Per-cell stdout/stderr isolation
    pyodide.setStdout({ batched: (msg: string) => { stdout += msg + '\n' } })
    pyodide.setStderr({ batched: (msg: string) => { stderr += msg + '\n' } })

    try {
      // Auto-detect and load imported packages
      await pyodide.loadPackagesFromImports(code, {
        messageCallback: () => {},
        errorCallback: (msg: string) => { stderr += msg + '\n' },
      })

      // Execute the cell code
      const result = await pyodide.runPythonAsync(code)

      // Capture mo.md() markdown output
      let html: string | undefined
      if (result !== undefined && result !== null) {
        try {
          pyodide.globals.set('_linkr_cell_result', result)
          const mdText = pyodide.runPython(
            `getattr(_linkr_cell_result, 'text', None) if type(_linkr_cell_result).__name__ == '_MoMd' else None`
          )
          if (mdText && typeof mdText === 'string') {
            html = mdText
          }
          pyodide.runPython('del _linkr_cell_result')
        } catch {
          try { pyodide.runPython('del _linkr_cell_result') } catch { /* ignore */ }
        }
      }

      // Try to capture return value as a table
      table = this._captureTable(pyodide, result)

      // Capture matplotlib figures
      figures.push(...this._captureFigures(pyodide))

      // Clean up result proxy
      if (result && typeof result === 'object' && 'destroy' in result) {
        (result as { destroy: () => void }).destroy()
      }

      return {
        success: true,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        figures,
        table,
        html,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        figures,
        table,
        error: message,
      }
    }
  }

  async reset(): Promise<void> {
    if (!this._pyodide) return
    // Clear user-defined globals, keeping builtins and our helpers
    await this._pyodide.runPythonAsync(`
import sys as _sys
_keep = set(dir(__builtins__)) | {
    '__builtins__', '__name__', '__doc__', '__package__', '__spec__',
    '_linkr_get_figures', '_linkr_capture_table',
    'plt', 'matplotlib', 'io', 'os', 'sys', 'np', 'pd',
    'numpy', 'pandas', 'micropip', 'sql_query',
    'mo', '_MoMd', '_MoNoOp', '_MoStub',
    '_sys', '_keep',
}
for _name in list(globals()):
    if _name not in _keep:
        try:
            del globals()[_name]
        except:
            pass
del _keep, _name, _sys
`)
  }

  private async _ensurePyodide(): Promise<PyodideInterface> {
    if (this._pyodide) return this._pyodide
    const pyodide = await getPyodide()
    this._pyodide = pyodide
    this._ready = true

    // Register DuckDB bridge
    await registerDuckDBBridgePython(pyodide, this._activeConnectionId)

    // Ensure virtual directories exist
    await pyodide.runPythonAsync(`
import os
for _d in ['data', 'data/databases', 'data/datasets']:
    os.makedirs(_d, exist_ok=True)
del _d
`)

    // Register marimo stub so mo.md(...) works in notebook cells
    await pyodide.runPythonAsync(`
import types as _types

class _MoMd:
    """Stub for mo.md() — stores markdown text for capture."""
    def __init__(self, text):
        import textwrap
        self.text = textwrap.dedent(text).strip()
    def __repr__(self):
        return self.text

class _MoNoOp:
    """Catch-all no-op: any attribute access, call, or context manager returns another _MoNoOp."""
    def __getattr__(self, name):
        return _MoNoOp()
    def __call__(self, *args, **kwargs):
        return _MoNoOp()
    def __enter__(self):
        return self
    def __exit__(self, *exc):
        return False
    def __repr__(self):
        return ''
    def __bool__(self):
        return False
    def __iter__(self):
        return iter([])

class _MoStub:
    """Marimo stub — mo.md() produces renderable markdown, everything else is a silent no-op."""
    def __init__(self):
        self.ui = _MoNoOp()
    def md(self, text):
        return _MoMd(text)
    def __getattr__(self, name):
        return _MoNoOp()

# Make 'mo' available as a module-like object
mo = _MoStub()

# Also register as an importable module so 'import marimo as mo' works
_marimo_mod = _types.ModuleType('marimo')
_marimo_mod.App = type('App', (), {'__init__': lambda self, **kw: None})
import sys
sys.modules['marimo'] = _marimo_mod
del _types, _marimo_mod
`)

    return pyodide
  }

  private _captureTable(pyodide: PyodideInterface, result: unknown): CellResult['table'] {
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

    if (pythonResult === undefined || pythonResult === null) return null

    try {
      pyodide.globals.set('_linkr_last_result', pythonResult)
      const tableResult = pyodide.runPython(`_linkr_capture_table(_linkr_last_result)`) as {
        headers: string[]
        rows: string[][]
      } | null

      if (tableResult && typeof tableResult === 'object' && 'headers' in tableResult) {
        const headers = (tableResult.headers as unknown as { toJs: () => string[] }).toJs
          ? (tableResult.headers as unknown as { toJs: () => string[] }).toJs()
          : Array.from(tableResult.headers as Iterable<string>)
        const rawRows = (tableResult.rows as unknown as { toJs: () => unknown[][] }).toJs
          ? (tableResult.rows as unknown as { toJs: () => unknown[][] }).toJs()
          : Array.from(tableResult.rows as Iterable<unknown[]>)
        const rows = rawRows.map((r: unknown[]) =>
          Array.from(r as Iterable<unknown>).map(String),
        )
        pyodide.runPython(`del _linkr_last_result`)
        return { headers, rows }
      }
      pyodide.runPython(`del _linkr_last_result`)
    } catch {
      // Not a DataFrame
      try { pyodide.runPython(`del _linkr_last_result`) } catch { /* ignore */ }
    }

    return null
  }

  private _captureFigures(pyodide: PyodideInterface): CellResult['figures'] {
    const figures: CellResult['figures'] = []
    try {
      const figsProxy = pyodide.runPython('_linkr_get_figures()')
      if (figsProxy) {
        const figsList: string[] = (figsProxy as unknown as { toJs: () => string[] }).toJs
          ? (figsProxy as unknown as { toJs: () => string[] }).toJs()
          : []
        for (const svg of figsList) {
          figures.push({ type: 'svg', data: svg })
        }
        if (typeof (figsProxy as { destroy?: () => void }).destroy === 'function') {
          (figsProxy as { destroy: () => void }).destroy()
        }
      }
    } catch {
      // No figures
    }
    return figures
  }
}
