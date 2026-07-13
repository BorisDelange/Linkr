import type { DatasetColumn } from '@/types'

export interface CorrelationMatrixSpec {
  names: string[]
  method: 'pearson' | 'spearman'
}

/**
 * Build the correlation matrix render SPEC (selected numeric column names + method)
 * sent to POST /execute/render. The server owns the pandas/scipy program that turns
 * this into the same {names, matrix, totalN} the client computes from rows — so a
 * viewer can render it without the server running any client-supplied code. Server
 * parity: apps/api/app/services/execution/render/correlation_matrix.py (_CORR_PY).
 */
export function buildCorrelationMatrixSpec(
  columns: DatasetColumn[],
  selectedIds: string[],
  method: 'pearson' | 'spearman',
): CorrelationMatrixSpec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const names = selectedIds
    .map((id) => byId.get(id))
    .filter((c): c is DatasetColumn => !!c && c.type === 'number')
    .map((c) => c.name)

  return { names, method }
}
