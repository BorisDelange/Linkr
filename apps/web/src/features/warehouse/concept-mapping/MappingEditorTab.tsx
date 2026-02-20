import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { queryDataSource } from '@/lib/duckdb/engine'
import { useDataSourceStore } from '@/stores/data-source-store'
import {
  buildSourceConceptsQuery,
  buildSourceConceptsCountQuery,
  buildFilterOptionsQuery,
  buildAllConceptCountsQuery,
  type SourceConceptFilters,
  type SourceConceptSorting,
} from '@/lib/concept-mapping/mapping-queries'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { SourceConceptTable, type MappingStatusFilter } from './components/SourceConceptTable'
import { TargetConceptPanel } from './components/TargetConceptPanel'
import type { MappingProject, DataSource } from '@/types'

export interface SourceConceptRow {
  concept_id: number
  concept_name: string
  concept_code?: string
  vocabulary_id?: string
  terminology_name?: string
  category?: string
  subcategory?: string
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
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  const [rows, setRows] = useState<SourceConceptRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [filters, setFilters] = useState<SourceConceptFilters>({})
  const [sorting, setSorting] = useState<SourceConceptSorting | null>({ columnId: 'record_count', desc: true })
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  const [mappingStatusFilter, setMappingStatusFilter] = useState<MappingStatusFilter>('all')
  const [countsReady, setCountsReady] = useState(false)

  const loadingRef = useRef(false)

  // Cached concept counts: computed once per data source, never recomputed on page/filter change
  const countsCache = useRef<Map<number, { record_count: number; patient_count: number }>>(new Map())
  const countsCacheForDs = useRef<string | null>(null)

  // Load concept counts once per data source
  useEffect(() => {
    if (!dataSource?.id || !dataSource.schemaMapping) return
    if (countsCacheForDs.current === dataSource.id) return // already computed

    const loadCounts = async () => {
      try {
        await ensureMounted(dataSource.id)
        const sql = buildAllConceptCountsQuery(dataSource.schemaMapping!)
        if (!sql) {
          countsCacheForDs.current = dataSource.id
          setCountsReady(true)
          return
        }
        const result = await queryDataSource(dataSource.id, sql)
        const map = new Map<number, { record_count: number; patient_count: number }>()
        for (const row of result) {
          map.set(Number(row.concept_id), {
            record_count: Number(row.record_count ?? 0),
            patient_count: Number(row.patient_count ?? 0),
          })
        }
        countsCache.current = map
        countsCacheForDs.current = dataSource.id
        setCountsReady(true)
      } catch (err) {
        console.error('Failed to load concept counts:', err)
        // Still mark as ready so the table shows (without counts)
        countsCacheForDs.current = dataSource.id
        setCountsReady(true)
      }
    }
    loadCounts()
  }, [dataSource?.id, dataSource?.schemaMapping, ensureMounted])

