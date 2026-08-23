import { displayColumnName } from '@/lib/dataset-utils'
import type { SummaryStat } from '@/lib/stats/descriptive-table'
import type { DatasetColumn } from '@/types'

export interface Table1Spec {
  /** The variables to describe. `label` is what the table prints. */
  selected: { name: string; label: string; numeric: boolean }[]
  group: { name: string; label: string } | null
  stat: SummaryStat
  showMissing: boolean
  missingLabel: string
  maxLevels: number
  othersLabel: string
}

/**
 * Build the descriptive-table render SPEC sent to POST /execute/render.
 *
 * The server owns the pandas program that turns this into the same
 * `DescriptiveTable` JSON the client computes from rows, so a viewer can render
 * it without the server running any client-supplied code. Server parity:
 * apps/api/app/services/execution/render/table1.py.
 *
 * Labels travel in the spec rather than being re-derived server-side: they can
 * come from a locale the server does not know about, and the two ends must
 * print the same words.
 */
export function buildTable1Spec(
  columns: DatasetColumn[],
  selectedColumnIds: string[],
  groupByColumnId: string | null,
  options: {
    stat: SummaryStat
    showMissing: boolean
    maxLevels: number
    missingLabel: string
    othersLabel: string
  },
): Table1Spec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const selected = selectedColumnIds
    .map((id) => byId.get(id))
    .filter((c): c is DatasetColumn => !!c && c.id !== groupByColumnId)
    .map((c) => ({ name: c.name, label: displayColumnName(c), numeric: c.type === 'number' }))
  const groupCol = groupByColumnId ? byId.get(groupByColumnId) : undefined
  return {
    selected,
    group: groupCol ? { name: groupCol.name, label: displayColumnName(groupCol) } : null,
    stat: options.stat,
    showMissing: options.showMissing,
    missingLabel: options.missingLabel,
    maxLevels: options.maxLevels,
    othersLabel: options.othersLabel,
  }
}
