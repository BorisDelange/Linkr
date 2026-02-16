/**
 * Analysis executor — runs analysis scripts with dataset injection.
 *
 * Supports Python (Pyodide) and R (webR) runtimes.
 * Injects dataset rows as a DataFrame / data.frame named `dataset`,
 * then executes the user's analysis code.
 */

import type { RuntimeOutput } from '@/lib/runtimes/types'
import type { DatasetColumn } from '@/types'
import { getPyodide, executePython } from '@/lib/runtimes/pyodide-engine'
import { getWebR, executeR } from '@/lib/runtimes/webr-engine'

/**
 * Build the Python preamble that creates the `dataset` DataFrame.
 *
 * Rows in the store are keyed by column.id (e.g. 'col-1728394').
 * We remap to column.name (e.g. 'age') for the user-facing DataFrame.
 */
function buildInjectionCode(columns: DatasetColumn[]): string {
  // Build rename mapping: { col_id: col_name }
  const renameEntries = columns
    .map((c) => `    ${JSON.stringify(c.id)}: ${JSON.stringify(c.name)}`)
    .join(',\n')

  // Build type coercion
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

_raw = _json.loads(_linkr_dataset_json)
dataset = pd.DataFrame(_raw)
dataset = dataset.rename(columns={
${renameEntries}
})
${coercions}
del _raw, _linkr_dataset_json, _json
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
  const pyodide = await getPyodide()

  // Pass the dataset JSON via Pyodide globals (safe, no string interpolation issues)
  const jsonData = JSON.stringify(rows)
  pyodide.globals.set('_linkr_dataset_json', jsonData)

  // Build full code: injection preamble + user script
  const preamble = buildInjectionCode(columns)
  const fullCode = preamble + '\n' + code

  // Execute through the existing Pyodide engine (captures table, figures, stdout, stderr)
  return executePython(fullCode, null)
}

// ---------------------------------------------------------------------------
// R execution
// ---------------------------------------------------------------------------

/**
 * Build the R preamble that creates the `dataset` data.frame.
 *
 * Writes the JSON to a temporary file in webR's virtual FS, then reads it with
 * jsonlite::fromJSON. Column IDs are renamed to human-readable column names and
 * types are coerced to match the column metadata.
 */
function buildRInjectionCode(columns: DatasetColumn[]): string {
  const renameEntries = columns
    .map((c) => `  ${JSON.stringify(c.id)} = ${JSON.stringify(c.name)}`)
    .join(',\n')

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

  return `library(jsonlite)
dataset <- fromJSON("/tmp/_linkr_dataset.json")
.rename_map <- c(
${renameEntries}
)
.existing <- intersect(names(.rename_map), colnames(dataset))
if (length(.existing) > 0) names(dataset)[match(.existing, colnames(dataset))] <- .rename_map[.existing]
rm(.rename_map, .existing)
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

  // Write dataset JSON to webR virtual filesystem
  const jsonData = JSON.stringify(rows)
  const encoder = new TextEncoder()
  const bytes = encoder.encode(jsonData)
  await webR.FS.writeFile('/tmp/_linkr_dataset.json', bytes)

  // Build full code: injection preamble + user script
  const preamble = buildRInjectionCode(columns)
  const fullCode = preamble + '\n' + code

  return executeR(fullCode, null)
}
