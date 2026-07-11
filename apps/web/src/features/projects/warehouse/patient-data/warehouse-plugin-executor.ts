import type { RuntimeOutput } from '@/lib/runtimes/types'
import { isServerMode } from '@/lib/api-client'

/**
 * Build Python preamble injecting patient context variables.
 */
function buildPythonPreamble(
  personId: string | null,
  visitOccurrenceId: string | null,
  visitDetailId: string | null,
): string {
  const pid = personId != null ? personId : 'None'
  const vid = visitOccurrenceId != null ? visitOccurrenceId : 'None'
  const vdid = visitDetailId != null ? visitDetailId : 'None'

  return [
    'import pandas as pd',
    'import numpy as np',
    '',
    `person_id = ${pid}`,
    `visit_occurrence_id = ${vid}`,
    `visit_detail_id = ${vdid}`,
    '',
  ].join('\n')
}

/**
 * Build R preamble injecting patient context variables.
 */
function buildRPreamble(
  personId: string | null,
  visitOccurrenceId: string | null,
  visitDetailId: string | null,
): string {
  const pid = personId != null ? personId : 'NULL'
  const vid = visitOccurrenceId != null ? visitOccurrenceId : 'NULL'
  const vdid = visitDetailId != null ? visitDetailId : 'NULL'

  return [
    'library(jsonlite)',
    '',
    `person_id <- ${pid}`,
    `visit_occurrence_id <- ${vid}`,
    `visit_detail_id <- ${vdid}`,
    '',
  ].join('\n')
}

/**
 * Execute a warehouse plugin in Python.
 * The dataSourceId is passed as activeConnectionId which enables the sql_query() bridge.
 */
export async function executeWarehousePluginPython(
  code: string,
  dataSourceId: string,
  personId: string | null,
  visitOccurrenceId: string | null,
  visitDetailId: string | null,
  extraPreamble?: string,
): Promise<RuntimeOutput> {
  const preamble = buildPythonPreamble(personId, visitOccurrenceId, visitDetailId)
  const extra = extraPreamble ? extraPreamble + '\n' : ''
  const full = preamble + extra + code
  // Server mode: run on the backend (no Pyodide WASM). The patient context is
  // plain injected variables; the data source drives the sql_query() bridge.
  if (isServerMode()) {
    const { executeOnServer } = await import('@/lib/api/execution')
    return executeOnServer('python', full, { connectionId: dataSourceId })
  }
  const { executePython } = await import('@/lib/runtimes/pyodide-engine')
  return executePython(full, dataSourceId)
}

/**
 * Execute a warehouse plugin in R.
 * The dataSourceId is passed as activeConnectionId which enables the sql_query() bridge.
 */
export async function executeWarehousePluginR(
  code: string,
  dataSourceId: string,
  personId: string | null,
  visitOccurrenceId: string | null,
  visitDetailId: string | null,
  extraPreamble?: string,
): Promise<RuntimeOutput> {
  const preamble = buildRPreamble(personId, visitOccurrenceId, visitDetailId)
  const extra = extraPreamble ? extraPreamble + '\n' : ''
  const full = preamble + extra + code
  if (isServerMode()) {
    const { executeOnServer } = await import('@/lib/api/execution')
    return executeOnServer('r', full, { connectionId: dataSourceId })
  }
  const { executeR } = await import('@/lib/runtimes/webr-engine')
  return executeR(full, dataSourceId)
}
