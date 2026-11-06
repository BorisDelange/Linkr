import type { RuntimeOutput } from '@/lib/runtimes/types'
import { isServerMode } from '@/lib/api-client'
import type { CodeReview } from '@/lib/api/code-acceptance'

/** SQL a concept-picker plugin receives ready-built, by variable name. */
export type PluginExtraVars = Record<string, string | null>

/**
 * An id as a Python / R literal: a number stays a number (plugins compare it as
 * one), anything else becomes a quoted string — spliced bare, an id like
 * `abc` was a name error, and one carrying code would have run it. A JSON
 * string literal is a valid string literal in both languages. A leading zero
 * keeps it a string: `007` is a syntax error in Python and loses its zeros in R.
 */
export function idLiteral(id: string | null, nullLiteral: 'None' | 'NULL'): string {
  if (id == null) return nullLiteral
  return /^-?(0|[1-9]\d{0,14})$/.test(id) ? id : JSON.stringify(id)
}

/** The same id as a value for the server, which writes the literal itself. */
export function idValue(id: string | null): string | number | null {
  const literal = idLiteral(id, 'None')
  return id != null && literal === id ? Number(id) : id
}

function serverContext(
  personId: string | null,
  visitOccurrenceId: string | null,
  visitDetailId: string | null,
  extraVars?: PluginExtraVars,
): Record<string, string | number | null> {
  return {
    person_id: idValue(personId),
    visit_occurrence_id: idValue(visitOccurrenceId),
    visit_detail_id: idValue(visitDetailId),
    ...extraVars,
  }
}

function extraLines(extraVars: PluginExtraVars | undefined, assign: string, nullLiteral: string): string {
  return Object.entries(extraVars ?? {})
    .map(([name, value]) => `${name} ${assign} ${value ? JSON.stringify(value) : nullLiteral}\n`)
    .join('') + (extraVars ? '\n' : '')
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
  extraVars?: PluginExtraVars,
  review?: CodeReview,
): Promise<RuntimeOutput> {
  // Server mode: run on the backend (no Pyodide WASM). The patient context is
  // plain injected variables; the data source drives the sql_query() bridge.
  if (isServerMode()) {
    const { executeOnServer } = await import('@/lib/api/execution')
    return executeOnServer('python', code, {
      connectionId: dataSourceId,
      purpose: 'patient-data',
      contextVars: serverContext(personId, visitOccurrenceId, visitDetailId, extraVars),
      review,
    })
  }
  const full = buildPythonPreamble(personId, visitOccurrenceId, visitDetailId) + extraLines(extraVars, '=', 'None') + code
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
  extraVars?: PluginExtraVars,
  review?: CodeReview,
): Promise<RuntimeOutput> {
  if (isServerMode()) {
    const { executeOnServer } = await import('@/lib/api/execution')
    return executeOnServer('r', code, {
      connectionId: dataSourceId,
      purpose: 'patient-data',
      contextVars: serverContext(personId, visitOccurrenceId, visitDetailId, extraVars),
      review,
    })
  }
  const full = buildRPreamble(personId, visitOccurrenceId, visitDetailId) + extraLines(extraVars, '<-', 'NULL') + code
  const { executeR } = await import('@/lib/runtimes/webr-engine')
  return executeR(full, dataSourceId)
}
