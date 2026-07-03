import { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import { ArrowUpDown, ArrowUp, ArrowDown, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'

export interface RelationRow {
  relationship_id: string
  concept_id: number
  concept_name: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  concept_code?: string
  standard_concept?: string
}

const FILTER_INPUT_CLASS = 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

function DebouncedInput({ value: ext, onChange, className, placeholder }: {
  value: string; onChange: (v: string) => void; className?: string; placeholder?: string
}) {
  const [local, setLocal] = useState(ext)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => { setLocal(ext) }, [ext])
  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocal(e.target.value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onChange(e.target.value), 300)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return <input className={className} placeholder={placeholder} value={local} onChange={handle} />
}

/** Cell text with an instant black tooltip shown only when the content is truncated. */
function TruncatedText({ children, className }: { children: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)
  const check = () => {
    const el = ref.current
    setTruncated(!!el && el.scrollWidth > el.clientWidth)
  }
  const span = (
    <span ref={ref} className={`block truncate ${className ?? ''}`} onPointerEnter={check}>
      {children}
    </span>
  )
  if (!truncated) return span
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>{span}</TooltipTrigger>
      <TooltipContent side="top" className="pointer-events-none max-w-xs">{children}</TooltipContent>
    </Tooltip>
  )
}

type Sorting = { columnId: string; desc: boolean } | null

interface Filters {
  relationship_id?: Set<string>
  concept_name?: string
  concept_id?: string
  concept_code?: string
  vocabulary_id?: Set<string>
  domain_id?: Set<string>
  concept_class_id?: Set<string>
  standard_concept?: Set<string>
}

interface RelationsTableProps {
  relations: RelationRow[]
}

function getColLabel(cols: ColumnDef<RelationRow>[], id: string): string {
  const def = cols.find((c) => 'id' in c && c.id === id)
  if (def) {
    if (typeof def.header === 'function') {
      const r = (def.header as () => unknown)()
      if (typeof r === 'string') return r
    }
    if (typeof def.header === 'string') return def.header
  }
  return id.replace(/_/g, ' ')
}

