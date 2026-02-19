import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  buildSourceConceptsQuery,
  buildSourceConceptsCountQuery,
  buildFilterOptionsQuery,
  type SourceConceptFilters,
  type SourceConceptSorting,
} from '@/lib/concept-mapping/mapping-queries'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { SourceConceptTable } from './components/SourceConceptTable'
import { TargetConceptPanel } from './components/TargetConceptPanel'
import type { MappingProject, DataSource } from '@/types'

export interface SourceConceptRow {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  standard_concept?: string
  record_count: number
  patient_count: number
}

interface MappingEditorTabProps {
  project: MappingProject
  dataSource?: DataSource
}

const PAGE_SIZE = 50

export function MappingEditorTab({ project, dataSource }: MappingEditorTabProps) {
  const { t } = useTranslation()
  const { selectedSourceConceptId, setSelectedSourceConcept, mappings } = useConceptMappingStore()

  const [rows, setRows] = useState<SourceConceptRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [filters, setFilters] = useState<SourceConceptFilters>({})
  const [sorting, setSorting] = useState<SourceConceptSorting | null>({ columnId: 'record_count', desc: true })
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})

  const loadingRef = useRef(false)

  // Load filter options on mount
  useEffect(() => {
    if (!dataSource?.id || !dataSource.schemaMapping) return
    const mapping = dataSource.schemaMapping

    const loadOptions = async () => {
      const opts: Record<string, string[]> = {}
      for (const col of ['vocabulary_id', 'domain_id', 'concept_class_id']) {
        const sql = buildFilterOptionsQuery(dataSource.id, mapping, col)
        if (!sql) continue
        try {
          const result = await queryDataSource(dataSource.id, sql)
          opts[col] = result.map((r: Record<string, unknown>) => String(r.val ?? ''))
        } catch {
          // Column might not exist
        }
      }
      setFilterOptions(opts)
    }
    loadOptions()
  }, [dataSource?.id, dataSource?.schemaMapping])

  // Load source concepts
  const loadConcepts = useCallback(async () => {
    if (!dataSource?.id || !dataSource.schemaMapping || loadingRef.current) return
    loadingRef.current = true
    setLoading(true)

    try {
      setQueryError(null)
      const mapping = dataSource.schemaMapping
      const countSql = buildSourceConceptsCountQuery(dataSource.id, mapping, filters)
      if (!countSql) { setLoading(false); loadingRef.current = false; return }

      const [countResult] = await queryDataSource(dataSource.id, countSql)
      setTotalCount(Number(countResult?.total ?? 0))

      const dataSql = buildSourceConceptsQuery(
        dataSource.id, mapping, filters, sorting, PAGE_SIZE, page * PAGE_SIZE,
      )
      const result = await queryDataSource(dataSource.id, dataSql)
      setRows(result as unknown as SourceConceptRow[])
    } catch (err) {
      console.error('Failed to load source concepts:', err)
      setQueryError(err instanceof Error ? err.message : String(err))
      setRows([])
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [dataSource?.id, dataSource?.schemaMapping, filters, sorting, page])

  useEffect(() => {
    loadConcepts()
  }, [loadConcepts])

  // Reset page when filters change
  useEffect(() => {
    setPage(0)
  }, [filters, sorting])

  if (!dataSource) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('concept_mapping.no_datasource')}</p>
      </div>
    )
  }

  if (!dataSource.schemaMapping) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('concept_mapping.no_schema')}</p>
      </div>
    )
  }

  if (!dataSource.schemaMapping.conceptTables?.length) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('concept_mapping.no_concept_tables')}</p>
      </div>
    )
  }

  // Compute mapping status for each source concept
  const mappingStatusMap = new Map<number, 'unmapped' | 'mapped' | 'approved' | 'flagged' | 'invalid'>()
  for (const m of mappings) {
    const current = mappingStatusMap.get(m.sourceConceptId)
    if (m.status === 'approved') mappingStatusMap.set(m.sourceConceptId, 'approved')
    else if (m.status === 'flagged' && current !== 'approved') mappingStatusMap.set(m.sourceConceptId, 'flagged')
    else if (m.status === 'invalid' && !current) mappingStatusMap.set(m.sourceConceptId, 'invalid')
    else if (!current) mappingStatusMap.set(m.sourceConceptId, 'mapped')
  }

  const selectedRow = rows.find((r) => r.concept_id === selectedSourceConceptId)

  return (
    <div className="h-full">
      <Allotment defaultSizes={[55, 45]}>
        <Allotment.Pane minSize={300}>
          <SourceConceptTable
            rows={rows}
            totalCount={totalCount}
            page={page}
            pageSize={PAGE_SIZE}
            loading={loading}
            queryError={queryError}
            filters={filters}
            sorting={sorting}
            filterOptions={filterOptions}
            mappingStatusMap={mappingStatusMap}
            selectedConceptId={selectedSourceConceptId}
            onPageChange={setPage}
            onFiltersChange={setFilters}
            onSortingChange={setSorting}
            onSelectConcept={setSelectedSourceConcept}
          />
        </Allotment.Pane>
        <Allotment.Pane minSize={300}>
          <TargetConceptPanel
            project={project}
            dataSource={dataSource}
            sourceConcept={selectedRow ?? null}
          />
        </Allotment.Pane>
      </Allotment>
    </div>
  )
}
