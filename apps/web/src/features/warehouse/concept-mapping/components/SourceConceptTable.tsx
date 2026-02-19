import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  SlidersHorizontal,
  Settings2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { SourceConceptFilters, SourceConceptSorting } from '@/lib/concept-mapping/mapping-queries'
import type { SourceConceptRow } from '../MappingEditorTab'

export type MappingStatusFilter = 'all' | 'unmapped' | 'mapped' | 'approved' | 'rejected' | 'flagged'

interface SourceConceptTableProps {
  rows: SourceConceptRow[]
  totalCount: number
  page: number
  pageSize: number
  loading: boolean
  queryError?: string | null
  filters: SourceConceptFilters
  sorting: SourceConceptSorting | null
  filterOptions: Record<string, string[]>
  mappingStatusMap: Map<number, string>
  mappingStatusFilter: MappingStatusFilter
  selectedConceptId: number | null
  onPageChange: (page: number) => void
  onFiltersChange: (filters: SourceConceptFilters) => void
  onSortingChange: (sorting: SourceConceptSorting | null) => void
  onMappingStatusFilterChange: (filter: MappingStatusFilter) => void
  onSelectConcept: (id: number | null) => void
}

const FILTER_INPUT_CLASS = 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

/** Small dropdown for categorical column filters. */
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

const STATUS_COLORS: Record<string, string> = {
  unmapped: 'bg-gray-300',
  mapped: 'bg-blue-500',
  approved: 'bg-green-500',
  flagged: 'bg-orange-500',
  invalid: 'bg-red-500',
}

