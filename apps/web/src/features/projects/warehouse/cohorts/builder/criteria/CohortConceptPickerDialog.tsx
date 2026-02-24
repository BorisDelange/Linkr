import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Settings2,
} from 'lucide-react'
import { useConcepts, type ConceptRow } from '../../../concepts/use-concepts'
import type { ConceptSorting } from '../../../concepts/concept-queries'
import type { SchemaMapping } from '@/types'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CohortConceptPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedConceptIds: number[]
  onConfirm: (conceptIds: number[], conceptNames: Record<number, string>) => void
  dataSourceId: string | undefined
  schemaMapping: SchemaMapping | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function columnLabel(id: string): string {
  return id
    .replace(/^_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function SortIndicator({ columnId, sorting }: { columnId: string; sorting: ConceptSorting | null }) {
  if (!sorting || sorting.columnId !== columnId) {
    return <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
  }
  if (sorting.desc) {
    return <ArrowDown size={10} className="shrink-0 text-primary" />
  }
  return <ArrowUp size={10} className="shrink-0 text-primary" />
}

function ColumnFilterSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string | null
  options: string[]
  placeholder: string
  onChange: (v: string | null) => void
}) {
  const { t } = useTranslation()
  return (
    <Select
      value={value ?? '__all__'}
      onValueChange={(v) => onChange(v === '__all__' ? null : v)}
    >
      <SelectTrigger className="h-6 w-full border-dashed text-[10px] font-normal">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">{t('concepts.filter_all')}</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt} value={opt} className="text-xs">{opt}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CohortConceptPickerDialog({
  open,
  onOpenChange,
  selectedConceptIds,
  onConfirm,
  dataSourceId,
  schemaMapping,
}: CohortConceptPickerDialogProps) {
  const { t } = useTranslation()

  // Local selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [selectedNames, setSelectedNames] = useState<Map<number, string>>(new Map())

  // Reuse the concepts hook
  const hook = useConcepts(open ? dataSourceId : undefined, open ? schemaMapping : undefined)

  // Sync from props when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(selectedConceptIds))
    }
  }, [open, selectedConceptIds])

  // Keep selectedNames updated from concepts data
  useEffect(() => {
    if (!hook.concepts.length) return
    setSelectedNames((prev) => {
      const next = new Map(prev)
      for (const c of hook.concepts) {
        if (!next.has(c.concept_id)) {
          next.set(c.concept_id, c.concept_name)
        }
      }
      return next
    })
  }, [hook.concepts])

  const toggleConcept = useCallback((conceptId: number, conceptName: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(conceptId)) {
        next.delete(conceptId)
      } else {
        next.add(conceptId)
      }
      return next
    })
    setSelectedNames((prev) => {
      const next = new Map(prev)
      next.set(conceptId, conceptName)
      return next
    })
  }, [])

  const removeConcept = useCallback((conceptId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(conceptId)
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const handleConfirm = () => {
    const names: Record<number, string> = {}
    for (const id of selectedIds) {
      names[id] = selectedNames.get(id) ?? `#${id}`
    }
    onConfirm([...selectedIds], names)
  }

  // TanStack table setup
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})

  const columns = useMemo<ColumnDef<ConceptRow>[]>(() => {
    const checkboxCol: ColumnDef<ConceptRow> = {
      id: '_select',
      header: () => null,
      cell: ({ row }) => {
        const isSelected = selectedIds.has(row.original.concept_id)
        return (
          <div
            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
              isSelected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-muted-foreground/30'
            }`}
          >
            {isSelected && <Check size={10} />}
          </div>
        )
      },
      size: 36,
      minSize: 36,
    }

    const dataCols: ColumnDef<ConceptRow>[] = hook.availableColumns.map((col) => {
      const base: Partial<ColumnDef<ConceptRow>> = {
        id: col.id,
        header: () => columnLabel(col.id),
      }

      switch (col.id) {
        case 'concept_id':
          return {
            ...base,
            accessorFn: (row) => row.concept_id,
            cell: ({ row }) => <span className="font-mono">{row.original.concept_id}</span>,
            size: 80,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'concept_name':
          return {
            ...base,
            accessorFn: (row) => row.concept_name,
            cell: ({ row }) => row.original.concept_name,
            size: 250,
            minSize: 120,
          } as ColumnDef<ConceptRow>

        case 'concept_code':
          return {
            ...base,
            accessorFn: (row) => row.concept_code,
            cell: ({ row }) => <span className="font-mono">{String(row.original.concept_code ?? '')}</span>,
            size: 100,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'record_count':
          return {
            ...base,
            header: () => t('concepts.column_records'),
            accessorFn: (row) => row.record_count,
            cell: ({ row }) => (
              <span className="tabular-nums">
                {Number(row.original.record_count ?? 0).toLocaleString()}
              </span>
            ),
            size: 90,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'patient_count':
          return {
            ...base,
            header: () => t('concepts.column_patients'),
            accessorFn: (row) => row.patient_count,
            cell: ({ row }) => (
              <span className="tabular-nums">
                {Number(row.original.patient_count ?? 0).toLocaleString()}
              </span>
            ),
            size: 90,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        default:
          return {
            ...base,
            accessorFn: (row) => row[col.id],
            cell: ({ row }) => String(row.original[col.id] ?? ''),
            size: 120,
            minSize: 60,
          } as ColumnDef<ConceptRow>
      }
    })

    return [checkboxCol, ...dataCols]
  }, [hook.availableColumns, selectedIds, t])

  const table = useReactTable({
    data: hook.concepts,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    pageCount: hook.totalPages,
  })

  const renderColumnFilter = (columnId: string) => {
    if (columnId === '_select') return null

    if (columnId === 'concept_id') {
      return (
        <input
          className="h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] font-mono outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder="ID..."
          value={hook.filters._searchId ?? ''}
          onChange={(e) => hook.updateFilter('_searchId', e.target.value || null)}
        />
      )
    }
    if (columnId === 'concept_name') {
      return (
        <input
          className="h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder={t('concepts.search_placeholder')}
          value={hook.filters._searchText ?? ''}
          onChange={(e) => hook.updateFilter('_searchText', e.target.value || null)}
        />
      )
    }
    if (columnId === 'concept_code') {
      return (
        <input
          className="h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] font-mono outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder="Code..."
          value={hook.filters._searchCode ?? ''}
          onChange={(e) => hook.updateFilter('_searchCode', e.target.value || null)}
        />
      )
    }

    const col = hook.availableColumns.find((c) => c.id === columnId)
    if (col?.filterable && hook.filterOptions[columnId]?.length) {
      return (
        <ColumnFilterSelect
          value={hook.filters[columnId] as string | null}
          options={hook.filterOptions[columnId]}
          placeholder={columnLabel(columnId)}
          onChange={(v) => hook.updateFilter(columnId, v)}
        />
      )
    }

    return null
  }

  const selectedList = useMemo(() => {
    return [...selectedIds].map((id) => ({
      id,
      name: selectedNames.get(id) ?? `#${id}`,
    }))
  }, [selectedIds, selectedNames])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] max-w-[95vw] sm:max-w-[95vw] flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>{t('cohorts.concept_pick')}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Left: concept table */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-r">
            <div className="flex items-center justify-end border-b px-2 py-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                    <Settings2 size={12} />
                    {t('concepts.column_visibility', 'Columns')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[180px]">
                  <DropdownMenuLabel className="text-xs">
                    {t('concepts.column_visibility', 'Columns')}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {table
                    .getAllColumns()
                    .filter((col) => col.getCanHide())
                    .map((col) => (
                      <DropdownMenuCheckboxItem
                        key={col.id}
                        checked={col.getIsVisible()}
                        onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                        onSelect={(e) => e.preventDefault()}
                        className="text-xs"
                      >
                        {columnLabel(col.id)}
                      </DropdownMenuCheckboxItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <Table className="w-full" style={{ tableLayout: 'fixed' }}>
                <TableHeader>
                  <TableRow>
                    {table.getHeaderGroups().map((headerGroup) =>
                      headerGroup.headers.map((header) => (
                        <TableHead
                          key={header.id}
                          className="select-none text-xs"
                          style={{ width: header.getSize() }}
                        >
                          {header.column.id === '_select' ? null : (
                            <button
                              type="button"
                              className="flex min-w-0 items-center gap-1 hover:text-foreground"
                              onClick={() => hook.updateSorting(header.column.id)}
                            >
                              <span className="truncate">
                                {flexRender(header.column.columnDef.header, header.getContext())}
                              </span>
                              <SortIndicator columnId={header.column.id} sorting={hook.sorting} />
                            </button>
                          )}
                        </TableHead>
                      )),
                    )}
                  </TableRow>
                  <TableRow className="hover:bg-transparent">
                    {table.getHeaderGroups().map((headerGroup) =>
                      headerGroup.headers.map((header) => (
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
                  {hook.isLoading ? (
                    Array.from({ length: 10 }).map((_, i) => (
                      <TableRow key={i}>
                        {table.getVisibleLeafColumns().map((col) => (
                          <TableCell key={col.id}>
                            <Skeleton className="h-4 w-full" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : table.getRowModel().rows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={table.getVisibleLeafColumns().length}
                        className="h-24 text-center text-sm text-muted-foreground"
                      >
                        {t('patient_data.no_concepts_found')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    table.getRowModel().rows.map((row) => {
                      const isSelected = selectedIds.has(row.original.concept_id)
                      return (
                        <TableRow
                          key={row.original.concept_id}
                          className="cursor-pointer"
                          data-state={isSelected ? 'selected' : undefined}
                          onClick={() =>
                            toggleConcept(row.original.concept_id, row.original.concept_name)
                          }
                        >
                          {row.getVisibleCells().map((cell) => {
                            const rendered = flexRender(cell.column.columnDef.cell, cell.getContext())
                            const raw = cell.getValue()
                            const title = raw != null ? String(raw) : undefined
                            return (
                              <TableCell
                                key={cell.id}
                                className="overflow-hidden truncate text-xs"
                                style={{ maxWidth: cell.column.getSize() }}
                                title={title}
                              >
                                {rendered}
                              </TableCell>
                            )
                          })}
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="flex shrink-0 items-center justify-between border-t px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {t('concepts.pagination_total', { count: hook.totalCount })}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {t('concepts.pagination_per_page')}
                </span>
                <Select
                  value={String(hook.pageSize)}
                  onValueChange={(v) => hook.setPageSize(Number(v))}
                >
                  <SelectTrigger className="h-7 w-[70px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="25">25</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">
                  {t('concepts.pagination_page', {
                    page: hook.page + 1,
                    total: hook.totalPages,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={hook.page === 0}
                  onClick={() => hook.setPage(hook.page - 1)}
                >
                  <ChevronLeft size={14} />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={hook.page >= hook.totalPages - 1}
                  onClick={() => hook.setPage(hook.page + 1)}
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          </div>

          {/* Right: selected concepts panel */}
          <div className="flex w-64 shrink-0 flex-col">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-xs font-medium">
                {t('cohorts.concept_selected')}
              </span>
              <Badge variant="secondary" className="text-[10px]">
                {selectedIds.size}
              </Badge>
            </div>
            {selectedList.length === 0 ? (
              <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                  {t('patient_data.no_concepts_selected')}
                </p>
              </div>
            ) : (
              <>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="p-1.5">
                    {selectedList.map((item) => (
                      <div
                        key={item.id}
                        className="group flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent/50"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {item.name}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          {item.id}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                          onClick={() => removeConcept(item.id)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
                <div className="border-t px-3 py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full text-xs text-muted-foreground"
                    onClick={clearAll}
                  >
                    {t('patient_data.clear_selection')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t px-6 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleConfirm}>
            {t('common.confirm')} ({selectedIds.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
