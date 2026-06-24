/**
 * webR (R WASM) singleton engine.
 *
 * Pattern: lazy-loaded singleton identical to DuckDB-WASM in engine.ts.
 * The ~30MB webR binary is fetched from CDN on first use only.
 */

import type { WebR } from 'webr'
import type { RuntimeOutput, RuntimeFigure, RuntimeStatus } from './types'
import { registerDuckDBBridgeR } from './bridge'
import { syncToWebR, syncFromWebR } from './shared-fs'

let _webR: WebR | null = null
let _initPromise: Promise<WebR> | null = null
let _status: RuntimeStatus = 'idle'
let _onStatusChange: ((s: RuntimeStatus) => void) | null = null

// User-installed packages live here. webR runs over a SharedArrayBuffer channel, which
// is incompatible with IDBFS, so we persist this directory manually: it's tarred into a
// single blob stored in IndexedDB after each change, and restored on startup.
const PERSIST_LIB = '/home/web_user/r-library'
const IDB_NAME = 'linkr-webr'
const IDB_STORE = 'rlib'
const IDB_KEY = 'library.tar'

function openLibDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGetTar(): Promise<Uint8Array | null> {
  const db = await openLibDB()
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
  const db = await openLibDB()
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
 * Serialize the persistent R library to a tar blob in IndexedDB so installs survive
 * a refresh. Best-effort: a failure only means this session's installs aren't persisted.
 */
async function persistRLibrary(webR: WebR): Promise<void> {
  try {
    const tarPath = '/tmp/_linkr_rlib.tar'
    // tar the library's contents with paths relative to PERSIST_LIB, so untar restores
    // them straight back into the same dir.
    await webR.evalRVoid(`
      .owd <- getwd(); setwd('${PERSIST_LIB}')
      on.exit(setwd(.owd))
      utils::tar('${tarPath}', files = list.files('.'), compression = 'none', tar = 'internal')
    `)
    const data = (await webR.FS.readFile(tarPath)) as Uint8Array
    await idbPutTar(data)
    await webR.evalRVoid(`unlink('${tarPath}')`)
  } catch (e) {

    console.warn('[webR] failed to persist R library:', e)
  }
}

/** Restore the persistent R library from IndexedDB into webR's in-memory FS. */
async function restoreRLibrary(webR: WebR): Promise<void> {
  const data = await idbGetTar().catch(() => null)
  if (!data || data.length === 0) return
  const tarPath = '/tmp/_linkr_rlib_restore.tar'
  await webR.FS.writeFile(tarPath, data)
  await webR.evalRVoid(`
    dir.create('${PERSIST_LIB}', recursive = TRUE, showWarnings = FALSE)
    utils::untar('${tarPath}', exdir = '${PERSIST_LIB}', tar = 'internal')
    unlink('${tarPath}')
  `)
}

export function getWebRStatus(): RuntimeStatus {
  return _status
}

export function onWebRStatusChange(cb: (s: RuntimeStatus) => void) {
  _onStatusChange = cb
}

function setStatus(s: RuntimeStatus) {
  _status = s
  _onStatusChange?.(s)
}

/**
 * Initialize the webR runtime (lazy, singleton).
 * First call triggers download (~30MB). Subsequent calls return cached instance.
 */
export async function getWebR(): Promise<WebR> {
  if (_webR) return _webR
  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    setStatus('loading')
    try {
      const { WebR: WebRClass } = await import('webr')
      const webR = new WebRClass()
      await webR.init()

      // Create the persistent library dir, restore packages saved in a previous session
      // from IndexedDB, and prepend it to .libPaths() so it's used for install + loading.
      // (IDBFS can't be used: webR runs over SharedArrayBuffer, which IDBFS doesn't support.)
      await webR.evalRVoid(`dir.create('${PERSIST_LIB}', recursive = TRUE, showWarnings = FALSE)`)
      try {
        await restoreRLibrary(webR)
      } catch (e) {

        console.warn('[webR] failed to restore R library:', e)
      }
      await webR.evalRVoid(`.libPaths(c('${PERSIST_LIB}', .libPaths()))`)

      // Install core packages into the persistent lib only if not already present.
      // `mount: false` forces a real copy into the library (mounted FS images don't persist).
      const haveJsonlite = await webR.evalRRaw(
        `requireNamespace('jsonlite', quietly = TRUE)`,
        'boolean',
      ) as boolean
      if (!haveJsonlite) {
        await webR.installPackages(['jsonlite'], { mount: false })
        await persistRLibrary(webR)
      }

      _webR = webR
      setStatus('ready')
      return webR
    } catch (err) {
      setStatus('error')
      _initPromise = null
      throw err
    }
  })()

  return _initPromise
}

