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

      // Install core packages
      await webR.installPackages(['jsonlite'])

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
    await webR.installPackages([name])
    onLog?.(`Successfully installed ${name}`)
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
  await webR.evalRVoid(`remove.packages('${safeName}')`)
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
 * Execute R code and return structured output.
 */
export async function executeR(
  code: string,
  activeConnectionId: string | null,
  _signal?: AbortSignal,
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

    const captured = await shelter.captureR(code, {
      withAutoprint: true,
      captureStreams: true,
      captureConditions: false,
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
  }): Promise<{
    result: { type(): Promise<string> }
    output: { type: string; data: unknown }[]
    images: ImageBitmap[]
  }>
  purge(): void
}
