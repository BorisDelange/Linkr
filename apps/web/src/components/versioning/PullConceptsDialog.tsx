import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckSquare, Square } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { SourceConceptChange, SourceConceptsDiff } from '@/lib/api/git'

interface PullConceptsDialogProps {
  diff: SourceConceptsDiff | undefined
  /** The rows that moved, when the server could key both sides. */
  changes: SourceConceptChange[]
  /** Keys previously refused, so reopening restores the choice. */
  declined: ReadonlySet<string>
  onClose: () => void
  /** Confirm: `declined` is every row left unticked. */
  onApply: (declined: Set<string>) => void
}

const STATE_CLS: Record<SourceConceptChange['state'], string> = {
  add: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  delete: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
  modify: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
}

type SortState = { columnId: string; desc: boolean } | null

/**
 * Pick which source-concept changes to take — the twin of `PullMappingsTable`.
 *
 * Same interaction model on purpose (checkbox column, sortable headers, per-column
 * filters): two tables doing the same job should not be driven differently. The
 * source list is still written as one CSV, but the applier rebuilds that file
 * around the refusals (`mergeSourceConceptsCsv`), so ticking rows here is a real
 * choice and not a decoration.
 */
export function PullConceptsDialog({ diff, changes, declined, onClose, onApply }: PullConceptsDialogProps) {
  const { t } = useTranslation()
  // Everything taken until the user says otherwise — pulling is why they are here.
  const [sel, setSel] = useState<Set<string>>(
    () => new Set(changes.filter((c) => !declined.has(c.key)).map((c) => c.key)),
  )
  const [sorting, setSorting] = useState<SortState>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [columnSizing, setColumnSizing] = useState({})

  const rows = useMemo(() => {
    let out = changes
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
  }, [changes, filters, sorting])

  const toggle = (key: string) => {
    setSel((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allVisibleSelected = rows.length > 0 && rows.every((r) => sel.has(r.key))
  const setAllVisible = (on: boolean) => {
    setSel((s) => {
      const next = new Set(s)
      for (const r of rows) {
        if (on) next.add(r.key)
        else next.delete(r.key)
      }
      return next
    })
  }

  const handleSort = (columnId: string) => {
    setSorting((s) => {
      if (s?.columnId === columnId) return s.desc ? { columnId, desc: false } : null
      return { columnId, desc: true }
    })
  }

  const columns = useMemo<ColumnDef<SourceConceptChange>[]>(() => [
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
      id: 'state',
      header: () => t('versioning.pull_col_change'),
      cell: ({ row }) => (
        <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold uppercase', STATE_CLS[row.original.state])}>
          {t(`versioning.pull_change_${row.original.state === 'modify' ? 'update' : row.original.state}`)}
        </span>
      ),
      size: 90,
      minSize: 60,
    },
    { id: 'vocabulary', header: () => t('concept_mapping.col_source_vocabulary'), cell: ({ row }) => row.original.vocabulary, size: 160, minSize: 60 },
    { id: 'code', header: () => t('concept_mapping.col_source_concept_code'), cell: ({ row }) => row.original.code, size: 140, minSize: 60 },
    { id: 'name', header: () => t('concept_mapping.col_source_concept_name'), cell: ({ row }) => row.original.name, size: 320, minSize: 100 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, sel, allVisibleSelected])

  const table = useReactTable({
    data: rows,
    columns,
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
  })

  const NON_SORTABLE = new Set(['_select'])
  const NON_FILTERABLE = new Set(['_select'])

  // Nothing to list: the server couldn't key a side, so the file is all-or-nothing.
  if (changes.length === 0) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('versioning.pull_concepts_title')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-2 py-6 text-center text-muted-foreground">
            <AlertTriangle size={26} />
            <p className="text-sm">{t('versioning.pull_diff_whole_file')}</p>
            {diff && (
              <p className="text-xs">
                {t('versioning.pull_concepts_totals', { local: diff.localTotal, remote: diff.remoteTotal })}
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="outline" size="sm" onClick={() => onApply(new Set(['*']))}>{t('versioning.pull_keep_mine')}</Button>
            <Button size="sm" onClick={() => onApply(new Set())}>{t('versioning.pull_take')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] w-[97vw] max-w-[1500px] grid-cols-[minmax(0,1fr)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle>{t('versioning.pull_concepts_title')}</DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <span className="text-[11px] text-muted-foreground">
            {t('versioning.pull_selected_count', { count: sel.size, total: changes.length })}
          </span>
          {diff?.changesTruncated && (
            <span className="text-[11px] text-amber-700 dark:text-amber-400">
              {t('versioning.pull_concepts_truncated')}
            </span>
          )}
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
          <Button size="sm" onClick={() => onApply(new Set(changes.filter((c) => !sel.has(c.key)).map((c) => c.key)))}>
            {t('common.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
