import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowUpDown, ArrowUp, ArrowDown, Check, Copy, Trash2, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TruncatedText } from '@/components/ui/truncated-text'
import { TruncatedHeader, headerLabel } from '@/components/ui/truncated-header'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import {
  formatClipboardList,
  CLIPBOARD_COPY_FORMATS,
  CLIPBOARD_COPY_FORMAT_LABELS,
  type ClipboardCopyFormat,
} from '@/lib/concept-mapping/clipboard-list-format'
import type { SourceConceptRow } from '../MappingEditorTab'

interface ClipboardListModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: SourceConceptRow[]
  onRemove: (conceptId: number) => void
  onClear: () => void
  isFileSource?: boolean
}

const FILTER_INPUT_CLASS =
  'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

// Text columns that get the styled truncate+hover tooltip on overflow.
const TOOLTIP_COLUMNS = new Set(['concept_name', 'concept_code', 'terminology_name'])
const MONO_COLUMNS = new Set(['concept_code'])

function SortIndicator({ dir }: { dir: false | 'asc' | 'desc' }) {
  if (!dir) return <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
  if (dir === 'desc') return <ArrowDown size={10} className="shrink-0 text-primary" />
  return <ArrowUp size={10} className="shrink-0 text-primary" />
}

export function ClipboardListModal({ open, onOpenChange, items, onRemove, onClear, isFileSource }: ClipboardListModalProps) {
  const { t } = useTranslation()
  const [format, setFormat] = useState<ClipboardCopyFormat>('sql')
  const [copied, setCopied] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})
  // Per-column text filters + a terminology multi-select filter.
  const [textFilters, setTextFilters] = useState<Record<string, string>>({})
  const [termFilter, setTermFilter] = useState<string[]>([])

  // The list is copied in display order (sorted + filtered), so what the user
  // sees in the table is exactly what lands on the clipboard.
  const handleCopy = async (rowsInOrder: SourceConceptRow[]) => {
    const text = formatClipboardList(rowsInOrder, format)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard write can fail (permissions / non-secure context) — no-op.
    }
  }

  const termOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of items) {
      const v = r.terminology_name || r.vocabulary_id
      if (v) set.add(v)
    }
    return [...set].sort()
  }, [items])

  const columns = useMemo<ColumnDef<SourceConceptRow>[]>(() => {
    const cols: ColumnDef<SourceConceptRow>[] = [
      {
        id: 'terminology_name',
        header: () => t('concept_mapping.col_terminology'),
        accessorFn: (row) => row.terminology_name || row.vocabulary_id || '',
        filterFn: (row, _id, value: string[]) => {
          if (!value?.length) return true
          return value.includes(row.original.terminology_name || row.original.vocabulary_id || '')
        },
        size: 120,
        minSize: 60,
      },
      {
        id: 'concept_id',
        header: () => t('concept_mapping.col_source_concept_id'),
        accessorFn: (row) => row.concept_id,
        cell: ({ row }) => <span className="font-mono">{row.original.concept_id}</span>,
        filterFn: (row, _id, value: string) =>
          !value || String(row.original.concept_id).includes(value),
        size: 90,
        minSize: 50,
      },
      {
        id: 'concept_name',
        header: () => t('concept_mapping.col_name'),
        accessorFn: (row) => row.concept_name,
        filterFn: (row, _id, value: string) =>
          !value || (row.original.concept_name ?? '').toLowerCase().includes(value.toLowerCase()),
        size: 260,
        minSize: 100,
      },
    ]
    if (isFileSource) {
      cols.push({
        id: 'concept_code',
        header: () => t('concept_mapping.col_concept_code'),
        accessorFn: (row) => row.concept_code ?? '',
        cell: ({ row }) => <span className="font-mono">{row.original.concept_code ?? ''}</span>,
        filterFn: (row, _id, value: string) =>
          !value || (row.original.concept_code ?? '').toLowerCase().includes(value.toLowerCase()),
        size: 120,
        minSize: 60,
      })
    }
    cols.push({
      id: '_remove',
      header: '',
      accessorFn: () => null,
      cell: ({ row }) => (
        <button
          type="button"
          onClick={() => onRemove(row.original.concept_id)}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
          aria-label="Remove"
        >
          <X size={12} />
        </button>
      ),
      size: 32,
      minSize: 32,
      enableResizing: false,
      enableSorting: false,
    })
    return cols
  }, [t, isFileSource, onRemove])

  const columnFilters = useMemo(() => {
    const f: { id: string; value: unknown }[] = []
    if (termFilter.length) f.push({ id: 'terminology_name', value: termFilter })
    for (const [id, value] of Object.entries(textFilters)) {
      if (value) f.push({ id, value })
    }
    return f
  }, [termFilter, textFilters])

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting, columnSizing, columnFilters },
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  const visibleRows = table.getRowModel().rows
  const orderedItems = visibleRows.map((r) => r.original)

  const renderColumnFilter = (columnId: string) => {
    if (columnId === 'terminology_name') {
      return (
        <MultiSelectFilter
          value={termFilter}
          options={termOptions}
          placeholder={t('concept_mapping.col_terminology')}
          onChange={setTermFilter}
          popoverWidthClass="w-[300px]"
        />
      )
    }
    if (columnId === 'concept_id') {
      return (
        <input
          className={`${FILTER_INPUT_CLASS} font-mono`}
          placeholder="ID..."
          value={textFilters.concept_id ?? ''}
          onChange={(e) => setTextFilters((p) => ({ ...p, concept_id: e.target.value }))}
        />
      )
    }
    if (columnId === 'concept_name' || columnId === 'concept_code') {
      return (
        <input
          className={columnId === 'concept_code' ? `${FILTER_INPUT_CLASS} font-mono` : FILTER_INPUT_CLASS}
          placeholder="..."
          value={textFilters[columnId] ?? ''}
          onChange={(e) => setTextFilters((p) => ({ ...p, [columnId]: e.target.value }))}
        />
      )
    }
    return null
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('concept_mapping.clipboard_list_title')}</DialogTitle>
          <DialogDescription>
            {t('concept_mapping.clipboard_list_count', { count: items.length })}
          </DialogDescription>
        </DialogHeader>

        {items.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <p>{t('concept_mapping.clipboard_list_empty')}</p>
            <p>{t('concept_mapping.clipboard_list_empty_hint')}</p>
          </div>
        ) : (
          <div className="max-h-[55vh] overflow-auto rounded border">
            <Table className="w-full" style={{ tableLayout: 'fixed' }}>
              <TableHeader>
                <TableRow>
                  {table.getHeaderGroups().map((hg) =>
                    hg.headers.map((header) => {
                      const colId = header.column.id
                      const isUnsortable = colId === '_remove'
                      return (
                        <TableHead
                          key={header.id}
                          className="relative select-none overflow-hidden text-xs"
                          style={{ width: header.getSize(), maxWidth: header.getSize() }}
                        >
                          {isUnsortable ? null : (
                            <button
                              type="button"
                              className="flex w-full min-w-0 items-center gap-1 overflow-hidden pr-2 hover:text-foreground"
                              onClick={header.column.getToggleSortingHandler()}
                            >
                              <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                                {flexRender(header.column.columnDef.header, header.getContext())}
                              </TruncatedHeader>
                              <SortIndicator dir={header.column.getIsSorted()} />
                            </button>
                          )}
                          {header.column.getCanResize() && (
                            <div
                              onMouseDown={header.getResizeHandler()}
                              onTouchStart={header.getResizeHandler()}
                              onDoubleClick={() => header.column.resetSize()}
                              className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                            >
                              <div
                                className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${
                                  header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40'
                                }`}
                              />
                            </div>
                          )}
                        </TableHead>
                      )
                    }),
                  )}
                </TableRow>
                <TableRow className="hover:bg-transparent">
                  {table.getHeaderGroups().map((hg) =>
                    hg.headers.map((header) => (
                      <TableHead
                        key={`filter-${header.id}`}
                        className="px-1 py-1"
                        style={{ width: header.getSize() }}
                      >
                        {renderColumnFilter(header.column.id)}
                      </TableHead>
                    )),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => (
                  <TableRow key={row.original.concept_id}>
                    {row.getVisibleCells().map((cell) => {
                      const raw = cell.getValue()
                      const useTooltip = TOOLTIP_COLUMNS.has(cell.column.id) && raw != null && String(raw) !== ''
                      const rendered = useTooltip
                        ? <TruncatedText text={String(raw)} className={MONO_COLUMNS.has(cell.column.id) ? 'font-mono' : undefined} />
                        : flexRender(cell.column.columnDef.cell, cell.getContext())
                      return (
                        <TableCell
                          key={cell.id}
                          className="overflow-hidden truncate text-xs px-2 py-1"
                          style={{ maxWidth: cell.column.getSize() }}
                        >
                          {rendered}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={items.length === 0}
            onClick={onClear}
          >
            <Trash2 size={14} />
            {t('concept_mapping.clipboard_clear')}
          </Button>
          <div className="flex items-center gap-2">
            <Select value={format} onValueChange={(v) => setFormat(v as ClipboardCopyFormat)}>
              <SelectTrigger size="sm" className="w-[110px] text-xs" aria-label={t('concept_mapping.clipboard_copy_format')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLIPBOARD_COPY_FORMATS.map((f) => (
                  <SelectItem key={f} value={f} className="text-xs">
                    {CLIPBOARD_COPY_FORMAT_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" className="gap-1.5" disabled={items.length === 0} onClick={() => handleCopy(orderedItems)}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? t('concept_mapping.clipboard_copied') : t('concept_mapping.clipboard_copy')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
