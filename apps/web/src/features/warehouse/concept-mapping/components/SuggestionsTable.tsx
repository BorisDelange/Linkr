import { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import { ArrowUpDown, ArrowUp, ArrowDown, Settings2, Check, Info, Library } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { EQUIV_BADGE } from '@/lib/concept-mapping/equivalence-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { type SuggestionCandidate, METHOD_DOT_COLORS, getMethodLabel, computeCombinedScore } from '@/lib/concept-mapping/syntactic-suggestions'

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

/**
 * Cell text that shows an instant black tooltip only when the content is visually
 * truncated. The tooltip is mounted lazily on pointer-enter (checking scrollWidth vs
 * clientWidth) so non-truncated cells never trigger it.
 */
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
  concept_id?: string
  concept_name?: string
  concept_code?: string
  vocabulary_id?: string
  domain_id?: Set<string>
  concept_class_id?: Set<string>
  standard_concept?: string | null
  providers?: Set<string>
}

interface SuggestionsTableProps {
  suggestions: SuggestionCandidate[]
  weights: Record<string, number>
  alreadyMappedIds: Set<number>
  selectedConceptId: number | null
  onSelect: (s: SuggestionCandidate | null) => void
  onInfo: (s: SuggestionCandidate) => void
  /** Open the source data-dictionary concept set for an AI suggestion. */
  onConceptSet: (s: SuggestionCandidate) => void
  /** uniqueId → concept set name, for concept sets present locally. */
  conceptSetNamesByUid: Map<string, string>
}

