import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, ArrowUpDown, ChevronDown, X, Check } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { DataCatalog, CatalogResultCache, CatalogConceptRow, CatalogPeriodRow } from '@/types'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
}

/** Simple fuzzy match: all query tokens must appear (in any order) in the target string. */
function fuzzyMatch(target: string, query: string): boolean {
  const lower = target.toLowerCase()
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.every((tok) => lower.includes(tok))
}

/** Debounce hook: returns debounced value after `delay` ms of inactivity. */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
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

// ── Sort button ──────────────────────────────────────────────────

function SortButton({ colKey, sortKey, sortDesc, onSort, children }: {
  colKey: string
  sortKey: string
  sortDesc: boolean
  onSort: (key: string) => void
  children: React.ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-7 text-xs font-medium"
      onClick={() => onSort(colKey)}
    >
      {children}
      <ArrowUpDown size={12} className="ml-1" />
    </Button>
  )
}

// ── Anonymization display helper ─────────────────────────────────

function formatCount(count: number, threshold: number): string {
  if (count < threshold) return `< ${threshold}`
  return count.toLocaleString()
}

// ── Concepts sub-tab ─────────────────────────────────────────────

type SortKey = 'conceptId' | 'conceptName' | 'dictionaryKey' | 'category' | 'subcategory' | 'patientCount' | 'visitCount' | 'recordCount'

function getSortValue(row: CatalogConceptRow, key: SortKey): string | number | null {
  switch (key) {
    case 'conceptId': return typeof row.conceptId === 'number' ? row.conceptId : String(row.conceptId)
    case 'conceptName': return row.conceptName
    case 'dictionaryKey': return row.dictionaryKey ?? null
    case 'category': return row.category ?? null
    case 'subcategory': return row.subcategory ?? null
    case 'patientCount': return row.patientCount
    case 'visitCount': return row.visitCount
    case 'recordCount': return row.recordCount
  }
}

function compareRows(a: CatalogConceptRow, b: CatalogConceptRow, sortKey: SortKey, sortDesc: boolean): number {
  const aVal = getSortValue(a, sortKey)
  const bVal = getSortValue(b, sortKey)
  if (aVal == null && bVal == null) return 0
  if (aVal == null) return 1
  if (bVal == null) return -1
  if (typeof aVal === 'number' && typeof bVal === 'number') return sortDesc ? bVal - aVal : aVal - bVal
  const cmp = String(aVal).localeCompare(String(bVal))
  return sortDesc ? -cmp : cmp
}

