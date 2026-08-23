/**
 * Descriptive table — the "Table 1" of a paper, typeset as one.
 *
 * The numbers come from `lib/stats/descriptive-table`, which is pure and
 * shared; this file resolves widget config into that call and renders the
 * result through `PublicationTable`. Design notes and the reasons behind the
 * layout live in docs/planning/descriptive-table-plan.md.
 *
 * Two things this deliberately does NOT do:
 *  - use `ConceptDataTable`: its filters, visibility menu and paging are chrome
 *    that must not appear in a manuscript (plan §3);
 *  - name variables by their column id: a table meant to be read and exported
 *    shows labels (`displayColumnName`).
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Table as TableIcon } from 'lucide-react'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import { displayColumnName } from '@/lib/dataset-utils'
import { defaultAnalysisColumns } from '@/lib/analysis-default-columns'
import {
  buildDescriptiveTable,
  DASH,
  type DescriptiveTable,
  type SummaryStat,
  type VariableSpec,
} from '@/lib/stats/descriptive-table'
import { PublicationTable, type PublicationColumn } from '@/components/ui/publication-table'
import type { ExportTable, ExportTableCell } from '@/lib/table-export'
import { analysisTableRef } from './ComponentAnalysisShell'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import type { DatasetColumn } from '@/types'
import { buildTable1Spec } from './table1-server'

/** A row as the table renders it — `PublicationRow` plus its cells. */
interface Row {
  id: string
  indent: boolean
  label: string
  cells: Record<string, string>
}

function isNumericColumn(col: DatasetColumn): boolean {
  return col.type === 'number'
}