export function RelationsTable({ relations }: RelationsTableProps) {
  const { t } = useTranslation()
  const [sorting, setSorting] = useState<Sorting>(null)
  const [filters, setFilters] = useState<Filters>({})
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    concept_id: false,
    concept_code: false,
    domain_id: false,
    concept_class_id: false,
  })

  const handleSort = (columnId: string) => {
    setSorting((s) =>
      s?.columnId === columnId
        ? s.desc ? { columnId, desc: false } : null
        : { columnId, desc: true }
    )
  }

  const filterOptions = useMemo(() => ({
    relationship_id: [...new Set(relations.map((r) => r.relationship_id).filter(Boolean))].sort(),
    vocabulary_id: [...new Set(relations.map((r) => r.vocabulary_id).filter(Boolean))].sort(),
    domain_id: [...new Set(relations.map((r) => r.domain_id ?? '').filter(Boolean))].sort(),
    concept_class_id: [...new Set(relations.map((r) => r.concept_class_id ?? '').filter(Boolean))].sort(),
    standard_concept: [...new Set(relations.map((r) => r.standard_concept ?? '').filter(Boolean))].sort(),
  }), [relations])

  const filtered = useMemo(() => {
    let rows = relations
    if (filters.relationship_id?.size) rows = rows.filter((r) => filters.relationship_id!.has(r.relationship_id))
    if (filters.concept_name) {
      const q = filters.concept_name.toLowerCase()
      rows = rows.filter((r) => r.concept_name.toLowerCase().includes(q))
    }
    if (filters.concept_id) rows = rows.filter((r) => String(r.concept_id).includes(filters.concept_id!))
    if (filters.concept_code) {
      const q = filters.concept_code.toLowerCase()
      rows = rows.filter((r) => (r.concept_code ?? '').toLowerCase().includes(q))
    }
    if (filters.vocabulary_id?.size) rows = rows.filter((r) => filters.vocabulary_id!.has(r.vocabulary_id))
    if (filters.domain_id?.size) rows = rows.filter((r) => filters.domain_id!.has(r.domain_id ?? ''))
    if (filters.concept_class_id?.size) rows = rows.filter((r) => filters.concept_class_id!.has(r.concept_class_id ?? ''))
    if (filters.standard_concept?.size) rows = rows.filter((r) => filters.standard_concept!.has(r.standard_concept ?? ''))

    if (sorting) {
      rows = [...rows].sort((a, b) => {
        const dir = sorting.desc ? -1 : 1
        const av = (a as unknown as Record<string, unknown>)[sorting.columnId]
        const bv = (b as unknown as Record<string, unknown>)[sorting.columnId]
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv)
        return dir * String(av).localeCompare(String(bv))
      })
    }
    return rows
  }, [relations, filters, sorting])

  const renderFilter = (columnId: string) => {
    if (columnId === 'relationship_id' && filterOptions.relationship_id.length > 1) {
      return <MultiSelectFilter value={filters.relationship_id ? [...filters.relationship_id] : []} options={filterOptions.relationship_id} placeholder={t('concept_mapping.concept_info_col_relationship')} onChange={(v) => setFilters((f) => ({ ...f, relationship_id: v.length ? new Set(v) : undefined }))} />
    }
    if (columnId === 'concept_name') return <DebouncedInput className={FILTER_INPUT_CLASS} placeholder="..." value={filters.concept_name ?? ''} onChange={(v) => setFilters((f) => ({ ...f, concept_name: v || undefined }))} />
    if (columnId === 'concept_id') return <DebouncedInput className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="ID..." value={filters.concept_id ?? ''} onChange={(v) => setFilters((f) => ({ ...f, concept_id: v || undefined }))} />
    if (columnId === 'concept_code') return <DebouncedInput className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="Code..." value={filters.concept_code ?? ''} onChange={(v) => setFilters((f) => ({ ...f, concept_code: v || undefined }))} />
    if (columnId === 'vocabulary_id' && filterOptions.vocabulary_id.length > 1) {
      return <MultiSelectFilter value={filters.vocabulary_id ? [...filters.vocabulary_id] : []} options={filterOptions.vocabulary_id} placeholder="Vocab" onChange={(v) => setFilters((f) => ({ ...f, vocabulary_id: v.length ? new Set(v) : undefined }))} />
    }
    if (columnId === 'domain_id' && filterOptions.domain_id.length > 0) {
      return <MultiSelectFilter value={filters.domain_id ? [...filters.domain_id] : []} options={filterOptions.domain_id} placeholder="Domain" onChange={(v) => setFilters((f) => ({ ...f, domain_id: v.length ? new Set(v) : undefined }))} />
    }
    if (columnId === 'concept_class_id' && filterOptions.concept_class_id.length > 0) {
      return <MultiSelectFilter value={filters.concept_class_id ? [...filters.concept_class_id] : []} options={filterOptions.concept_class_id} placeholder="Class" onChange={(v) => setFilters((f) => ({ ...f, concept_class_id: v.length ? new Set(v) : undefined }))} />
    }
    if (columnId === 'standard_concept' && filterOptions.standard_concept.length > 0) {
      return <MultiSelectFilter value={filters.standard_concept ? [...filters.standard_concept] : []} options={filterOptions.standard_concept} placeholder="Std" onChange={(v) => setFilters((f) => ({ ...f, standard_concept: v.length ? new Set(v) : undefined }))} />
    }
    return null
  }

  const columns = useMemo<ColumnDef<RelationRow>[]>(() => [
    {
      id: 'relationship_id',
      header: () => t('concept_mapping.concept_info_col_relationship'),
      accessorFn: (r) => r.relationship_id,
      cell: ({ row }) => <TruncatedText className="text-xs text-muted-foreground">{row.original.relationship_id}</TruncatedText>,
      size: 130,
      minSize: 80,
      enableResizing: true,
    },
    {
      id: 'vocabulary_id',
      header: () => t('concept_mapping.col_vocabulary'),
      accessorFn: (r) => r.vocabulary_id,
      cell: ({ row }) => <TruncatedText className="text-xs">{row.original.vocabulary_id}</TruncatedText>,
      size: 80,
      minSize: 50,
      enableResizing: true,
    },
    {
      id: 'concept_name',
      header: () => t('concept_mapping.col_name'),
      accessorFn: (r) => r.concept_name,
      cell: ({ row }) => <TruncatedText className="text-xs">{row.original.concept_name}</TruncatedText>,
      size: 180,
      minSize: 100,
      enableResizing: true,
    },
    {
      id: 'concept_id',
      header: () => t('concept_mapping.col_concept_id'),
      accessorFn: (r) => r.concept_id,
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.concept_id}</span>,
      size: 70,
      minSize: 50,
      enableResizing: true,
    },
    {
      id: 'concept_code',
      header: () => t('concept_mapping.col_concept_code'),
      accessorFn: (r) => r.concept_code,
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.concept_code ?? ''}</span>,
      size: 80,
      minSize: 50,
      enableResizing: true,
    },
    {
      id: 'domain_id',
      header: () => t('concept_mapping.col_domain'),
      accessorFn: (r) => r.domain_id,
      cell: ({ row }) => <TruncatedText className="text-xs">{row.original.domain_id ?? ''}</TruncatedText>,
      size: 80,
      minSize: 50,
      enableResizing: true,
    },
    {
      id: 'concept_class_id',
      header: () => t('concept_mapping.col_concept_class'),
      accessorFn: (r) => r.concept_class_id,
      cell: ({ row }) => <TruncatedText className="text-xs">{row.original.concept_class_id ?? ''}</TruncatedText>,
      size: 90,
      minSize: 50,
      enableResizing: true,
    },
    {
      id: 'standard_concept',
      header: () => t('concept_mapping.col_std'),
      accessorFn: (r) => r.standard_concept,
      cell: ({ row }) => <StandardConceptBadge value={row.original.standard_concept} />,
      size: 40,
      minSize: 30,
      enableResizing: true,
    },
  ], [t])

  const table = useReactTable({
    data: filtered,
    columns,
    state: { columnVisibility, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
    manualSorting: true,
    manualFiltering: true,
  })

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
        <Table className="w-full" style={{ tableLayout: 'fixed' }}>
          <TableHeader>
            <TableRow>
              {table.getHeaderGroups().map((hg) =>
                hg.headers.map((header) => {
                  const colId = header.column.id
                  return (
                    <TableHead
                      key={header.id}
                      className="relative select-none text-xs"
                      style={{ width: header.getSize() }}
                    >
                      <button type="button" className="flex min-w-0 items-center gap-1 hover:text-foreground" onClick={() => handleSort(colId)}>
                        <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                        {!sorting || sorting.columnId !== colId
                          ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                          : sorting.desc
                            ? <ArrowDown size={10} className="shrink-0 text-primary" />
                            : <ArrowUp size={10} className="shrink-0 text-primary" />}
                      </button>
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                          className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                        >
                          <div className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40'}`} />
                        </div>
                      )}
                    </TableHead>
                  )
                })
              )}
            </TableRow>
            <TableRow className="hover:bg-transparent">
              {table.getHeaderGroups().map((hg) =>
                hg.headers.map((header) => (
                  <TableHead key={`f-${header.id}`} className="px-1 py-1" style={{ width: header.getSize() }}>
                    {renderFilter(header.column.id)}
                  </TableHead>
                ))
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-16 text-center text-xs text-muted-foreground">
                  {t('concept_mapping.concept_info_no_relations')}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.original.concept_id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className="overflow-hidden truncate px-2 py-1 text-xs"
                      style={{ maxWidth: cell.column.getSize() }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex shrink-0 items-center border-t px-3 py-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            {filtered.length} / {relations.length} {t('common.results').toLowerCase()}
          </span>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                    <Settings2 size={12} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">{t('common.columns')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="w-[180px]">
              <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table.getAllColumns().map((col) => (
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
    </div>
  )
}
