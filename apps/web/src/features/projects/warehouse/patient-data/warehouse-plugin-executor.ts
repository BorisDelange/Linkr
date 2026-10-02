import type { RuntimeOutput } from '@/lib/runtimes/types'
import { isServerMode } from '@/lib/api-client'

/**
 * An id as a Python / R literal: a number stays a number (plugins compare it as
 * one), anything else becomes a quoted string — spliced bare, an id like
 * `abc` was a name error, and one carrying code would have run it. A JSON
 * string literal is a valid string literal in both languages.
 */
export function idLiteral(id: string | null, nullLiteral: 'None' | 'NULL'): string {
  if (id == null) return nullLiteral
  return /^-?\d{1,15}$/.test(id) ? id : JSON.stringify(id)
}

/**
 * Build Python preamble injecting patient context variables.
 */
function buildPythonPreamble(
  personId: string | null,
  visitOccurrenceId: string | null,
  visitDetailId: string | null,
): string {
  const pid = idLiteral(personId, 'None')
  const vid = idLiteral(visitOccurrenceId, 'None')
  const vdid = idLiteral(visitDetailId, 'None')

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
  const pid = idLiteral(personId, 'NULL')
  const vid = idLiteral(visitOccurrenceId, 'NULL')
  const vdid = idLiteral(visitDetailId, 'NULL')

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
    return executeOnServer('python', full, { connectionId: dataSourceId, purpose: 'patient-data' })
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
    return executeOnServer('r', full, { connectionId: dataSourceId, purpose: 'patient-data' })
  }
  const { executeR } = await import('@/lib/runtimes/webr-engine')
  return executeR(full, dataSourceId)
}