export function Table1Component({ config, columns, rows, datasetFileId, datasetFilters }: ComponentPluginProps) {
  const { t } = useTranslation()
  const server = isServerMode()

  // Identifiers and dates start unticked: an id column has a meaningless mean
  // and one level per patient, and a raw timestamp describes nothing.
  const selectedIds = (config.selectedColumns as string[] | undefined)?.length
    ? (config.selectedColumns as string[])
    : defaultAnalysisColumns(columns).map((c) => c.id)
  const groupByColumn = (config.groupByColumn as string) || null
  const stat = ((config.stat as SummaryStat) ?? 'median_iqr')
  const showMissing = config.showMissing !== false
  const maxLevels = (config.maxLevels as number) ?? 0
  const wrap = config.wrap === true
  const showOverall = config.showOverall === true

  // Variables carry their LABEL: this table is read and exported, so a storage
  // name like `zone_dechocage` makes it unusable as-is.
  const variables = useMemo<VariableSpec[]>(() => {
    const byId = new Map(columns.map((c) => [c.id, c]))
    return selectedIds
      .map((id) => byId.get(id))
      .filter((c): c is DatasetColumn => !!c && c.id !== groupByColumn)
      .map((c) => ({
        id: c.id,
        label: displayColumnName(c),
        kind: isNumericColumn(c) ? ('numeric' as const) : ('categorical' as const),
      }))
  }, [columns, selectedIds, groupByColumn])

  const groupColumn = groupByColumn ? columns.find((c) => c.id === groupByColumn) : undefined

  const localTable = useMemo(
    () =>
      server
        ? null
        : buildDescriptiveTable({
            rows,
            variables,
            groupBy: groupColumn ? { id: groupColumn.id, label: displayColumnName(groupColumn) } : undefined,
            stat,
            showMissing,
            missingLabel: t('datasets.table1_missing'),
            maxLevels,
            othersLabel: t('datasets.table1_others'),
          }),
    [server, rows, variables, groupColumn, stat, showMissing, maxLevels, t],
  )

  const [serverTable, setServerTable] = useState<DescriptiveTable | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const spec = server && datasetFileId && columns.length > 0
    ? buildTable1Spec(columns, selectedIds, groupByColumn, {
        stat,
        showMissing,
        maxLevels,
        missingLabel: t('datasets.table1_missing'),
        othersLabel: t('datasets.table1_others'),
      })
    : null
  // Stable string keys: the spec is rebuilt every render, so comparing the
  // object itself would refetch forever.
  const specKey = spec ? JSON.stringify(spec) : null
  const filtersKey = JSON.stringify(datasetFilters ?? null)
  useEffect(() => {
    if (!server || !datasetFileId || !specKey) return
    let cancelled = false
    renderOnServer('table1', JSON.parse(specKey), { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        if (out.stderr) { setServerError(out.stderr); return }
        try { setServerTable(JSON.parse(out.stdout.trim()) as DescriptiveTable); setServerError(null) }
        catch { setServerError(out.stdout || 'Failed to parse result') }
      })
      .catch((e) => { if (!cancelled) setServerError(String(e)) })
    return () => { cancelled = true }
  }, [server, datasetFileId, specKey, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const table = server ? serverTable : localTable

  // Column keys: the groups, optionally preceded by an Overall column. Without
  // a group-by there is exactly one unnamed key.
  // Memoized: the `??` fallback builds a fresh array each render, which would
  // re-run the column and export hooks below on every render.
  const groupKeys = useMemo(() => table?.groups ?? [''], [table])
  const showOverallColumn = showOverall && !!table?.groups

  const displayRows = useMemo<Row[]>(
    () =>
      (table?.rows ?? []).map((r) => ({
        id: r.id,
        indent: r.indent,
        label: r.label,
        cells: Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, v.text])),
      })),
    [table],
  )

  const tableColumns = useMemo<PublicationColumn<Row>[]>(() => {
    const cols: PublicationColumn<Row>[] = [
      {
        id: '__variable__',
        header: t('datasets.table1_variable'),
        cell: (r) => r.label,
        align: 'left',
        width: 240,
        minWidth: 120,
      },
    ]
    if (showOverallColumn && table) {
      cols.push({
        id: '__overall__',
        header: `${t('datasets.table1_overall')} (n=${table.total})`,
        cell: (r) => overallCell(r, groupKeys),
        align: 'right',
        width: 130,
      })
    }
    for (const g of groupKeys) {
      const size = table?.groupSizes[g] ?? 0
      cols.push({
        id: g || '__all__',
        // The group's own n belongs in its header, as in a paper: every
        // percentage below it is over that number.
        header: table?.groups ? `${g} (n=${size})` : `${t('datasets.table1_overall')} (n=${size})`,
        cell: (r) => r.cells[g] ?? DASH,
        align: 'right',
        width: 130,
      })
    }
    return cols
  }, [t, groupKeys, table, showOverallColumn])

  // Publish the table for the shell's Export menu (copy / LaTeX).
  useEffect(() => {
    if (!table) return
    analysisTableRef.current = () => toExportTable(displayRows, tableColumns, groupKeys)
    return () => { analysisTableRef.current = null }
  }, [table, displayRows, tableColumns, groupKeys])

  if (columns.length === 0) {
    return <Placeholder icon text={t('datasets.table1_no_columns')} />
  }
  if (server && serverError) {
    return <Placeholder text={serverError} />
  }
  if (!table) {
    return <Placeholder text={t('common.loading')} />
  }
  if (variables.length === 0) {
    return <Placeholder icon text={t('datasets.table1_no_columns')} />
  }

  return (
    <PublicationTable
      rows={displayRows}
      columns={tableColumns}
      wrap={wrap}
      className="h-full p-4"
      emptyMessage={t('common.no_results')}
    />
  )
}

/** The Overall cell: the same statistic across every group at once. */
function overallCell(row: Row, groups: string[]): string {
  // Only meaningful for a count row; a median cannot be pooled from group
  // medians, so a numeric row shows a dash rather than a wrong number.
  const counts = groups.map((g) => row.cells[g] ?? '')
  const nums = counts.map((c) => Number(c.split(' ')[0])).filter((n) => Number.isFinite(n))
  if (nums.length !== groups.length) return DASH
  return String(nums.reduce((s, v) => s + v, 0))
}

function toExportTable(
  rows: Row[],
  columns: PublicationColumn<Row>[],
  groupKeys: string[],
): ExportTable {
  const head: ExportTableCell[][] = [
    columns.map((c) => ({ text: c.header, align: c.align })),
  ]
  const body = rows.map((r) => columns.map((c) => {
    const value = c.id === '__variable__'
      ? r.label
      : c.id === '__overall__'
        ? overallCell(r, groupKeys)
        : (r.cells[c.id === '__all__' ? '' : c.id] ?? DASH)
    return { text: value, align: c.align }
  }))
  const indented = new Set<number>()
  rows.forEach((r, i) => { if (r.indent) indented.add(i) })
  return { head, body, indentedRows: indented }
}

function Placeholder({ text, icon }: { text: string; icon?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      {icon && <TableIcon size={24} className="opacity-40" />}
      <p className="whitespace-pre-wrap text-xs">{text}</p>
    </div>
  )
}
