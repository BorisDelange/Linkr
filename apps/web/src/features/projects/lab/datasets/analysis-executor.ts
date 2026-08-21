/**
 * Analysis executor — runs analysis scripts with dataset injection.
 *
 * Supports Python (Pyodide) and R (webR) runtimes.
 * Injects dataset rows as a DataFrame / data.frame named `dataset`,
 * then executes the user's analysis code.
 */

import type { RuntimeOutput } from '@/lib/runtimes/types'
import type { DatasetColumn } from '@/types'
import { executePython } from '@/lib/runtimes/pyodide-engine'
import { getWebR, executeR } from '@/lib/runtimes/webr-engine'

/**
 * Build the Python preamble that creates the `dataset` DataFrame.
 *
 * Rows in the store are keyed by column.id (e.g. 'col-1728394').
 * We remap to column.name (e.g. 'age') for the user-facing DataFrame.
 *
 * The JSON data is embedded directly in the code string (base64-encoded)
 * instead of passed via Pyodide globals to avoid race conditions when
 * multiple executions run concurrently (e.g. dashboard widgets).
 */
function buildInjectionCode(columns: DatasetColumn[], jsonDataB64: string): string {
  const renameEntries = columns
    .map((c) => `    ${JSON.stringify(c.id)}: ${JSON.stringify(c.name)}`)
    .join(',\n')

  const coercions = columns
    .map((c) => {
      if (c.type === 'number')
        return `dataset[${JSON.stringify(c.name)}] = pd.to_numeric(dataset[${JSON.stringify(c.name)}], errors='coerce')`
      if (c.type === 'date')
        return `dataset[${JSON.stringify(c.name)}] = pd.to_datetime(dataset[${JSON.stringify(c.name)}], errors='coerce')`
      return null
    })
    .filter(Boolean)
    .join('\n')

  return `
import pandas as pd
import numpy as np
import json as _json
import base64 as _b64

_raw = _json.loads(_b64.b64decode(${JSON.stringify(jsonDataB64)}).decode('utf-8'))
dataset = pd.DataFrame(_raw)
dataset = dataset.rename(columns={
${renameEntries}
})
${coercions}
del _raw, _json, _b64
`
}

/**
 * Execute an analysis Python script against a dataset.
 *
 * @param code      The Python code to execute (user or generated)
 * @param rows      Dataset rows keyed by column.id
 * @param columns   Column metadata for type coercion and name mapping
 * @returns         RuntimeOutput with captured table, figures, stdout, stderr
 */
export async function executeAnalysisCode(
  code: string,
  rows: Record<string, unknown>[],
  columns: DatasetColumn[],
): Promise<RuntimeOutput> {
  // Encode data as base64 to embed in the code string directly.
  // This avoids using Pyodide globals which are shared and can race.
  const jsonData = JSON.stringify(rows)
  const jsonDataB64 = btoa(unescape(encodeURIComponent(jsonData)))

  const preamble = buildInjectionCode(columns, jsonDataB64)
  const fullCode = preamble + '\n' + code

  // Execute through the existing Pyodide engine (captures table, figures, stdout, stderr)
  return executePython(fullCode, null)
}

// ---------------------------------------------------------------------------
// R execution
// ---------------------------------------------------------------------------

/**
 * Serialise rows as a column-oriented JSON object: { "<column name>": [values...] }.
 *
 * Row-oriented JSON forces jsonlite to infer the frame's shape, and a single cell
 * holding an object/array (or a column that is entirely null) makes it return a
 * nested list instead of a vector — which then blows up as an opaque
 * "RangeError: Invalid array length" when webR builds the data.frame. Emitting
 * columns of equal length, with every non-scalar flattened to a string and
 * undefined normalised to null, keeps the shape deterministic.
 *
 * Renaming happens here too (rows are keyed by column.id), so R never has to
 * reorder names against colnames().
 */
export function buildRColumnData(
  rows: Record<string, unknown>[],
  columns: DatasetColumn[],
): Record<string, (string | number | boolean | null)[]> {
  const out: Record<string, (string | number | boolean | null)[]> = {}
  const used = new Set<string>()
  for (const col of columns) {
    const values = rows.map((row) => {
      const v = row[col.id]
      if (v === undefined || v === null) return null
      if (typeof v === 'number') return Number.isFinite(v) ? v : null
      if (typeof v === 'boolean' || typeof v === 'string') return v
      // Objects/arrays/dates have no scalar R equivalent — stringify so the
      // column stays a flat character vector rather than a nested list.
      if (v instanceof Date) return v.toISOString()
      return JSON.stringify(v)
    })
    // A duplicate name would silently overwrite the earlier column (JSON keys are
    // unique), dropping data and desyncing the frame from the coercion list.
    let key = col.name
    for (let i = 2; used.has(key); i++) key = `${col.name}.${i}`
    used.add(key)
    out[key] = values
  }
  return out
}

/**
 * Build the R preamble that creates the `dataset` data.frame.
 *
 * Reads the column-oriented JSON written by executeAnalysisCodeR with
 * simplifyVector only (no data.frame guessing), then assembles the frame
 * explicitly. Types are coerced to match the column metadata.
 */
function buildRInjectionCode(columns: DatasetColumn[]): string {
  const coercions = columns
    .map((c) => {
      const name = JSON.stringify(c.name)
      if (c.type === 'number')
        return `if (${name} %in% colnames(dataset)) dataset[[${name}]] <- as.numeric(dataset[[${name}]])`
      if (c.type === 'date')
        return `if (${name} %in% colnames(dataset)) dataset[[${name}]] <- as.POSIXct(dataset[[${name}]], tryFormats = c("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"))`
      return null
    })
    .filter(Boolean)
    .join('\n')

  // check.names = FALSE: column names are user-facing and must survive verbatim
  // (R would otherwise mangle spaces and accents into dots).
  return `library(jsonlite)
.linkr_cols <- fromJSON("/tmp/_linkr_dataset.json", simplifyDataFrame = FALSE, simplifyMatrix = FALSE)
.linkr_n <- if (length(.linkr_cols) > 0) length(.linkr_cols[[1]]) else 0
dataset <- if (length(.linkr_cols) == 0) data.frame() else as.data.frame(
  lapply(.linkr_cols, function(.col) {
    .v <- unlist(lapply(.col, function(.x) if (is.null(.x)) NA else .x), use.names = FALSE)
    if (length(.v) == 0) rep(NA, .linkr_n) else .v
  }),
  stringsAsFactors = FALSE,
  check.names = FALSE
)
rm(.linkr_cols, .linkr_n)
${coercions}
`
}

/**
 * Execute an analysis R script against a dataset.
 */
export async function executeAnalysisCodeR(
  code: string,
  rows: Record<string, unknown>[],
  columns: DatasetColumn[],
): Promise<RuntimeOutput> {
  const webR = await getWebR()

  // Write dataset JSON to webR virtual filesystem (column-oriented — see buildRColumnData)
  const jsonData = JSON.stringify(buildRColumnData(rows, columns))
  const encoder = new TextEncoder()
  const bytes = encoder.encode(jsonData)
  await webR.FS.writeFile('/tmp/_linkr_dataset.json', bytes)

  const preamble = buildRInjectionCode(columns)
  const fullCode = preamble + '\n' + code

  // Enable the vector (svglite) re-render so analysis/dashboard plots are crisp on screen.
  return executeR(fullCode, null, undefined, true)
}