  // Load filter options on mount
  useEffect(() => {
    if (!dataSource?.id || !dataSource.schemaMapping) return
    const mapping = dataSource.schemaMapping

    const loadOptions = async () => {
      await ensureMounted(dataSource.id)
      const opts: Record<string, string[]> = {}
      for (const col of ['vocabulary_id', 'terminology_name', 'category', 'subcategory', 'domain_id', 'concept_class_id']) {
        const sql = buildFilterOptionsQuery(mapping, col)
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
  }, [dataSource?.id, dataSource?.schemaMapping, ensureMounted])

  // Load source concepts (fast — no count computation in SQL)
  const loadConcepts = useCallback(async () => {
    if (!dataSource?.id || !dataSource.schemaMapping || loadingRef.current) return
    loadingRef.current = true
    setLoading(true)

    try {
      setQueryError(null)
      await ensureMounted(dataSource.id)
      const mapping = dataSource.schemaMapping

      // When sorting by record_count/patient_count or filtering by mapping status,
      // we load all concepts and do pagination client-side
      const isSortingByCount = sorting?.columnId === 'record_count' || sorting?.columnId === 'patient_count'
      const needAllRows = isSortingByCount || mappingStatusFilter !== 'all'

      const countSql = buildSourceConceptsCountQuery(mapping, filters)
      if (!countSql) { setLoading(false); loadingRef.current = false; return }

      const [countResult] = await queryDataSource(dataSource.id, countSql)
      const total = Number(countResult?.total ?? 0)
      setTotalCount(total)

      if (needAllRows) {
        // Load all concepts (filtered), pagination done client-side after sort/filter
        const dataSql = buildSourceConceptsQuery(mapping, filters, isSortingByCount ? null : sorting, total, 0)
        const result = await queryDataSource(dataSource.id, dataSql)
        setRows(result as unknown as SourceConceptRow[])
      } else {
        const dataSql = buildSourceConceptsQuery(mapping, filters, sorting, PAGE_SIZE, page * PAGE_SIZE)
        const result = await queryDataSource(dataSource.id, dataSql)
        setRows(result as unknown as SourceConceptRow[])
      }
    } catch (err) {
      console.error('Failed to load source concepts:', err)
      setQueryError(err instanceof Error ? err.message : String(err))
      setRows([])
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [dataSource?.id, dataSource?.schemaMapping, filters, sorting, page, mappingStatusFilter, ensureMounted])

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

  // Merge cached counts into rows
  const rowsWithCounts = rows.map((row) => {
    const counts = countsCache.current.get(row.concept_id)
    return {
      ...row,
      record_count: counts?.record_count ?? 0,
      patient_count: counts?.patient_count ?? 0,
    }
  })

  // Sort client-side when sorting by counts
  const isSortingByCount = sorting?.columnId === 'record_count' || sorting?.columnId === 'patient_count'
  let sortedRows = rowsWithCounts
  if (isSortingByCount && countsReady) {
    const col = sorting!.columnId as 'record_count' | 'patient_count'
    const dir = sorting!.desc ? -1 : 1
    sortedRows = [...rowsWithCounts].sort((a, b) => dir * (a[col] - b[col]))
  }

  // Apply pagination client-side when all rows were loaded (count sorting or status filter)
  const needAllRows = isSortingByCount || mappingStatusFilter !== 'all'
  const paginatedRows = needAllRows
    ? sortedRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    : sortedRows

  // Compute mapping status for each source concept
  const mappingStatusMap = new Map<number, 'unmapped' | 'mapped' | 'approved' | 'flagged' | 'invalid'>()
  for (const m of mappings) {
    const current = mappingStatusMap.get(m.sourceConceptId)
    if (m.status === 'approved') mappingStatusMap.set(m.sourceConceptId, 'approved')
    else if (m.status === 'flagged' && current !== 'approved') mappingStatusMap.set(m.sourceConceptId, 'flagged')
    else if (m.status === 'invalid' && !current) mappingStatusMap.set(m.sourceConceptId, 'invalid')
    else if (!current) mappingStatusMap.set(m.sourceConceptId, 'mapped')
  }

  // Client-side filtering by mapping status — applied BEFORE pagination
  const statusFilteredRows = mappingStatusFilter === 'all'
    ? sortedRows
    : sortedRows.filter((row) => {
        const status = mappingStatusMap.get(row.concept_id)
        if (mappingStatusFilter === 'unmapped') return !status
        if (mappingStatusFilter === 'mapped') return !!status
        return status === mappingStatusFilter
      })

  // Re-paginate after status filter
  const finalRows = mappingStatusFilter === 'all'
    ? paginatedRows
    : statusFilteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const filteredTotalCount = mappingStatusFilter === 'all'
    ? totalCount
    : statusFilteredRows.length

  const selectedRow = (mappingStatusFilter === 'all' ? paginatedRows : finalRows)
    .find((r) => r.concept_id === selectedSourceConceptId)

  return (
    <div className="h-full">
      <Allotment defaultSizes={[55, 45]}>
        <Allotment.Pane minSize={300}>
          <SourceConceptTable
            rows={finalRows}
            totalCount={filteredTotalCount}
            page={page}
            pageSize={PAGE_SIZE}
            loading={loading}
            queryError={queryError}
            filters={filters}
            sorting={sorting}
            filterOptions={filterOptions}
            conceptDicts={dataSource.schemaMapping.conceptTables ?? []}
            mappingStatusMap={mappingStatusMap}
            mappingStatusFilter={mappingStatusFilter}
            selectedConceptId={selectedSourceConceptId}
            onPageChange={setPage}
            onFiltersChange={setFilters}
            onSortingChange={setSorting}
            onMappingStatusFilterChange={setMappingStatusFilter}
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