function ConceptsView({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const threshold = catalog.anonymization.threshold
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 250)
  const [sortKey, setSortKey] = useState<SortKey>('patientCount')
  const [sortDesc, setSortDesc] = useState(true)
  const [page, setPage] = useState(0)
  const [activeFilters, setActiveFilters] = useState<Record<string, Set<string>>>({})
  const pageSize = 50

  const hasCategory = !!catalog.categoryColumn
  const hasSubcategory = !!catalog.subcategoryColumn

  const hasDictionary = useMemo(() => {
    const keys = new Set(cache.concepts.map((r) => r.dictionaryKey).filter(Boolean))
    return keys.size > 1
  }, [cache.concepts])

  // Build filterable columns
  interface FilterColumn {
    key: string
    label: string
    getValue: (row: CatalogConceptRow) => string | null | undefined
  }

  const filterColumns = useMemo<FilterColumn[]>(() => {
    const cols: FilterColumn[] = []
    if (hasDictionary) {
      cols.push({ key: 'dictionaryKey', label: t('data_catalog.col_vocabulary'), getValue: (r) => r.dictionaryKey ?? null })
    }
    if (hasCategory) {
      cols.push({ key: 'category', label: t('data_catalog.col_category'), getValue: (r) => r.category })
    }
    if (hasSubcategory) {
      cols.push({ key: 'subcategory', label: t('data_catalog.col_subcategory'), getValue: (r) => r.subcategory })
    }
    return cols
  }, [hasDictionary, hasCategory, hasSubcategory, t])

  const distinctValues = useMemo(() => {
    const result: Record<string, string[]> = {}
    const categorySelection = hasCategory ? activeFilters['category'] : undefined
    const hasCategoryFilter = categorySelection && categorySelection.size > 0

    for (const col of filterColumns) {
      const valSet = new Set<string>()
      const sourceRows = (col.key === 'subcategory' && hasCategoryFilter)
        ? cache.concepts.filter((r) => r.category != null && categorySelection!.has(r.category))
        : cache.concepts
      for (const row of sourceRows) {
        const v = col.getValue(row)
        if (v != null && v !== '') valSet.add(v)
      }
      result[col.key] = Array.from(valSet).sort((a, b) => a.localeCompare(b))
    }
    return result
  }, [cache.concepts, filterColumns, hasCategory, activeFilters])

  // Pre-sort the full dataset whenever sort key/direction changes (avoid re-sorting on search/filter changes)
  const sortedConcepts = useMemo(() => {
    const arr = [...cache.concepts]
    arr.sort((a, b) => compareRows(a, b, sortKey, sortDesc))
    return arr
  }, [cache.concepts, sortKey, sortDesc])

  // Filter from the pre-sorted array
  const filteredRows = useMemo(() => {
    let rows = sortedConcepts

    if (debouncedSearch.trim()) {
      rows = rows.filter(
        (r) => fuzzyMatch(r.conceptName, debouncedSearch) || fuzzyMatch(String(r.conceptId), debouncedSearch),
      )
    }

    for (const col of filterColumns) {
      const selected = activeFilters[col.key]
      if (selected && selected.size > 0) {
        rows = rows.filter((r) => {
          const v = col.getValue(r)
          return v != null && selected.has(v)
        })
      }
    }

    return rows
  }, [sortedConcepts, debouncedSearch, activeFilters, filterColumns])

  const totalPages = Math.ceil(filteredRows.length / pageSize)
  const pageRows = filteredRows.slice(page * pageSize, (page + 1) * pageSize)

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDesc(!sortDesc)
    else { setSortKey(key as SortKey); setSortDesc(true) }
    setPage(0)
  }

  const toggleFilterValue = useCallback((colKey: string, value: string) => {
    setActiveFilters((prev) => {
      const current = new Set(prev[colKey] ?? [])
      if (current.has(value)) current.delete(value)
      else current.add(value)
      const next = { ...prev, [colKey]: current }
      if (colKey === 'category' && prev['subcategory']?.size) next['subcategory'] = new Set<string>()
      return next
    })
    setPage(0)
  }, [])

  const clearFilter = useCallback((colKey: string) => {
    setActiveFilters((prev) => { const next = { ...prev }; delete next[colKey]; return next })
    setPage(0)
  }, [])

  const clearAllFilters = useCallback(() => { setActiveFilters({}); setPage(0) }, [])

  // Reset page when search changes
  const prevSearchRef = useRef(debouncedSearch)
  useEffect(() => {
    if (prevSearchRef.current !== debouncedSearch) {
      setPage(0)
      prevSearchRef.current = debouncedSearch
    }
  }, [debouncedSearch])

  const activeFilterCount = Object.values(activeFilters).reduce((sum, s) => sum + (s.size > 0 ? 1 : 0), 0)

  const colSpan = 4 + (hasDictionary ? 1 : 0) + (hasCategory ? 1 : 0) + (hasSubcategory ? 1 : 0)

  return (
    <div className="space-y-4">
      {/* Search + Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('data_catalog.search_concepts')}
            className="h-8 pl-8 text-xs"
          />
        </div>
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
        {activeFilterCount > 0 && (
          <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" onClick={clearAllFilters}>
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
                <SortButton colKey="conceptId" sortKey={sortKey} sortDesc={sortDesc} onSort={handleSort}>{t('data_catalog.col_concept_id')}</SortButton>
              </TableHead>
              <TableHead>
                <SortButton colKey="conceptName" sortKey={sortKey} sortDesc={sortDesc} onSort={handleSort}>{t('data_catalog.col_concept_name')}</SortButton>
              </TableHead>
              {hasDictionary && (
                <TableHead>
                  <SortButton colKey="dictionaryKey" sortKey={sortKey} sortDesc={sortDesc} onSort={handleSort}>{t('data_catalog.col_vocabulary')}</SortButton>
                </TableHead>
              )}
              {hasCategory && (
                <TableHead>
                  <SortButton colKey="category" sortKey={sortKey} sortDesc={sortDesc} onSort={handleSort}>{t('data_catalog.col_category')}</SortButton>
                </TableHead>
              )}
              {hasSubcategory && (
                <TableHead>
                  <SortButton colKey="subcategory" sortKey={sortKey} sortDesc={sortDesc} onSort={handleSort}>{t('data_catalog.col_subcategory')}</SortButton>
                </TableHead>
              )}
              <TableHead className="w-28 text-right">
                <SortButton colKey="patientCount" sortKey={sortKey} sortDesc={sortDesc} onSort={handleSort}>{t('data_catalog.col_patients')}</SortButton>
              </TableHead>
              <TableHead className="w-28 text-right">
                <SortButton colKey="visitCount" sortKey={sortKey} sortDesc={sortDesc} onSort={handleSort}>{t('data_catalog.col_visits')}</SortButton>
              </TableHead>
              <TableHead className="w-28 text-right">
                <SortButton colKey="recordCount" sortKey={sortKey} sortDesc={sortDesc} onSort={handleSort}>{t('data_catalog.col_records')}</SortButton>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-8 text-center text-sm text-muted-foreground">
                  {t('data_catalog.no_results')}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row, i) => {
                const isAnon = row.patientCount < threshold
                return (
                  <TableRow key={`${row.conceptId}-${i}`} className={isAnon ? 'text-amber-600 dark:text-amber-400' : undefined}>
                    <TableCell className="font-mono text-xs">{row.conceptId}</TableCell>
                    <TableCell className="text-sm">{row.conceptName}</TableCell>
                    {hasDictionary && <TableCell className="text-xs">{row.dictionaryKey ?? '—'}</TableCell>}
                    {hasCategory && <TableCell className="text-xs">{row.category ?? '—'}</TableCell>}
                    {hasSubcategory && <TableCell className="text-xs">{row.subcategory ?? '—'}</TableCell>}
                    <TableCell className="text-right font-mono text-xs">{formatCount(row.patientCount, threshold)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{formatCount(row.visitCount, threshold)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{formatCount(row.recordCount, threshold)}</TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('data_catalog.showing_rows', { from: page * pageSize + 1, to: Math.min((page + 1) * pageSize, filteredRows.length), total: filteredRows.length })}</span>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('common.back')}</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>{t('data_catalog.next')}</Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Periods sub-tab ──────────────────────────────────────────────

function MaskedCell({ value, threshold }: { value: number | null; threshold: number }) {
  if (value === null) return <span className="text-amber-600 dark:text-amber-400">{'< ' + threshold}</span>
  return <span>{value.toLocaleString()}</span>
}

function PeriodsView({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const threshold = catalog.anonymization.threshold
  const periods = cache.periods ?? []
  const reliabilityScore = cache.periodReliabilityScore ?? 0

  const allRow = periods.find((r) => r.period_granularity === 'all')
  const dataRows = useMemo(() => periods.filter((r) => r.period_granularity !== 'all'), [periods])

  const [page, setPage] = useState(0)
  const pageSize = 50
  const totalPages = Math.ceil(dataRows.length / pageSize)
  const pageRows = dataRows.slice(page * pageSize, (page + 1) * pageSize)

  if (periods.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {t('data_catalog.no_data')}
      </div>
    )
  }

  // Collect all service labels and category labels from the data
  const serviceLabels = allRow ? Object.keys(allRow.services) : []
  const categoryLabels = allRow ? Object.keys(allRow.concept_categories) : []
  const ageBucketLabels = allRow ? Object.keys(allRow.age_buckets) : []

  const maskedPct = Math.round(reliabilityScore * 100)

  return (
    <div className="space-y-3">
      {/* Reliability indicator */}
      <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${maskedPct > 20 ? 'border-amber-400/50 bg-amber-50 dark:bg-amber-950/20' : 'bg-muted/30'}`}>
        <span className={maskedPct > 20 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
          {t('data_catalog.period_reliability_score', { pct: maskedPct })}
        </span>
        {maskedPct > 20 && (
          <span className="text-amber-600 dark:text-amber-400">— {t('data_catalog.period_reliability_warning')}</span>
        )}
      </div>

      {/* Scrollable table */}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 min-w-28 bg-background">{t('data_catalog.period_col_period')}</TableHead>
              <TableHead className="min-w-24 text-right">{t('data_catalog.period_col_n_patients')}</TableHead>
              <TableHead className="min-w-24 text-right">{t('data_catalog.period_col_n_sejours')}</TableHead>
              <TableHead className="min-w-16 text-right">{t('data_catalog.period_col_sex_m')}</TableHead>
              <TableHead className="min-w-16 text-right">{t('data_catalog.period_col_sex_f')}</TableHead>
              <TableHead className="min-w-16 text-right">{t('data_catalog.period_col_sex_other')}</TableHead>
              {ageBucketLabels.map((label) => (
                <TableHead key={label} className="min-w-20 text-right text-xs">{label}</TableHead>
              ))}
              {serviceLabels.map((svc) => (
                <TableHead key={svc} className="min-w-28 text-right text-xs" colSpan={2}>{svc}</TableHead>
              ))}
              {categoryLabels.map((cat) => (
                <TableHead key={cat} className="min-w-28 text-right text-xs" colSpan={2}>{cat}</TableHead>
              ))}
            </TableRow>
            {/* Sub-header for services and categories */}
            {(serviceLabels.length > 0 || categoryLabels.length > 0) && (
              <TableRow className="bg-muted/30">
                <TableHead className="sticky left-0 z-10 bg-muted/30" />
                <TableHead /><TableHead /><TableHead /><TableHead /><TableHead />
                {ageBucketLabels.map((label) => <TableHead key={label} />)}
                {serviceLabels.map((svc) => (
                  <>
                    <TableHead key={`${svc}-pat`} className="text-right text-[10px] text-muted-foreground">{t('data_catalog.period_col_n_patients')}</TableHead>
                    <TableHead key={`${svc}-sej`} className="text-right text-[10px] text-muted-foreground">{t('data_catalog.period_col_n_sejours')}</TableHead>
                  </>
                ))}
                {categoryLabels.map((cat) => (
                  <>
                    <TableHead key={`${cat}-pat`} className="text-right text-[10px] text-muted-foreground">{t('data_catalog.period_col_n_patients')}</TableHead>
                    <TableHead key={`${cat}-rows`} className="text-right text-[10px] text-muted-foreground">{t('data_catalog.col_records')}</TableHead>
                  </>
                ))}
              </TableRow>
            )}
          </TableHeader>
          <TableBody>
            {/* ALL row — always visible (sticky, not paginated) */}
            {allRow && (
              <TableRow className="bg-muted/20 font-medium">
                <TableCell className="sticky left-0 z-10 bg-muted/20 text-xs font-semibold">{allRow.period_label}</TableCell>
                <TableCell className="text-right font-mono text-xs"><MaskedCell value={allRow.n_patients} threshold={threshold} /></TableCell>
                <TableCell className="text-right font-mono text-xs"><MaskedCell value={allRow.n_sejours} threshold={threshold} /></TableCell>
                <TableCell className="text-right font-mono text-xs"><MaskedCell value={allRow.sex_m} threshold={threshold} /></TableCell>
                <TableCell className="text-right font-mono text-xs"><MaskedCell value={allRow.sex_f} threshold={threshold} /></TableCell>
                <TableCell className="text-right font-mono text-xs"><MaskedCell value={allRow.sex_other} threshold={threshold} /></TableCell>
                {ageBucketLabels.map((label) => (
                  <TableCell key={label} className="text-right font-mono text-xs"><MaskedCell value={allRow.age_buckets[label] ?? null} threshold={threshold} /></TableCell>
                ))}
                {serviceLabels.map((svc) => (
                  <>
                    <TableCell key={`${svc}-pat`} className="text-right font-mono text-xs"><MaskedCell value={allRow.services[svc]?.n_patients ?? null} threshold={threshold} /></TableCell>
                    <TableCell key={`${svc}-sej`} className="text-right font-mono text-xs"><MaskedCell value={allRow.services[svc]?.n_sejours ?? null} threshold={threshold} /></TableCell>
                  </>
                ))}
                {categoryLabels.map((cat) => (
                  <>
                    <TableCell key={`${cat}-pat`} className="text-right font-mono text-xs"><MaskedCell value={allRow.concept_categories[cat]?.n_patients ?? null} threshold={threshold} /></TableCell>
                    <TableCell key={`${cat}-rows`} className="text-right font-mono text-xs"><MaskedCell value={allRow.concept_categories[cat]?.n_rows ?? null} threshold={threshold} /></TableCell>
                  </>
                ))}
              </TableRow>
            )}
            {/* Paginated period rows */}
            {pageRows.map((row) => (
              <TableRow key={row.period_start}>
                <TableCell className="sticky left-0 z-10 bg-background text-xs">{row.period_label}</TableCell>
                <TableCell className="text-right font-mono text-xs"><MaskedCell value={row.n_patients} threshold={threshold} /></TableCell>
                <TableCell className="text-right font-mono text-xs"><MaskedCell value={row.n_sejours} threshold={threshold} /></TableCell>
                <TableCell className="text-right font-mono text-xs"><MaskedCell value={row.sex_m} threshold={threshold} /></TableCell>
                <TableCell className="text-right font-mono text-xs"><MaskedCell value={row.sex_f} threshold={threshold} /></TableCell>
                <TableCell className="text-right font-mono text-xs"><MaskedCell value={row.sex_other} threshold={threshold} /></TableCell>
                {ageBucketLabels.map((label) => (
                  <TableCell key={label} className="text-right font-mono text-xs"><MaskedCell value={row.age_buckets[label] ?? null} threshold={threshold} /></TableCell>
                ))}
                {serviceLabels.map((svc) => (
                  <>
                    <TableCell key={`${svc}-pat`} className="text-right font-mono text-xs"><MaskedCell value={row.services[svc]?.n_patients ?? null} threshold={threshold} /></TableCell>
                    <TableCell key={`${svc}-sej`} className="text-right font-mono text-xs"><MaskedCell value={row.services[svc]?.n_sejours ?? null} threshold={threshold} /></TableCell>
                  </>
                ))}
                {categoryLabels.map((cat) => (
                  <>
                    <TableCell key={`${cat}-pat`} className="text-right font-mono text-xs"><MaskedCell value={row.concept_categories[cat]?.n_patients ?? null} threshold={threshold} /></TableCell>
                    <TableCell key={`${cat}-rows`} className="text-right font-mono text-xs"><MaskedCell value={row.concept_categories[cat]?.n_rows ?? null} threshold={threshold} /></TableCell>
                  </>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('data_catalog.showing_rows', { from: page * pageSize + 1, to: Math.min((page + 1) * pageSize, dataRows.length), total: dataRows.length })}</span>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('common.back')}</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>{t('data_catalog.next')}</Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────

export function CatalogDataTab({ catalog, cache }: Props) {
  const { t } = useTranslation()

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
          <p className="text-2xl font-bold">{cache.totalVisits.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{t('data_catalog.total_visits')}</p>
        </Card>
      </div>

      {/* Sub-tabs: Periods / Concepts */}
      <Tabs defaultValue={cache.periods ? 'periods' : 'concepts'}>
        <TabsList>
          {cache.periods && <TabsTrigger value="periods">{t('data_catalog.subtab_periods')}</TabsTrigger>}
          <TabsTrigger value="concepts">{t('data_catalog.subtab_concepts')}</TabsTrigger>
        </TabsList>
        {cache.periods && (
          <TabsContent value="periods" className="mt-4">
            <PeriodsView catalog={catalog} cache={cache} />
          </TabsContent>
        )}
        <TabsContent value="concepts" className="mt-4">
          <ConceptsView catalog={catalog} cache={cache} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
