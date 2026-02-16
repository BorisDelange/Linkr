/**
 * Analysis executor — runs Python analysis scripts with dataset injection.
 *
 * Injects the dataset rows into Pyodide as a pandas DataFrame named `dataset`,
 * then executes the user's analysis code. The result is captured as a RuntimeOutput
 * (table, figures, stdout, stderr).
 */

import type { RuntimeOutput } from '@/lib/runtimes/types'
import type { DatasetColumn } from '@/types'
import { getPyodide, executePython } from '@/lib/runtimes/pyodide-engine'

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
