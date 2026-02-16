/**
 * Shared virtual filesystem bridge between Pyodide and webR.
 *
 * Each WASM runtime (Pyodide, webR) has its own isolated in-memory filesystem.
 * This module provides a JS-side store (Map) that synchronises files written
 * in one runtime so they can be read in the other.
 *
 * Flow:
 *   1. After Python execution → syncFromPyodide() reads data/datasets/* into _sharedFiles
 *   2. Before R execution     → syncToWebR() writes _sharedFiles into webR's Emscripten FS
 *   3. After R execution      → syncFromWebR() reads data/datasets/* back
 *   4. Before Python execution→ syncToPyodide() writes any files R created
 */

import type { PyodideInterface } from 'pyodide'
import type { WebR } from 'webr'

/** Emscripten FS methods used at runtime but not fully typed in Pyodide's .d.ts */
interface EmscriptenFS {
  readFile(path: string, opts?: { encoding?: string }): Uint8Array
  writeFile(path: string, data: ArrayBufferView | string): void
}

/** In-memory store: relative path (e.g. "data/datasets/foo.csv") → file bytes */
const _sharedFiles = new Map<string, Uint8Array>()

/** Callback notified whenever shared files change (for IDE explorer refresh). */
let _onFilesChanged: ((files: Map<string, Uint8Array>) => void) | null = null

export function onSharedFilesChanged(cb: ((files: Map<string, Uint8Array>) => void) | null) {
  _onFilesChanged = cb
}

export function getSharedFiles(): Map<string, Uint8Array> {
  return _sharedFiles
}

// ---------------------------------------------------------------------------
// Pyodide ↔ shared store
// ---------------------------------------------------------------------------

/** After Python execution: read all files from data/datasets/ into the shared store. */
export async function syncFromPyodide(pyodide: PyodideInterface): Promise<void> {
  // Get the list of files in data/datasets/
  const fileListJson = pyodide.runPython(`
import os, json
_files = []
_dir = 'data/datasets'
if os.path.isdir(_dir):
    for _f in os.listdir(_dir):
        _fp = os.path.join(_dir, _f)
        if os.path.isfile(_fp):
            _files.append(_fp)
json.dumps(_files)
`) as string

  const filePaths = JSON.parse(fileListJson) as string[]
  if (filePaths.length === 0) return

  // Access Emscripten FS (typed as 'any' — readFile/writeFile exist at runtime)
  const FS = pyodide.FS as EmscriptenFS

  let changed = false
  for (const fp of filePaths) {
    const bytes = FS.readFile(fp) as Uint8Array
    const existing = _sharedFiles.get(fp)
    if (!existing || existing.length !== bytes.length || !existing.every((v, i) => v === bytes[i])) {
      _sharedFiles.set(fp, new Uint8Array(bytes))
      changed = true
    }
  }
  if (changed) _onFilesChanged?.(_sharedFiles)
}

/** Before Python execution: write shared files into Pyodide FS (e.g. files created by R). */
export async function syncToPyodide(pyodide: PyodideInterface): Promise<void> {
  if (_sharedFiles.size === 0) return

  const FS = pyodide.FS as EmscriptenFS
  for (const [path, bytes] of _sharedFiles) {
    FS.writeFile(path, bytes)
  }
}

// ---------------------------------------------------------------------------
// webR ↔ shared store
// ---------------------------------------------------------------------------

/** Ensure a directory path exists in webR's Emscripten FS. */
async function ensureWebRDir(webR: WebR, dirPath: string): Promise<void> {
  const parts = dirPath.split('/')
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    try {
      const info = await webR.FS.analyzePath(current)
      if (!info.exists) {
        await webR.FS.mkdir(current)
      }
    } catch {
      try { await webR.FS.mkdir(current) } catch { /* already exists */ }
    }
  }
}

/** Before R execution: write shared files into webR's Emscripten FS. */
export async function syncToWebR(webR: WebR): Promise<void> {
  if (_sharedFiles.size === 0) return

  for (const [path, bytes] of _sharedFiles) {
    const dir = path.substring(0, path.lastIndexOf('/'))
    await ensureWebRDir(webR, dir)
    await webR.FS.writeFile(path, bytes)
  }
}

/** After R execution: read files from data/datasets/ back into the shared store. */
export async function syncFromWebR(webR: WebR): Promise<void> {
  // Check if data/datasets exists
  let dirInfo
  try {
    dirInfo = await webR.FS.analyzePath('data/datasets')
  } catch {
    return
  }
  if (!dirInfo.exists || !dirInfo.object?.isFolder) return

  // List files in the directory
  const contents = dirInfo.object.contents ?? {}
  let changed = false
  for (const [name, node] of Object.entries(contents)) {
    if (node.isFolder) continue
    const filePath = `data/datasets/${name}`
    const bytes = await webR.FS.readFile(filePath)
    const existing = _sharedFiles.get(filePath)
    if (!existing || existing.length !== bytes.length || !existing.every((v, i) => v === bytes[i])) {
      _sharedFiles.set(filePath, new Uint8Array(bytes))
      changed = true
    }
  }
  if (changed) _onFilesChanged?.(_sharedFiles)
}
