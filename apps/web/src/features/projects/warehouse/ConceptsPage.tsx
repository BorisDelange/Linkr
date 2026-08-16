import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  BookOpen,
  RefreshCw,
  PanelRight,
  SlidersHorizontal,
  Search,
  X,
  Plus,
  List,
} from 'lucide-react'
import type { VisibilityState } from '@tanstack/react-table'
import { useDataSourceStore } from '@/stores/data-source-store'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { columnLabel } from '@/lib/format-helpers'
import { ConceptListModal } from './concepts/ConceptListModal'
import type { ConceptRow } from './concepts/use-concepts'
import { useConcepts } from './concepts/use-concepts'
import { hasValueColumnForDict, DEFAULT_HIDDEN_COLUMNS } from './concepts/concept-queries'
import { ConceptTable } from './concepts/ConceptTable'
import { ConceptDetail } from './concepts/ConceptDetail'
import { useResolvedParams } from '@/hooks/use-resolved-params'

// Module-level cache for column visibility (survives unmount/remount)
const columnVisibilityCache = new Map<string, VisibilityState>()

export function ConceptsPage() {
  const { t, i18n } = useTranslation()
  const { projectUid: uid } = useResolvedParams()
  const { getActiveSource } = useDataSourceStore()
  const mappedSource = uid ? getActiveSource(uid) : undefined

  const {
    hasConceptTable,
    availableColumns,
    filters,
    updateFilter,
    sorting,
    updateSorting,
    page,
    setPage,
    pageSize,
    setPageSize,
    concepts,
    totalCount,
    totalPages,
    isLoading,
    filterOptions,
    selectedConceptId,
    setSelectedConceptId,
    selectedConcept,
    conceptStats,
    conceptStatsLoading,
    refresh,
    lastRefreshed,
    countsRefreshing,
    refreshError,
    needsRefresh,
    statsEnabled,
    setStatsEnabled,
    excludeOutliers,
    setExcludeOutliers,
  } = useConcepts(mappedSource?.id, mappedSource?.schemaMapping)

  const [detailVisible, setDetailVisible] = useState(true)

  // Toolbar search: typed locally, committed on Enter / the Search button so a
  // fuzzy scan over the whole dictionary doesn't fire on every keystroke.
  const [pendingSearch, setPendingSearch] = useState('')
  const commitSearch = () => updateFilter('_searchFuzzy', pendingSearch.trim() || null)
  const clearSearch = () => {
    setPendingSearch('')
    if (filters._searchFuzzy) updateFilter('_searchFuzzy', null)
  }

  // Concept list — a scratch list the user builds while browsing, mirroring the
  // mapping editor's clipboard list.
  const [conceptList, setConceptList] = useState<ConceptRow[]>([])
  const [listOpen, setListOpen] = useState(false)
  const [selectedConceptIds, setSelectedConceptIds] = useState<Set<number>>(new Set())

  // "+" adds the multi-selection when there is one, else the single selection.
  const pendingAdditions = useMemo<ConceptRow[]>(() => {
    if (selectedConceptIds.size > 0) {
      return concepts.filter((c) => selectedConceptIds.has(c.concept_id))
    }
    const row = selectedConcept as ConceptRow | null
    return row ? [row] : []
  }, [selectedConceptIds, concepts, selectedConcept])

  const addSelectedToList = () => {
    if (pendingAdditions.length === 0) return
    setConceptList((prev) => {
      const seen = new Set(prev.map((c) => c.concept_id))
      const additions = pendingAdditions.filter((c) => !seen.has(c.concept_id))
      return additions.length ? [...prev, ...additions] : prev
    })
    setSelectedConceptIds(new Set())
  }

  const filterableColumns = useMemo(
    () => availableColumns.filter((c) => c.filterable && (filterOptions[c.id]?.length ?? 0) > 0),
    [availableColumns, filterOptions],
  )
  const selectedFilterValues = (columnId: string) => {
    const raw = filters[columnId]
    return Array.isArray(raw) ? raw : raw ? [raw] : []
  }
  const standardOptionLabel = (value: string) =>
    value === 'S' ? t('concepts.standard_s')
      : value === 'C' ? t('concepts.standard_c')
        : t('concepts.standard_non')
  const activeFilterCount = filterableColumns.reduce(
    (n, col) => n + (selectedFilterValues(col.id).length > 0 ? 1 : 0),
    0,
  )

  const sourceId = mappedSource?.id
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () =>
      (sourceId ? columnVisibilityCache.get(sourceId) : undefined) ??
      Object.fromEntries(DEFAULT_HIDDEN_COLUMNS.map((id) => [id, false])),
  )

  // Persist column visibility on unmount
  const colVisRef = useRef(columnVisibility)
  useEffect(() => {
    colVisRef.current = columnVisibility
  })
  useEffect(() => {
    return () => {
      if (sourceId) columnVisibilityCache.set(sourceId, colVisRef.current)
    }

  }, [sourceId])

  // Compute hasValueColumn for the selected concept's dict
  const hasValueCol = useMemo(() => {
    if (!mappedSource?.schemaMapping || selectedConceptId === null) return false
    const row = concepts.find((c) => c.concept_id === selectedConceptId)
    const dictKey = (row?._dict_key as string) ?? mappedSource.schemaMapping.conceptTables?.[0]?.key
    if (!dictKey) return false
    return hasValueColumnForDict(mappedSource.schemaMapping, dictKey)
  }, [mappedSource?.schemaMapping, selectedConceptId, concepts])

  // No data source
  if (!mappedSource) {
    return (
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <h1 className="text-2xl font-bold text-foreground">{t('concepts.title')}</h1>
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <BookOpen size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('concepts.no_data_source')}
              </p>
              <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
                {t('concepts.no_data_source_description')}
              </p>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  // Concept table not found
  if (hasConceptTable === false) {
    return (
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <h1 className="text-2xl font-bold text-foreground">{t('concepts.title')}</h1>
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <BookOpen size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('concepts.no_concept_table')}
              </p>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  // Still checking
  if (hasConceptTable === null) {
    return null
  }

  return (
    <div className="flex h-full flex-col">
      {/* Slim action bar. No title/description: the sidebar already names the
          page, so they only cost vertical space. */}
      <TooltipProvider delayDuration={300}>
        <div className="flex items-center gap-1.5 border-b px-3 py-2">
          {/* Filters popover — the column dropdowns, gathered in one place like
              the mapping editor's source-concepts toolbar. */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={`h-8 w-8 shrink-0 ${activeFilterCount > 0 ? 'text-primary' : ''}`}
                  >
                    <SlidersHorizontal size={14} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{t('common.filters')}</TooltipContent>
            </Tooltip>
            <PopoverContent
              align="start"
              className="w-[280px] space-y-3 p-3"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              {filterableColumns.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('concepts.no_filters')}</p>
              ) : (
                filterableColumns.map((col) => (
                  <div key={col.id} className="space-y-1">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {columnLabel(col.id)}
                    </p>
                    <MultiSelectFilter
                      value={selectedFilterValues(col.id)}
                      options={(filterOptions[col.id] ?? []).map((v) =>
                        col.id === 'standard_concept'
                          ? { value: v, label: standardOptionLabel(v) }
                          : v,
                      )}
                      placeholder={columnLabel(col.id)}
                      onChange={(next) => updateFilter(col.id, next.length ? next : null)}
                      triggerClass="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
                      popoverWidthClass="w-[300px]"
                    />
                  </div>
                ))
              )}
            </PopoverContent>
          </Popover>

          {/* Fuzzy search — commits on Enter or the Search button, like the
              mapping editor (a keystroke-debounced query over 1.5M rows would
              fire a full fuzzy scan per character). */}
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 pl-8 pr-7 text-xs"
              value={pendingSearch}
              onChange={(e) => setPendingSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitSearch() }
                else if (e.key === 'Escape') { e.preventDefault(); clearSearch() }
              }}
              placeholder={t('concepts.search_concepts')}
            />
            {pendingSearch && (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={t('common.clear')}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={commitSearch}>
            {t('common.search')}
          </Button>

          {/* Concept list: add the selected concept, then open the list. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="outline"
                className="h-8 w-8 shrink-0"
                disabled={pendingAdditions.length === 0}
                onClick={addSelectedToList}
                aria-label={t('concept_mapping.add_to_list')}
              >
                <Plus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {pendingAdditions.length > 1
                ? t('concept_mapping.add_to_list_count', { count: pendingAdditions.length })
                : t('concept_mapping.add_to_list')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="outline"
                className="relative h-8 w-8 shrink-0"
                onClick={() => setListOpen(true)}
                aria-label={t('concept_mapping.view_list')}
              >
                <List size={14} />
                {conceptList.length > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                    {conceptList.length}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {t('concept_mapping.view_list')}
            </TooltipContent>
          </Tooltip>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={statsEnabled}
                onCheckedChange={(v) => setStatsEnabled(v === true)}
                className="size-3.5"
              />
              {t('etl.profiling_compute_stats')}
            </label>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={detailVisible ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  className="h-8 w-8"
                  onClick={() => setDetailVisible(!detailVisible)}
                >
                  <PanelRight size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {t('etl.profiling_toggle_stats')}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1 text-xs"
                  onClick={refresh}
                  disabled={countsRefreshing}
                >
                  <RefreshCw size={12} className={countsRefreshing ? 'animate-spin' : ''} />
                  {t('concepts.refresh')}
                </Button>
              </TooltipTrigger>
              {lastRefreshed && (
                <TooltipContent side="bottom" className="text-xs">
                  {t('concepts.last_refreshed', {
                    date: new Date(lastRefreshed).toLocaleString(i18n.language, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }),
                  })}
                </TooltipContent>
              )}
            </Tooltip>
          </div>
        </div>
      </TooltipProvider>

      {/* No cache yet (server mode): prompt to build it. */}
      {needsRefresh && !refreshError && (
        <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2">
          <span className="text-xs text-muted-foreground">
            {countsRefreshing ? t('concepts.building_cache') : t('concepts.cache_empty')}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 text-xs"
            onClick={refresh}
            disabled={countsRefreshing}
          >
            <RefreshCw size={12} className={countsRefreshing ? 'animate-spin' : ''} />
            {t('concepts.build_cache')}
          </Button>
        </div>
      )}

      {/* A failed build used to be silent (console only) — surface it so the
          button never looks like it did nothing. */}
      {refreshError && (
        <div className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2">
          <span className="text-xs text-destructive">
            {t('concepts.build_cache_failed', { error: refreshError })}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 text-xs"
            onClick={refresh}
            disabled={countsRefreshing}
          >
            <RefreshCw size={12} className={countsRefreshing ? 'animate-spin' : ''} />
            {t('concepts.retry')}
          </Button>
        </div>
      )}

      <ConceptListModal
        open={listOpen}
        onOpenChange={setListOpen}
        concepts={conceptList}
        onRemove={(id) => setConceptList((prev) => prev.filter((c) => c.concept_id !== id))}
        onClear={() => setConceptList([])}
      />

      {/* Main content: table + detail */}
      <div className="flex-1 overflow-hidden">
        <Allotment>
          <Allotment.Pane minSize={400}>
            <ConceptTable
              concepts={concepts}
              totalCount={totalCount}
              page={page}
              pageSize={pageSize}
              totalPages={totalPages}
              isLoading={isLoading}
              selectedConceptId={selectedConceptId}
              availableColumns={availableColumns}
              filters={filters}
              filterOptions={filterOptions}
              sorting={sorting}
              columnVisibility={columnVisibility}
              onColumnVisibilityChange={setColumnVisibility}
              onFilterChange={updateFilter}
              onSortingChange={updateSorting}
              onSelect={setSelectedConceptId}
              selectedConceptIds={selectedConceptIds}
              onSelectedConceptIdsChange={setSelectedConceptIds}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size)
                setPage(0)
              }}
            />
          </Allotment.Pane>
          <Allotment.Pane minSize={300} preferredSize={380} visible={detailVisible}>
            {selectedConceptIds.size > 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-sm font-medium">
                  {t('concepts.selected_count', { count: selectedConceptIds.size })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('concepts.selected_hint')}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" className="h-7 gap-1 text-xs" onClick={addSelectedToList}>
                    <Plus size={12} />
                    {t('concept_mapping.add_to_list')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setSelectedConceptIds(new Set())}
                  >
                    {t('common.clear')}
                  </Button>
                </div>
              </div>
            ) : (
            <ConceptDetail
              concept={selectedConcept}
              availableColumns={availableColumns}
              stats={conceptStats}
              statsLoading={conceptStatsLoading}
              hasValueColumn={hasValueCol}
              excludeOutliers={excludeOutliers}
              onExcludeOutliersChange={setExcludeOutliers}
              statsEnabled={statsEnabled}
            />
            )}
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
