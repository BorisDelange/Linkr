import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, ArrowUpDown, ChevronDown, X, Check } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { DataCatalog, CatalogResultCache, CatalogResultRow } from '@/types'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
}

type SortKey = 'conceptName' | 'patientCount' | 'recordCount' | string

/** Simple fuzzy match: all query tokens must appear (in any order) in the target string. */
function fuzzyMatch(target: string, query: string): boolean {
  const lower = target.toLowerCase()
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.every((tok) => lower.includes(tok))
}

// ── Multi-select filter dropdown ─────────────────────────────────

interface FilterDropdownProps {
  label: string
  values: string[]
  selected: Set<string>
  onToggle: (value: string) => void
  onClear: () => void
}

function FilterDropdown({ label, values, selected, onToggle, onClear }: FilterDropdownProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

  const filtered = search.trim()
    ? values.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
    : values

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={selected.size > 0 ? 'secondary' : 'outline'}
          size="sm"
          className="h-8 gap-1 text-xs"
        >
          {label}
          {selected.size > 0 && (
            <Badge variant="default" className="ml-0.5 h-4 min-w-4 px-1 text-[9px]">
              {selected.size}
            </Badge>
          )}
          <ChevronDown size={12} className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0" onCloseAutoFocus={(e) => e.preventDefault()}>
        {/* Search within values */}
        <div className="border-b p-2">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('data_catalog.search_filter_values')}
              className="h-8 pl-7 text-xs"
            />
          </div>
        </div>

        {/* Scrollable checkbox list */}
        <div className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t('data_catalog.no_results')}
            </p>
          ) : (
            filtered.map((val) => {
              const isSelected = selected.has(val)
              return (
                <button
                  key={val}
                  onClick={() => onToggle(val)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <div
                    className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border ${
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/30'
                    }`}
                  >
                    {isSelected && <Check size={9} />}
                  </div>
                  <span className="min-w-0 truncate">{val}</span>
                </button>
              )
            })
          )}
        </div>

        {/* Footer: clear */}
        {selected.size > 0 && (
          <div className="border-t p-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={onClear}
            >
              {t('data_catalog.clear_filter')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ── Main component ───────────────────────────────────────────────

/** Filterable column definition */
interface FilterColumn {
  key: string
  label: string
  getValue: (row: CatalogResultRow) => string | null | undefined
}

export function CatalogDataTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('patientCount')
  const [sortDesc, setSortDesc] = useState(true)
  const [page, setPage] = useState(0)
  const [activeFilters, setActiveFilters] = useState<Record<string, Set<string>>>({})
  const pageSize = 50

  const enabledDims = useMemo(
    () => catalog.dimensions.filter((d) => d.enabled),
    [catalog.dimensions],
  )

  const hasCategory = !!catalog.categoryColumn
  const hasSubcategory = !!catalog.subcategoryColumn

  // Show vocabulary column when there are multiple dictionaries
  const hasDictionary = useMemo(() => {
    const keys = new Set(cache.rows.map((r) => r.dictionaryKey).filter(Boolean))
    return keys.size > 1
  }, [cache.rows])

  // Build list of filterable columns dynamically
  const filterColumns = useMemo<FilterColumn[]>(() => {
    const cols: FilterColumn[] = []
    if (hasDictionary) {
      cols.push({
        key: 'dictionaryKey',
        label: t('data_catalog.col_vocabulary'),
        getValue: (r) => r.dictionaryKey ?? null,
      })
    }
    if (hasCategory) {
      cols.push({
        key: 'category',
        label: t('data_catalog.col_category'),
        getValue: (r) => r.category,
      })
    }
    if (hasSubcategory) {
      cols.push({
        key: 'subcategory',
        label: t('data_catalog.col_subcategory'),
        getValue: (r) => r.subcategory,
      })
    }
    for (const dim of enabledDims) {
      cols.push({
        key: dim.id,
        label: t(`data_catalog.dim_${dim.type}`),
        getValue: (r) => {
          const v = r.dimensions[dim.id]
          return v != null ? String(v) : null
        },
      })
    }
    return cols
  }, [hasDictionary, hasCategory, hasSubcategory, enabledDims, t])

  // Precompute distinct values per filter column
  // Subcategory values are scoped to the active category selection
  const distinctValues = useMemo(() => {
    const result: Record<string, string[]> = {}
    const categorySelection = hasCategory ? activeFilters['category'] : undefined
    const hasCategoryFilter = categorySelection && categorySelection.size > 0

    for (const col of filterColumns) {
      const valSet = new Set<string>()
      // For subcategory: only consider rows matching the active category filter
      const sourceRows = (col.key === 'subcategory' && hasCategoryFilter)
        ? cache.rows.filter((r) => r.category != null && categorySelection!.has(r.category))
        : cache.rows
      for (const row of sourceRows) {
        const v = col.getValue(row)
        if (v != null && v !== '') valSet.add(v)
      }
      result[col.key] = Array.from(valSet).sort((a, b) => a.localeCompare(b))
    }
    return result
  }, [cache.rows, filterColumns, hasCategory, activeFilters])

  // Filter + sort rows
  const filteredRows = useMemo(() => {
    let rows = cache.rows

    // Fuzzy text search on concept name + ID
    if (search.trim()) {
      rows = rows.filter(
        (r) =>
          fuzzyMatch(r.conceptName, search) ||
          fuzzyMatch(String(r.conceptId), search),
      )
    }

    // Multi-select column filters
    for (const col of filterColumns) {
      const selected = activeFilters[col.key]
      if (selected && selected.size > 0) {
        rows = rows.filter((r) => {
          const v = col.getValue(r)
          return v != null && selected.has(v)
        })
      }
    }

    // Sort
    rows = [...rows].sort((a, b) => {
      let aVal: string | number | null
      let bVal: string | number | null

      if (sortKey === 'conceptName') {
        aVal = a.conceptName
        bVal = b.conceptName
      } else if (sortKey === 'dictionaryKey') {
        aVal = a.dictionaryKey ?? null
        bVal = b.dictionaryKey ?? null
      } else if (sortKey === 'category') {
        aVal = a.category ?? null
        bVal = b.category ?? null
      } else if (sortKey === 'subcategory') {
        aVal = a.subcategory ?? null
        bVal = b.subcategory ?? null
      } else if (sortKey === 'patientCount') {
        aVal = a.patientCount
        bVal = b.patientCount
      } else if (sortKey === 'visitCount') {
        aVal = a.visitCount ?? 0
        bVal = b.visitCount ?? 0
      } else if (sortKey === 'recordCount') {
        aVal = a.recordCount
        bVal = b.recordCount
      } else {
        aVal = a.dimensions[sortKey] ?? null
        bVal = b.dimensions[sortKey] ?? null
      }

      if (aVal == null && bVal == null) return 0
      if (aVal == null) return 1
      if (bVal == null) return -1

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDesc ? bVal - aVal : aVal - bVal
      }

      const cmp = String(aVal).localeCompare(String(bVal))
      return sortDesc ? -cmp : cmp
    })

    return rows
  }, [cache.rows, search, sortKey, sortDesc, activeFilters, filterColumns])

  const totalPages = Math.ceil(filteredRows.length / pageSize)
  const pageRows = filteredRows.slice(page * pageSize, (page + 1) * pageSize)

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc(!sortDesc)
    } else {
      setSortKey(key)
      setSortDesc(true)
    }
    setPage(0)
  }

  const toggleFilterValue = useCallback((colKey: string, value: string) => {
    setActiveFilters((prev) => {
      const current = new Set(prev[colKey] ?? [])
      if (current.has(value)) {
        current.delete(value)
      } else {
        current.add(value)
      }
      const next = { ...prev, [colKey]: current }
      // When category changes, clear subcategory selections that may no longer be valid
      if (colKey === 'category' && prev['subcategory']?.size) {
        next['subcategory'] = new Set<string>()
      }
      return next
    })
    setPage(0)
  }, [])

  const clearFilter = useCallback((colKey: string) => {
    setActiveFilters((prev) => {
      const next = { ...prev }
      delete next[colKey]
      return next
    })
    setPage(0)
  }, [])

  const clearAllFilters = useCallback(() => {
    setActiveFilters({})
    setPage(0)
  }, [])

  const activeFilterCount = Object.values(activeFilters).reduce(
    (sum, s) => sum + (s.size > 0 ? 1 : 0),
    0,
  )

  const SortButton = ({ colKey, children }: { colKey: SortKey; children: React.ReactNode }) => (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-7 text-xs font-medium"
      onClick={() => handleSort(colKey)}
    >
      {children}
      <ArrowUpDown size={12} className="ml-1" />
    </Button>
  )

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="flex gap-3">
        <Card className="flex-1 p-3 text-center">
          <p className="text-2xl font-bold">{cache.totalConcepts.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{t('data_catalog.total_concepts')}</p>
        </Card>
        <Card className="flex-1 p-3 text-center">
          <p className="text-2xl font-bold">{cache.totalPatients.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{t('data_catalog.total_patients')}</p>
        </Card>
        <Card className="flex-1 p-3 text-center">
          <p className="text-2xl font-bold">{(cache.totalVisits ?? 0).toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{t('data_catalog.total_visits')}</p>
        </Card>
        <Card className="flex-1 p-3 text-center">
          <p className="text-2xl font-bold">{cache.rows.length.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{t('data_catalog.total_rows')}</p>
        </Card>
      </div>

      {/* Search + Filter dropdowns */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0) }}
            placeholder={t('data_catalog.search_concepts')}
            className="h-8 pl-8 text-xs"
          />
        </div>

        {/* One dropdown per filterable column */}
        {filterColumns.map((col) => (
          <FilterDropdown
            key={col.key}
            label={col.label}
            values={distinctValues[col.key] ?? []}
            selected={activeFilters[col.key] ?? new Set()}
            onToggle={(val) => toggleFilterValue(col.key, val)}
            onClear={() => clearFilter(col.key)}
          />
        ))}

        {/* Clear all filters */}
        {activeFilterCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-xs text-muted-foreground"
            onClick={clearAllFilters}
          >
            <X size={12} />
            {t('data_catalog.clear_all')}
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">
                <SortButton colKey="conceptId">{t('data_catalog.col_concept_id')}</SortButton>
              </TableHead>
              <TableHead>
                <SortButton colKey="conceptName">{t('data_catalog.col_concept_name')}</SortButton>
              </TableHead>
              {hasDictionary && (
                <TableHead>
                  <SortButton colKey="dictionaryKey">{t('data_catalog.col_vocabulary')}</SortButton>
                </TableHead>
              )}
              {hasCategory && (
                <TableHead>
                  <SortButton colKey="category">{t('data_catalog.col_category')}</SortButton>
                </TableHead>
              )}
              {hasSubcategory && (
                <TableHead>
                  <SortButton colKey="subcategory">{t('data_catalog.col_subcategory')}</SortButton>
                </TableHead>
              )}
              {enabledDims.map((dim) => (
                <TableHead key={dim.id}>
                  <SortButton colKey={dim.id}>{t(`data_catalog.dim_${dim.type}`)}</SortButton>
                </TableHead>
              ))}
              <TableHead className="w-28 text-right">
                <SortButton colKey="patientCount">{t('data_catalog.col_patients')}</SortButton>
              </TableHead>
              <TableHead className="w-28 text-right">
                <SortButton colKey="visitCount">{t('data_catalog.col_visits')}</SortButton>
              </TableHead>
              <TableHead className="w-28 text-right">
                <SortButton colKey="recordCount">{t('data_catalog.col_records')}</SortButton>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5 + enabledDims.length + (hasDictionary ? 1 : 0) + (hasCategory ? 1 : 0) + (hasSubcategory ? 1 : 0)} className="py-8 text-center text-sm text-muted-foreground">
                  {t('data_catalog.no_results')}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row, i) => (
                <TableRow key={`${row.conceptId}-${i}`}>
                  <TableCell className="font-mono text-xs">{row.conceptId}</TableCell>
                  <TableCell className="text-sm">{row.conceptName}</TableCell>
                  {hasDictionary && (
                    <TableCell className="text-xs">{row.dictionaryKey ?? '—'}</TableCell>
                  )}
                  {hasCategory && (
                    <TableCell className="text-xs">{row.category ?? '—'}</TableCell>
                  )}
                  {hasSubcategory && (
                    <TableCell className="text-xs">{row.subcategory ?? '—'}</TableCell>
                  )}
                  {enabledDims.map((dim) => (
                    <TableCell key={dim.id} className="text-xs">
                      {row.dimensions[dim.id] ?? '—'}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-mono text-xs">
                    {row.patientCount.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {(row.visitCount ?? 0).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {row.recordCount.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {t('data_catalog.showing_rows', {
              from: page * pageSize + 1,
              to: Math.min((page + 1) * pageSize, filteredRows.length),
              total: filteredRows.length,
            })}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              {t('common.back')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage(page + 1)}
            >
              {t('data_catalog.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