/** Get human-readable label for a TanStack column def. */
function getColLabel(colDefs: ColumnDef<SourceConceptRow>[], id: string): string {
  const def = colDefs.find((c) => 'id' in c && c.id === id)
  if (def) {
    if (typeof def.header === 'function') {
      const result = (def.header as () => unknown)()
      if (typeof result === 'string') return result
    }
    if (typeof def.header === 'string') return def.header
  }
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function SortIndicator({ columnId, sorting }: { columnId: string; sorting: SourceConceptSorting | null }) {
  if (!sorting || sorting.columnId !== columnId) {
    return <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
  }
  if (sorting.desc) {
    return <ArrowDown size={10} className="shrink-0 text-primary" />
  }
  return <ArrowUp size={10} className="shrink-0 text-primary" />
}

export function SourceConceptTable({
  rows,
  totalCount,
  page,
  pageSize,
  loading,
  queryError,
  filters,
  sorting,
  filterOptions,
  mappingStatusMap,
  mappingStatusFilter,
  selectedConceptId,
  onPageChange,
  onFiltersChange,
  onSortingChange,
  onMappingStatusFilterChange,
  onSelectConcept,
}: SourceConceptTableProps) {
  const { t } = useTranslation()
  const [filterOpen, setFilterOpen] = useState(false)
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const activePopoverFilterCount = [mappingStatusFilter !== 'all'].filter(Boolean).length

  const handleSort = (columnId: string) => {
    if (sorting?.columnId === columnId) {
      if (sorting.desc) onSortingChange({ columnId, desc: false })
      else onSortingChange(null)
    } else {
      onSortingChange({ columnId, desc: true })
    }
  }

  const MAPPING_STATUS_OPTIONS: MappingStatusFilter[] = ['all', 'unmapped', 'mapped', 'approved', 'rejected', 'flagged']

  /** Render inline column filter for a given column. */
  const renderColumnFilter = (columnId: string) => {
    // Text inputs
    if (columnId === 'concept_id') {
      return <input className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="ID..." value={filters.searchId ?? ''} onChange={(e) => onFiltersChange({ ...filters, searchId: e.target.value || undefined })} />
    }
    if (columnId === 'concept_name') {
      return <input className={FILTER_INPUT_CLASS} placeholder="..." value={filters.searchText ?? ''} onChange={(e) => onFiltersChange({ ...filters, searchText: e.target.value || undefined })} />
    }
    if (columnId === 'concept_code') {
      return <input className={FILTER_INPUT_CLASS} placeholder="Code..." value={filters.searchCode ?? ''} onChange={(e) => onFiltersChange({ ...filters, searchCode: e.target.value || undefined })} />
    }
    // Dropdowns
    if (columnId === 'vocabulary_id' && filterOptions.vocabulary_id?.length > 0) {
      return <ColumnFilterSelect value={filters.vocabularyId ?? null} options={filterOptions.vocabulary_id} placeholder="Vocab" onChange={(v) => onFiltersChange({ ...filters, vocabularyId: v ?? undefined })} />
    }
    if (columnId === 'domain_id' && filterOptions.domain_id?.length > 0) {
      return <ColumnFilterSelect value={filters.domainId ?? null} options={filterOptions.domain_id} placeholder="Domain" onChange={(v) => onFiltersChange({ ...filters, domainId: v ?? undefined })} />
    }
    if (columnId === 'concept_class_id' && filterOptions.concept_class_id?.length > 0) {
      return <ColumnFilterSelect value={filters.conceptClassId ?? null} options={filterOptions.concept_class_id} placeholder="Class" onChange={(v) => onFiltersChange({ ...filters, conceptClassId: v ?? undefined })} />
    }
    return null
  }

  // Build columns dynamically
  const columns = useMemo<ColumnDef<SourceConceptRow>[]>(() => {
    return [
      {
        id: '_status',
        header: '',
        accessorFn: () => null,
        cell: ({ row }) => {
          const status = mappingStatusMap.get(row.original.concept_id) ?? 'unmapped'
          return (
            <span className="flex justify-center">
              <span className={`inline-block size-2 rounded-full ${STATUS_COLORS[status] ?? STATUS_COLORS.unmapped}`} />
            </span>
          )
        },
        size: 28,
        minSize: 28,
        enableHiding: false,
        enableResizing: false,
      },
      {
        id: 'concept_id',
        header: 'ID',
        accessorFn: (row) => row.concept_id,
        cell: ({ row }) => <span className="font-mono">{row.original.concept_id}</span>,
        size: 70,
        minSize: 50,
        enableHiding: false,
      },
      {
        id: 'concept_name',
        header: () => t('concept_mapping.col_name'),
        accessorFn: (row) => row.concept_name,
        cell: ({ row }) => row.original.concept_name,
        size: 220,
        minSize: 100,
        enableHiding: false,
      },
      {
        id: 'concept_code',
        header: 'Code',
        accessorFn: (row) => row.concept_code,
        cell: ({ row }) => <span className="font-mono">{row.original.concept_code}</span>,
        size: 90,
        minSize: 50,
      },
      {
        id: 'vocabulary_id',
        header: () => t('concept_mapping.col_vocab'),
        accessorFn: (row) => row.vocabulary_id,
        cell: ({ row }) => row.original.vocabulary_id,
        size: 90,
        minSize: 60,
      },
      {
        id: 'domain_id',
        header: () => t('concept_mapping.col_domain'),
        accessorFn: (row) => row.domain_id,
        cell: ({ row }) => row.original.domain_id ?? '',
        size: 90,
        minSize: 60,
      },
      {
        id: 'concept_class_id',
        header: () => t('concept_mapping.col_concept_class'),
        accessorFn: (row) => row.concept_class_id,
        cell: ({ row }) => row.original.concept_class_id ?? '',
        size: 100,
        minSize: 60,
      },
      {
        id: 'record_count',
        header: () => t('concept_mapping.col_records'),
        accessorFn: (row) => row.record_count,
        cell: ({ row }) => (
          <span className="tabular-nums">{Number(row.original.record_count ?? 0).toLocaleString()}</span>
        ),
        size: 80,
        minSize: 50,
      },
      {
        id: 'patient_count',
        header: () => t('concept_mapping.col_patients'),
        accessorFn: (row) => row.patient_count,
        cell: ({ row }) => (
          <span className="tabular-nums">{Number(row.original.patient_count ?? 0).toLocaleString()}</span>
        ),
        size: 80,
        minSize: 50,
      },
    ]
  }, [t, mappingStatusMap])

  const table = useReactTable({
    data: rows,
    columns,
    state: { columnVisibility, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    pageCount: totalPages,
  })

  return (
    <div className="flex h-full flex-col border-r overflow-hidden">
      {/* Top bar: count + filter popover + columns toggle */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {totalCount.toLocaleString()} {t('concept_mapping.total_concepts')}
        </span>
        <div className="flex items-center gap-1">
          {/* Mapping status filter popover */}
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="relative h-7 gap-1 px-2 text-xs shrink-0">
                <SlidersHorizontal size={14} />
                {activePopoverFilterCount > 0 && (
                  <Badge variant="default" className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full p-0 text-[8px]">
                    {activePopoverFilterCount}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-3">
              <p className="mb-2 text-xs font-medium">{t('concept_mapping.col_status')}</p>
              <Select
                value={mappingStatusFilter}
                onValueChange={(v) => onMappingStatusFilterChange(v as MappingStatusFilter)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MAPPING_STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt} className="text-xs">
                      {t(`concept_mapping.filter_${opt}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PopoverContent>
          </Popover>
          {/* Column visibility toggle */}
          <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs shrink-0">
              <Settings2 size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[180px]">
            <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table.getAllColumns()
              .filter((col) => col.getCanHide())
              .map((col) => (
                <DropdownMenuCheckboxItem
                  key={col.id}
                  checked={col.getIsVisible()}
                  onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                  onSelect={(e) => e.preventDefault()}
                  className="text-xs"
                >
                  {getColLabel(columns, col.id)}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="w-full" style={{ tableLayout: 'fixed' }}>
          <TableHeader>
            {/* Column titles */}
            <TableRow>
              {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => {
                  const colId = header.column.id
                  const isStatusCol = colId === '_status'
                  return (
                    <TableHead
                      key={header.id}
                      className="relative select-none text-xs"
                      style={{ width: header.getSize() }}
                    >
                      {isStatusCol ? null : (
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-1 hover:text-foreground"
                          onClick={() => handleSort(colId)}
                        >
                          <span className="truncate">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                          <SortIndicator columnId={colId} sorting={sorting} />
                        </button>
                      )}
                      {/* Resize handle */}
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
                })
              )}
            </TableRow>
            {/* Inline column filters */}
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
                ))
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  {table.getVisibleLeafColumns().map((col) => (
                    <TableCell key={col.id}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : queryError ? (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center">
                  <p className="text-xs text-destructive">{t('concept_mapping.query_error')}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">{queryError}</p>
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center text-sm text-muted-foreground">
                  {t('concept_mapping.no_concepts')}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => {
                const isSelected = row.original.concept_id === selectedConceptId
                return (
                  <TableRow
                    key={row.original.concept_id}
                    className="cursor-pointer"
                    data-state={isSelected ? 'selected' : undefined}
                    onClick={() => onSelectConcept(row.original.concept_id)}
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

      {/* Pagination */}
      <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5">
        <span className="text-[10px] text-muted-foreground">
          {totalCount.toLocaleString()} {t('concept_mapping.total_concepts')}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={page === 0} onClick={() => onPageChange(page - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )
}
