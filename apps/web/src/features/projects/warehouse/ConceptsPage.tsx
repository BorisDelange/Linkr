import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { BookOpen, RefreshCw, PanelRight } from 'lucide-react'
import type { VisibilityState } from '@tanstack/react-table'
import { useDataSourceStore } from '@/stores/data-source-store'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useConcepts } from './concepts/use-concepts'
import { hasValueColumnForDict } from './concepts/concept-queries'
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

  const sourceId = mappedSource?.id
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => (sourceId ? columnVisibilityCache.get(sourceId) : undefined) ?? {},
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
      <div className="flex items-center justify-between gap-3 border-b px-4 py-1.5">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 text-xs"
            onClick={refresh}
            disabled={countsRefreshing}
          >
            <RefreshCw size={12} className={countsRefreshing ? 'animate-spin' : ''} />
            {t('concepts.refresh')}
          </Button>
          {lastRefreshed && (
            <span className="text-xs text-muted-foreground">
              {t('concepts.last_refreshed', {
                date: new Date(lastRefreshed).toLocaleString(i18n.language, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </span>
          )}
        </div>

        <TooltipProvider delayDuration={300}>
          <div className="flex items-center gap-2">
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
                  size="icon-xs"
                  onClick={() => setDetailVisible(!detailVisible)}
                >
                  <PanelRight size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.profiling_toggle_stats')}</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>

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
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size)
                setPage(0)
              }}
            />
          </Allotment.Pane>
          <Allotment.Pane minSize={300} preferredSize={380} visible={detailVisible}>
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
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
