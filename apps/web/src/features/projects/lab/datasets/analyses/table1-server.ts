import type { DatasetColumn } from '@/types'

export interface Table1Spec {
  selected: { name: string; numeric: boolean }[]
  group: string | null
  metrics: string[]
}

/**
 * Build the Table 1 render SPEC (selected columns → name+numeric, group, metrics)
 * sent to POST /execute/render. The server owns the pandas program that turns this
 * into the same Table1Data JSON the client computes from rows — so a viewer can
 * render it without the server running any client-supplied code. Server parity:
 * apps/api/app/services/execution/render/table1.py (_TABLE1_PY).
 */
export function buildTable1Spec(
  columns: DatasetColumn[],
  selectedColumnIds: string[],
  groupByColumnId: string | null,
  metrics: string[],
): Table1Spec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const selected = selectedColumnIds
    .map((id) => byId.get(id))
    .filter((c): c is DatasetColumn => !!c)
    .map((c) => ({ name: c.name, numeric: c.type === 'number' }))
  const group = groupByColumnId ? byId.get(groupByColumnId)?.name ?? null : null
  return { selected, group, metrics }
}
