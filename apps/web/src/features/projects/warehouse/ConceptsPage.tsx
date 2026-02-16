import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { BookOpen, RefreshCw } from 'lucide-react'
import { useDataSourceStore } from '@/stores/data-source-store'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConcepts } from './concepts/use-concepts'
import { hasValueColumnForDict } from './concepts/concept-queries'
import { ConceptTable } from './concepts/ConceptTable'
import { ConceptDetail } from './concepts/ConceptDetail'

export function ConceptsPage() {
  const { t } = useTranslation()
  const { uid } = useParams()
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
    resetCache,
  } = useConcepts(mappedSource?.id, mappedSource?.schemaMapping)

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
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div>
          <h1 className="text-lg font-semibold">{t('concepts.title')}</h1>
          <p className="text-xs text-muted-foreground">{t('concepts.description')}</p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={resetCache}>
          <RefreshCw size={12} />
          {t('concepts.cache_reset')}
        </Button>
      </div>

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
          <Allotment.Pane minSize={300} preferredSize={380}>
            <ConceptDetail
              concept={selectedConcept}
              availableColumns={availableColumns}
              stats={conceptStats}
              statsLoading={conceptStatsLoading}
              hasValueColumn={hasValueCol}
            />
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
