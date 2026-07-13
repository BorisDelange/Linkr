import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, CheckSquare, Square } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { MappingChange } from '@/lib/concept-mapping/merge'
import type { ConceptMapping } from '@/types'

interface PullMappingsTableProps {
  changes: MappingChange[]
  selected: Set<string>
  conflictChoices: Record<string, 'remote' | 'local'>
  onClose: () => void
  onApply: (selected: Set<string>, conflictChoices: Record<string, 'remote' | 'local'>) => void
}

const CHANGE_CLS: Record<MappingChange['type'], string> = {
  add: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  update: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  delete: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
  conflict: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
}

/** Flattened row: the merge change + the fields we sort/filter/display on. */
interface Row {
  key: string
  type: MappingChange['type']
  sourceName: string
  sourceCode: string
  sourceVocab: string
  targetName: string
  targetCode: string
  status: string
}

function toRow(c: MappingChange): Row {
  const m: ConceptMapping | null = c.remote ?? c.local
  return {
    key: c.key,
    type: c.type,
    sourceName: m?.sourceConceptName ?? '',
    sourceCode: m?.sourceConceptCode ?? '',
    sourceVocab: m?.sourceVocabularyId ?? '',
    targetName: m?.targetConceptName ?? '',
    targetCode: m?.targetConceptCode ?? '',
    status: m?.status ?? '',
  }
}

type SortState = { columnId: string; desc: boolean } | null

/**
 * Full-size datatable to pick which mapping changes to pull. Uses the same table
 * engine + interaction model as the mapping tab (sortable column headers, inline
 * per-column filters, column resizing) so it feels identical — plus a checkbox
 * column, a change-type column and a per-conflict mine/theirs toggle.
 */