function getColLabel(cols: ColumnDef<SuggestionCandidate>[], id: string): string {
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

export function SuggestionsTable({ suggestions, weights, alreadyMappedIds, selectedConceptId, onSelect, onInfo, onConceptSet, conceptSetNamesByUid }: SuggestionsTableProps) {
  const { t } = useTranslation()
  const [sorting, setSorting] = useState<Sorting>({ columnId: 'combined_score', desc: true })
  const [filters, setFilters] = useState<Filters>({})
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    concept_id: false,
    concept_code: false,
    domain_id: false,
    concept_class_id: false,
    comment: false,
  })

  const handleSort = (columnId: string) => {
    if (columnId === '_check') return
    setSorting((s) =>
      s?.columnId === columnId
        ? s.desc ? { columnId, desc: false } : null
        : { columnId, desc: true }
    )
  }

  const filterOptions = useMemo(() => ({
    vocabulary_id: [...new Set(suggestions.map((s) => s.vocabulary_id).filter(Boolean))].sort(),
    domain_id: [...new Set(suggestions.map((s) => s.domain_id ?? '').filter(Boolean))].sort(),
    concept_class_id: [...new Set(suggestions.map((s) => s.concept_class_id ?? '').filter(Boolean))].sort(),
    providers: [...new Set(suggestions.flatMap((s) => s.scores.map((sc) => sc.provider)))].sort(),
  }), [suggestions])

  const reweighted = useMemo(() =>
    suggestions.map((s) => ({
      ...s,
      scores: s.scores.map((sc) => ({ ...sc, weight: weights[sc.provider] ?? sc.weight })),
      combined_score: computeCombinedScore(s.scores, weights),
    })),
  [suggestions, weights])

  const filtered = useMemo(() => {
    let rows = reweighted
    if (filters.concept_id) rows = rows.filter((s) => String(s.concept_id).includes(filters.concept_id!))
    if (filters.concept_name) {
      const q = filters.concept_name.toLowerCase()
      rows = rows.filter((s) => s.concept_name.toLowerCase().includes(q))
    }
    if (filters.concept_code) {
      const q = filters.concept_code.toLowerCase()
      rows = rows.filter((s) => s.concept_code.toLowerCase().includes(q))
    }
    if (filters.vocabulary_id) rows = rows.filter((s) => s.vocabulary_id === filters.vocabulary_id)
    if (filters.domain_id?.size) rows = rows.filter((s) => filters.domain_id!.has(s.domain_id ?? ''))
    if (filters.concept_class_id?.size) rows = rows.filter((s) => filters.concept_class_id!.has(s.concept_class_id ?? ''))
    if (filters.standard_concept) rows = rows.filter((s) => (s.standard_concept ?? '') === filters.standard_concept)
    if (filters.providers?.size) rows = rows.filter((s) => s.scores.some((sc) => filters.providers!.has(sc.provider)))

    if (sorting) {
      rows = [...rows].sort((a, b) => {
        const dir = sorting.desc ? -1 : 1
        if (sorting.columnId === 'combined_score') return dir * (a.combined_score - b.combined_score)
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
  }, [reweighted, filters, sorting])

  const renderFilter = (columnId: string) => {
    if (columnId === 'concept_id') return <DebouncedInput className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="ID..." value={filters.concept_id ?? ''} onChange={(v) => setFilters((f) => ({ ...f, concept_id: v || undefined }))} />
    if (columnId === 'concept_name') return <DebouncedInput className={FILTER_INPUT_CLASS} placeholder="..." value={filters.concept_name ?? ''} onChange={(v) => setFilters((f) => ({ ...f, concept_name: v || undefined }))} />
    if (columnId === 'concept_code') return <DebouncedInput className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="Code..." value={filters.concept_code ?? ''} onChange={(v) => setFilters((f) => ({ ...f, concept_code: v || undefined }))} />
    if (columnId === 'vocabulary_id' && filterOptions.vocabulary_id.length > 1) {
      return <MultiSelectFilter value={filters.vocabulary_id ? [filters.vocabulary_id] : []} options={filterOptions.vocabulary_id} placeholder="Vocab" onChange={(v) => setFilters((f) => ({ ...f, vocabulary_id: v[0] }))} />
    }
    if (columnId === 'domain_id' && filterOptions.domain_id.length > 0) {
      return <MultiSelectFilter value={filters.domain_id ? [...filters.domain_id] : []} options={filterOptions.domain_id} placeholder="Domain" onChange={(v) => setFilters((f) => ({ ...f, domain_id: v.length ? new Set(v) : undefined }))} />
    }
    if (columnId === 'concept_class_id' && filterOptions.concept_class_id.length > 0) {
      return <MultiSelectFilter value={filters.concept_class_id ? [...filters.concept_class_id] : []} options={filterOptions.concept_class_id} placeholder="Class" onChange={(v) => setFilters((f) => ({ ...f, concept_class_id: v.length ? new Set(v) : undefined }))} />
    }
    if (columnId === 'methods' && filterOptions.providers.length > 1) {
      return <MultiSelectFilter value={filters.providers ? [...filters.providers] : []} options={filterOptions.providers} placeholder="Méthode" onChange={(v) => setFilters((f) => ({ ...f, providers: v.length ? new Set(v) : undefined }))} />
    }
    if (columnId === 'standard_concept') {
      return (
        <Select value={filters.standard_concept ?? '__all__'} onValueChange={(v) => setFilters((f) => ({ ...f, standard_concept: v === '__all__' ? null : v }))}>
          <SelectTrigger className="h-6 w-full overflow-hidden border-dashed text-[10px] font-normal [&>svg]:hidden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('concept_mapping.filter_all')}</SelectItem>
            <SelectItem value="S" className="text-xs">S</SelectItem>
            <SelectItem value="C" className="text-xs">C</SelectItem>
          </SelectContent>
        </Select>
      )
    }
    return null
  }

  const columns = useMemo<ColumnDef<SuggestionCandidate>[]>(() => [
    {
      id: 'combined_score',
      header: () => t('concept_mapping.suggestions_col_score'),
      accessorFn: (r) => r.combined_score,
      cell: ({ row }) => {
        const pct = Math.round(row.original.combined_score * 100)
        return (
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-8 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
          </div>
        )
      },
      size: 80,
      minSize: 60,
      enableResizing: true,
    },
    {
      id: 'methods',
      header: () => t('concept_mapping.suggestions_col_provider'),
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          {row.original.scores.map(({ provider, method, score }) => {
            const pct = Math.round(score * 100)
            const dot = METHOD_DOT_COLORS[provider] ?? 'bg-gray-400'
            const label = getMethodLabel(method)
            return (
              <Tooltip key={method}>
                <TooltipTrigger asChild>
                  <span className="inline-flex cursor-default items-center gap-0.5">
                    <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
                    <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="space-y-0.5 text-xs">
                  <p className="font-medium">{provider}</p>
                  <p className="text-muted-foreground">{label}</p>
                  <p>{pct}%</p>
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      ),
      size: 70,
      minSize: 50,
      enableResizing: true,
    },
    {
      id: 'vocabulary_id',
      header: () => t('concept_mapping.col_vocabulary'),
      accessorFn: (r) => r.vocabulary_id,
      cell: ({ row }) =>
        row.original.vocabulary_id
          ? <TruncatedText className="text-xs">{row.original.vocabulary_id}</TruncatedText>
          : <span className="text-xs italic text-muted-foreground/60">—</span>,
      size: 80,
      minSize: 50,
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
      id: 'concept_name',
      header: () => t('concept_mapping.col_name'),
      accessorFn: (r) => r.concept_name,
      cell: ({ row }) =>
        row.original.concept_name
          ? <TruncatedText className="text-xs">{row.original.concept_name}</TruncatedText>
          : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block truncate text-xs italic text-muted-foreground/60">
                  {t('concept_mapping.suggestions_concept_not_found')}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                {t('concept_mapping.suggestions_concept_not_found_hint')}
              </TooltipContent>
            </Tooltip>
          ),
      size: 180,
      minSize: 100,
      enableResizing: true,
    },
    {
      id: 'concept_code',
      header: () => t('concept_mapping.col_concept_code'),
      accessorFn: (r) => r.concept_code,
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.concept_code}</span>,
      size: 80,
      minSize: 50,
      enableResizing: true,
    },
    {
      id: 'domain_id',
      header: () => t('concept_mapping.col_domain'),
      accessorFn: (r) => r.domain_id,
      cell: ({ row }) => <span className="text-xs">{row.original.domain_id ?? ''}</span>,
      size: 80,
      minSize: 50,
      enableResizing: true,
    },
    {
      id: 'concept_class_id',
      header: () => t('concept_mapping.col_concept_class'),
      accessorFn: (r) => r.concept_class_id,
      cell: ({ row }) => <span className="text-xs">{row.original.concept_class_id ?? ''}</span>,
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
    {
      id: 'equivalence',
      header: () => t('concept_mapping.col_equivalence'),
      accessorFn: (r) => r.equivalence,
      cell: ({ row }) => {
        const eq = row.original.equivalence ?? 'skos:exactMatch'
        const badge = EQUIV_BADGE[eq]
        if (!badge) return <span className="text-[10px] text-muted-foreground">{eq}</span>
        return (
          <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] font-medium ${badge.className}`} title={eq}>
            {badge.label}
          </Badge>
        )
      },
      size: 70,
      minSize: 50,
      enableResizing: true,
    },
    {
      id: 'comment',
      header: () => t('concept_mapping.col_comment'),
      accessorFn: (r) => r.comment ?? '',
      cell: ({ row }) => (
        <span className="text-[10px] text-muted-foreground" title={row.original.comment ?? undefined}>
          {row.original.comment ?? ''}
        </span>
      ),
      size: 180,
      minSize: 80,
      enableResizing: true,
    },
    {
      id: 'concept_set',
      header: () => t('concept_mapping.col_concept_set'),
      accessorFn: (r) => (r.conceptSetUid ? (conceptSetNamesByUid.get(r.conceptSetUid) ?? r.conceptSetUid) : ''),
      cell: ({ row }) => {
        const uid = row.original.conceptSetUid
        if (!uid) return <span className="text-[10px] text-muted-foreground">—</span>
        const localName = conceptSetNamesByUid.get(uid)
        const label = localName ?? t('concept_mapping.cs_not_local')
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); onConceptSet(row.original) }}
              >
                <Library size={11} className="shrink-0" />
                <span className={`truncate ${localName ? '' : 'italic'}`}>{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">
              {localName ? t('concept_mapping.cs_open_detail') : t('concept_mapping.cs_not_local_hint')}
            </TooltipContent>
          </Tooltip>
        )
      },
      size: 150,
      minSize: 60,
      enableResizing: true,
    },
    {
      id: '_actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-0.5">
          {alreadyMappedIds.has(row.original.concept_id) && <Check size={11} className="text-green-600 shrink-0" />}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); onInfo(row.original) }}
              >
                <Info size={11} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">{t('concept_mapping.concept_info_btn')}</TooltipContent>
          </Tooltip>
        </div>
      ),
      size: 48,
      minSize: 48,
      enableResizing: false,
    },
  ], [t, alreadyMappedIds, onInfo, onConceptSet, conceptSetNamesByUid])

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
      <div className="flex-1 overflow-auto" style={{ paddingRight: 'calc(var(--spacing) * 2.5)' }}>
        <Table className="w-full" style={{ tableLayout: 'fixed' }}>
          <TableHeader>
            <TableRow>
              {table.getHeaderGroups().map((hg) =>
                hg.headers.map((header) => {
                  const colId = header.column.id
                  const isSortable = colId !== '_check'
                  return (
                    <TableHead
                      key={header.id}
                      className="relative select-none text-xs"
                      style={{ width: header.getSize() }}
                    >
                      {isSortable ? (
                        <button type="button" className="flex min-w-0 items-center gap-1 hover:text-foreground" onClick={() => handleSort(colId)}>
                          <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                          {!sorting || sorting.columnId !== colId
                            ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                            : sorting.desc
                              ? <ArrowDown size={10} className="shrink-0 text-primary" />
                              : <ArrowUp size={10} className="shrink-0 text-primary" />}
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
            {table.getRowModel().rows.map((row) => {
                const alreadyMapped = alreadyMappedIds.has(row.original.concept_id)
                const isSelected = selectedConceptId === row.original.concept_id
                return (
                  <TableRow
                    key={row.original.concept_id}
                    className={`cursor-pointer ${isSelected ? 'bg-accent' : ''} ${alreadyMapped ? 'opacity-40' : ''}`}
                    onClick={() => { if (!alreadyMapped) onSelect(isSelected ? null : row.original) }}
                  >
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
                )
              })}
          </TableBody>
        </Table>
      </div>

      <div className="flex shrink-0 items-center border-t px-3 py-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            {filtered.length} / {suggestions.length} {t('common.results').toLowerCase()}
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
              {table.getAllColumns()
                .filter((col) => !col.id.startsWith('_'))
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
    </div>
  )
}