/**
 * Install an R package via webR.
 * The optional `onLog` callback receives progress messages.
 */
export async function installRPackage(
  name: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  const webR = await getWebR()
  onLog?.(`Installing ${name}...`)
  try {
    // `mount: false` writes a real copy into the persistent library (see getWebR).
    await webR.installPackages([name], { mount: false })
    await persistRLibrary(webR)
    onLog?.(`Successfully installed ${name}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onLog?.(`Error: ${msg}`)
    throw err
  }
}

/**
 * Update an R package by reinstalling the latest available binary.
 */
export async function updateRPackage(
  name: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  const webR = await getWebR()
  onLog?.(`Updating ${name}...`)
  try {
    await webR.installPackages([name], { mount: false })
    await persistRLibrary(webR)
    onLog?.(`Successfully updated ${name}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onLog?.(`Error: ${msg}`)
    throw err
  }
}

/**
 * Uninstall an R package via remove.packages().
 */
export async function uninstallRPackage(name: string): Promise<void> {
  const webR = await getWebR()
  const safeName = name.replace(/'/g, "\\'")
  // Remove from whichever lib path actually holds it (persistent dir takes priority).
  await webR.evalRVoid(`
    .pkg <- '${safeName}'
    .loc <- find.package(.pkg, quiet = TRUE)
    if (length(.loc) > 0) remove.packages(.pkg, lib = dirname(.loc[1]))
  `)
  await persistRLibrary(webR)
}

/**
 * List installed R packages (name + version).
 */
export async function listRPackages(): Promise<{ name: string; version: string }[]> {
  const webR = await getWebR()
  const raw = await webR.evalRRaw(
    `paste(installed.packages()[,"Package"], installed.packages()[,"Version"], sep="@")`,
    'string[]',
  ) as string[]
  return raw.map((entry) => {
    const [name, version] = entry.split('@')
    return { name, version }
  })
}

/** Interrupt a running R computation. */
export function interruptR() {
  _webR?.interrupt()
}

/**
 * Best-effort vector re-render of a single plot: webR's canvas device is raster, so plots look
 * soft on screen. Redraw the same code into an svglite device and return its crisp SVG. Returns
 * null when svglite is unavailable or no valid SVG is produced, so the caller keeps the PNG.
 * Limited to one plot because svglite has no multi-page support.
 */
async function renderRPlotAsSvg(webR: WebR, code: string): Promise<string | null> {
  await webR.FS.writeFile('/tmp/_linkr_svg_code.R', new TextEncoder().encode(code))
  const svg = await webR.evalRString(`local({
    if (!requireNamespace("svglite", quietly = TRUE)) return("")
    f <- tempfile(fileext = ".svg")
    if (!isTRUE(tryCatch({ svglite::svglite(f, width = 7, height = 7, pointsize = 11); TRUE }, error = function(e) FALSE))) return("")
    tryCatch(source("/tmp/_linkr_svg_code.R", local = FALSE, print.eval = TRUE), error = function(e) NULL)
    try(dev.off(), silent = TRUE)
    if (file.exists(f) && file.info(f)$size > 0) paste(readLines(f, warn = FALSE), collapse = "\n") else ""
  })`)
  return svg.includes('<svg') ? svg : null
}

/**
 * Execute R code and return structured output.
 */
export async function executeR(
  code: string,
  activeConnectionId: string | null,
  _signal?: AbortSignal,
  tryVectorPlot = false,
): Promise<RuntimeOutput> {
  const webR = await getWebR()
  setStatus('executing')

  // Register/update DuckDB bridge
  await registerDuckDBBridgeR(webR, activeConnectionId)

  // Ensure common directories exist in webR's virtual filesystem
  await webR.evalRVoid(`
    for (d in c("data", "data/databases", "data/datasets")) {
      dir.create(d, recursive = TRUE, showWarnings = FALSE)
    }
  `)

  // Sync shared files into webR FS (e.g. CSV files created by Python)
  await syncToWebR(webR)

  let stdout = ''
  let stderr = ''
  const figures: RuntimeFigure[] = []
  let table: RuntimeOutput['table'] = null

  try {
    // Use shelter.captureR for output and plot capture
    const shelter = await new (webR as unknown as { Shelter: new () => Promise<Shelter> }).Shelter()

    // webr::canvas() defaults to 1008×1008 @ pointsize 12. Scaling width, height and pointsize
    // together raises the raster resolution without changing the plot's proportions. This helps
    // high-DPI export; on-screen sharpness is bounded by the canvas device's raster text rendering.
    const R_PLOT_SCALE = 2
    const captured = await shelter.captureR(code, {
      withAutoprint: true,
      captureStreams: true,
      captureConditions: false,
      captureGraphics: {
        width: 1008 * R_PLOT_SCALE,
        height: 1008 * R_PLOT_SCALE,
        pointsize: 12 * R_PLOT_SCALE,
      },
    })

    // Process output lines
    for (const line of captured.output) {
      if (line.type === 'stdout') {
        stdout += String(line.data) + '\n'
      } else if (line.type === 'stderr') {
        stderr += String(line.data) + '\n'
      }
    }

    // Process captured images (ImageBitmap[])
    for (let i = 0; i < captured.images.length; i++) {
      const bitmap = captured.images[i]
      try {
        // Convert ImageBitmap to PNG data URI
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        const blob = await canvas.convertToBlob({ type: 'image/png' })
        const arrayBuf = await blob.arrayBuffer()
        const bytes = new Uint8Array(arrayBuf)
        let binary = ''
        for (let j = 0; j < bytes.length; j++) {
          binary += String.fromCharCode(bytes[j])
        }
        const dataUri = `data:image/png;base64,${btoa(binary)}`
        figures.push({
          id: `r-fig-${Date.now()}-${i}`,
          type: 'png',
          data: dataUri,
          label: `Plot ${i + 1}`,
        })
      } finally {
        bitmap.close()
      }
    }

    // Upgrade a single raster plot to crisp vector SVG when possible (best-effort, falls back
    // to the PNG above). One plot only — svglite can't write multiple pages.
    if (tryVectorPlot && figures.length === 1 && figures[0].type === 'png') {
      try {
        const svg = await renderRPlotAsSvg(webR, code)
        if (svg) figures[0] = { ...figures[0], type: 'svg', data: svg }
      } catch {
        // keep the PNG fallback
      }
    }

    // Try to detect data.frame result → convert to table.
    // We bind captured.result into R's global env so we can inspect it directly,
    // since .Last.value may not reliably reflect the shelter result.
    try {
      const resultType = await captured.result.type()
      if (resultType === 'list') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (webR as any).objs.globalEnv.bind('.__linkr_last_result__', captured.result)
        const isDF = await webR.evalRRaw(
          `is.data.frame(.__linkr_last_result__)`,
          'boolean',
        )
        if (isDF) {
          const jsonStr = await webR.evalRRaw(
            `jsonlite::toJSON(.__linkr_last_result__, dataframe="columns")`,
            'string',
          )
          const parsed = JSON.parse(jsonStr) as Record<string, unknown[]>
          const headers = Object.keys(parsed)
          if (headers.length > 0) {
            const rowCount = Math.min((parsed[headers[0]] ?? []).length, 1000)
            const rows: string[][] = []
            for (let r = 0; r < rowCount; r++) {
              rows.push(headers.map((h) => String(parsed[h]?.[r] ?? '')))
            }
            table = { headers, rows }
          }
        }
        await webR.evalRVoid(`rm(.__linkr_last_result__)`)
      }
    } catch {
      // Not a data.frame — ignore
    }

    // Clean up shelter
    shelter.purge()

    // Sync files written by R into the shared store (for Python, IDE explorer)
    await syncFromWebR(webR)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    stderr += message + '\n'
  } finally {
    setStatus('ready')
  }

  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), figures, table, html: null }
}

// Internal type for webR Shelter — not exported from webR types
interface Shelter {
  captureR(code: string, options?: {
    withAutoprint?: boolean
    captureStreams?: boolean
    captureConditions?: boolean
    captureGraphics?: { width: number; height: number; pointsize: number } | boolean
  }): Promise<{
    result: { type(): Promise<string> }
    output: { type: string; data: unknown }[]
    images: ImageBitmap[]
  }>
  purge(): void
}