export function PullMappingsTable({ changes, selected, conflictChoices, onClose, onApply }: PullMappingsTableProps) {
  const { t } = useTranslation()
  const [sel, setSel] = useState<Set<string>>(new Set(selected))
  const [choices, setChoices] = useState<Record<string, 'remote' | 'local'>>({ ...conflictChoices })
  const [sorting, setSorting] = useState<SortState>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [columnSizing, setColumnSizing] = useState({})

  const allRows = useMemo(() => changes.map(toRow), [changes])

  // Filter (per-column, case-insensitive substring) then sort — outside TanStack,
  // matching the mapping tab's approach (TanStack owns only sizing + rendering).
  const rows = useMemo(() => {
    let out = allRows
    for (const [col, val] of Object.entries(filters)) {
      const q = val.trim().toLowerCase()
      if (!q) continue
      out = out.filter((r) => String((r as unknown as Record<string, unknown>)[col] ?? '').toLowerCase().includes(q))
    }
    if (sorting) {
      const { columnId, desc } = sorting
      out = [...out].sort((a, b) => {
        const av = String((a as unknown as Record<string, unknown>)[columnId] ?? '')
        const bv = String((b as unknown as Record<string, unknown>)[columnId] ?? '')
        return desc ? bv.localeCompare(av) : av.localeCompare(bv)
      })
    }
    return out
  }, [allRows, filters, sorting])

  const toggle = (key: string) => {
    const next = new Set(sel)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSel(next)
  }

  const allVisibleSelected = rows.length > 0 && rows.every((r) => sel.has(r.key))
  const setAllVisible = (on: boolean) => {
    const next = new Set(sel)
    for (const r of rows) {
      if (on) next.add(r.key)
      else next.delete(r.key)
    }
    setSel(next)
  }

  const handleSort = (columnId: string) => {
    setSorting((s) => {
      if (s?.columnId === columnId) return s.desc ? { columnId, desc: false } : null
      return { columnId, desc: true }
    })
  }

  const columns = useMemo<ColumnDef<Row>[]>(() => [
    {
      id: '_select',
      header: () => (
        <button className="flex w-full justify-center" onClick={() => setAllVisible(!allVisibleSelected)}>
          {allVisibleSelected ? <CheckSquare size={14} className="text-primary" /> : <Square size={14} className="text-muted-foreground" />}
        </button>
      ),
      cell: ({ row }) => (
        <button className="flex w-full justify-center" onClick={() => toggle(row.original.key)}>
          {sel.has(row.original.key) ? <CheckSquare size={14} className="text-primary" /> : <Square size={14} className="text-muted-foreground" />}
        </button>
      ),
      size: 36,
      minSize: 36,
      enableResizing: false,
    },
    {
      id: 'type',
      header: () => t('versioning.pull_col_change'),
      cell: ({ row }) => (
        <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold uppercase', CHANGE_CLS[row.original.type])}>
          {t(`versioning.pull_change_${row.original.type}`)}
        </span>
      ),
      size: 90,
      minSize: 60,
    },
    { id: 'sourceVocab', header: () => t('concept_mapping.col_source_vocabulary'), cell: ({ row }) => row.original.sourceVocab, size: 100, minSize: 50 },
    { id: 'sourceCode', header: () => t('concept_mapping.col_source_concept_code'), cell: ({ row }) => row.original.sourceCode, size: 110, minSize: 50 },
    { id: 'sourceName', header: () => t('concept_mapping.col_source_concept_name'), cell: ({ row }) => row.original.sourceName, size: 220, minSize: 80 },
    { id: 'targetCode', header: () => t('concept_mapping.col_target_concept_code'), cell: ({ row }) => row.original.targetCode, size: 110, minSize: 50 },
    { id: 'targetName', header: () => t('concept_mapping.col_target_concept_name'), cell: ({ row }) => row.original.targetName, size: 220, minSize: 80 },
    { id: 'status', header: () => t('concept_mapping.col_status'), cell: ({ row }) => <span className="text-muted-foreground">{row.original.status}</span>, size: 100, minSize: 60 },
    {
      id: '_resolution',
      header: () => t('versioning.pull_col_resolution'),
      cell: ({ row }) => {
        if (row.original.type !== 'conflict') return <span className="text-[10px] text-muted-foreground">—</span>
        const key = row.original.key
        const choice = choices[key] ?? 'remote'
        return (
          <div className="flex gap-1">
            <button onClick={() => setChoices((s) => ({ ...s, [key]: 'local' }))}
              className={cn('rounded border px-1.5 py-0.5 text-[10px]', choice === 'local' ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground')}>
              {t('versioning.pull_keep_mine')}
            </button>
            <button onClick={() => setChoices((s) => ({ ...s, [key]: 'remote' }))}
              className={cn('rounded border px-1.5 py-0.5 text-[10px]', choice === 'remote' ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground')}>
              {t('versioning.pull_take_theirs')}
            </button>
          </div>
        )
      },
      size: 150,
      minSize: 120,
      enableResizing: false,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, sel, choices, allVisibleSelected])

  const table = useReactTable({
    data: rows,
    columns,
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
  })

  const NON_SORTABLE = new Set(['_select', '_resolution'])
  const NON_FILTERABLE = new Set(['_select', '_resolution'])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] w-[97vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="text-sm">{t('versioning.pull_mappings_pick')}</DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <span className="text-[11px] text-muted-foreground">{t('versioning.pull_selected_count', { count: sel.size, total: changes.length })}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <Table className="w-full" style={{ tableLayout: 'fixed' }}>
            <TableHeader>
              <TableRow>
                {table.getHeaderGroups()[0].headers.map((header) => {
                  const colId = header.column.id
                  const sortable = !NON_SORTABLE.has(colId)
                  const icon = !sorting || sorting.columnId !== colId
                    ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                    : sorting.desc ? <ArrowDown size={10} className="shrink-0 text-primary" /> : <ArrowUp size={10} className="shrink-0 text-primary" />
                  return (
                    <TableHead key={header.id} className="relative select-none overflow-hidden text-xs" style={{ width: header.getSize(), maxWidth: header.getSize() }}>
                      {sortable ? (
                        <button type="button" className="flex w-full min-w-0 items-center gap-1 overflow-hidden hover:text-foreground" onClick={() => handleSort(colId)}>
                          <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                          {icon}
                        </button>
                      ) : (
                        <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                      )}
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                          className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                        >
                          <div className={cn('absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors', header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40')} />
                        </div>
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
              {/* Per-column filter inputs */}
              <TableRow>
                {table.getHeaderGroups()[0].headers.map((header) => {
                  const colId = header.column.id
                  return (
                    <TableHead key={header.id} className="overflow-hidden p-1" style={{ width: header.getSize(), maxWidth: header.getSize() }}>
                      {!NON_FILTERABLE.has(colId) && (
                        <input
                          value={filters[colId] ?? ''}
                          onChange={(e) => setFilters((f) => ({ ...f, [colId]: e.target.value }))}
                          placeholder={t('common.filter')}
                          className="h-6 w-full rounded border bg-background px-1 text-[11px]"
                        />
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.original.key} className={cn(sel.has(row.original.key) && 'bg-muted/40')}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="overflow-hidden truncate text-xs" style={{ width: cell.column.getSize(), maxWidth: cell.column.getSize() }} title={String((cell.row.original as unknown as Record<string, unknown>)[cell.column.id] ?? '')}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" onClick={() => onApply(sel, choices)}>{t('common.confirm')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
