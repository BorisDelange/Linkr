import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { queryDataSource, mountFileSourceIntoDuckDB, isFileSourceMounted, fileSourceDataSourceId } from '@/lib/duckdb/engine'
import { useDataSourceStore } from '@/stores/data-source-store'
import {
  buildSourceConceptsQuery,
  buildSourceConceptsCountQuery,
  buildFilterOptionsQuery,
  buildAllConceptCountsQuery,
  buildFileSourceConceptsQuery,
  buildFileSourceConceptsCountQuery,
  buildFileSourceFilterOptionsQuery,
  type SourceConceptFilters,
  type SourceConceptSorting,
} from '@/lib/concept-mapping/mapping-queries'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { SourceConceptTable, type MappingStatusFilter } from './components/SourceConceptTable'
import { TargetConceptPanel } from './components/TargetConceptPanel'
import { ConceptDetailView } from './components/ConceptDetailView'
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
  /** JSON info blob from file import (distribution, granularity, etc.). */
  info_json?: Record<string, unknown>
}

interface MappingEditorTabProps {
  project: MappingProject
  dataSource?: DataSource
  onGoToConceptSets?: () => void
}

const PAGE_SIZE = 50


export function MappingEditorTab({ project, dataSource, onGoToConceptSets }: MappingEditorTabProps) {
  const { t } = useTranslation()
  const { selectedSourceConceptId, setSelectedSourceConcept, mappings, createMapping, deleteMapping, updateMapping, loadOtherProjectsMappedKeys } = useConceptMappingStore()
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  // Load "mapped elsewhere" keys for cross-project detection
  useEffect(() => {
    if (project.workspaceId) loadOtherProjectsMappedKeys(project.id, project.workspaceId)
  }, [project.id, project.workspaceId, loadOtherProjectsMappedKeys])

  const isFileSource = project.sourceType === 'file'

  const [rows, setRows] = useState<SourceConceptRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [filters, setFilters] = useState<SourceConceptFilters>({})
  const [sorting, setSorting] = useState<SourceConceptSorting | null>(
    isFileSource ? { columnId: 'concept_name', desc: false } : { columnId: 'record_count', desc: true },
  )
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  const [mappingStatusFilter, setMappingStatusFilter] = useState<MappingStatusFilter>('all')
  const [countsReady, setCountsReady] = useState(isFileSource)
  const [detailConcept, setDetailConcept] = useState<SourceConceptRow | null>(null)
  const [fileSourceReady, setFileSourceReady] = useState(false)

  const loadingRef = useRef(false)

  // Ignored source concepts: derived from mappings with status='ignored'
  const ignoredConceptIds = useMemo(
    () => new Set(mappings.filter((m) => m.status === 'ignored').map((m) => m.sourceConceptId)),
    [mappings],
  )

  // Cached concept counts: computed once per data source, never recomputed on page/filter change
  const countsCache = useRef<Map<number, { record_count: number; patient_count: number }>>(new Map())
  const countsCacheForDs = useRef<string | null>(null)

  // --- FILE SOURCE: mount into DuckDB ---
  useEffect(() => {
    if (!isFileSource || !project.fileSourceData) return
    let cancelled = false
    const mount = async () => {
      try {
        await mountFileSourceIntoDuckDB(
          project.id,
          project.fileSourceData!.rows,
          project.fileSourceData!.columnMapping,
          project.fileSourceData!.rawFileBuffer,
        )
        if (!cancelled) setFileSourceReady(true)
      } catch (err) {
        console.error('Failed to mount file source into DuckDB:', err)
        if (!cancelled) setQueryError(err instanceof Error ? err.message : String(err))
      }
    }
    mount()
    return () => { cancelled = true }
  }, [isFileSource, project.id, project.fileSourceData])

  // File source: load filter options via DuckDB DISTINCT queries
  useEffect(() => {
    if (!isFileSource || !fileSourceReady) return
    const dsId = fileSourceDataSourceId(project.id)
    const loadOptions = async () => {
      const opts: Record<string, string[]> = {}
      for (const col of ['vocabulary_id', 'terminology_name', 'domain_id', 'concept_class_id', 'category', 'subcategory']) {
        try {
          const sql = buildFileSourceFilterOptionsQuery(col)
          const result = await queryDataSource(dsId, sql)
          const values = result.map((r: Record<string, unknown>) => String(r.val ?? ''))
          if (values.length > 0) opts[col] = values
        } catch {
          // Column might not exist in the table
        }
      }
      setFilterOptions(opts)
    }
    loadOptions()
  }, [isFileSource, fileSourceReady, project.id])

  // --- DATABASE SOURCE ---
  // Load concept counts once per data source
  useEffect(() => {
    if (isFileSource) return
    if (!dataSource?.id || !dataSource.schemaMapping) return
    if (countsCacheForDs.current === dataSource.id) return

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
        countsCacheForDs.current = dataSource.id
        setCountsReady(true)
      }
    }
    loadCounts()
  }, [isFileSource, dataSource?.id, dataSource?.schemaMapping, ensureMounted])

  // Load filter options on mount (database)
  useEffect(() => {
    if (isFileSource) return
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
  }, [isFileSource, dataSource?.id, dataSource?.schemaMapping, ensureMounted])

  // Load source concepts (unified: both file and database mode use DuckDB)
  const loadConcepts = useCallback(async () => {
    if (isFileSource && !fileSourceReady) return
    if (!isFileSource && (!dataSource?.id || !dataSource.schemaMapping)) return
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)

    try {
      setQueryError(null)

      const effectiveDsId = isFileSource ? fileSourceDataSourceId(project.id) : dataSource!.id

      if (!isFileSource) await ensureMounted(dataSource!.id)

      const isSortingByCount = !isFileSource && (sorting?.columnId === 'record_count' || sorting?.columnId === 'patient_count')
      const needAllRows = isSortingByCount || mappingStatusFilter !== 'all'

      // Count
      const countSql = isFileSource
        ? buildFileSourceConceptsCountQuery(filters)
        : buildSourceConceptsCountQuery(dataSource!.schemaMapping!, filters)
      if (!countSql) { setLoading(false); loadingRef.current = false; return }

      const [countResult] = await queryDataSource(effectiveDsId, countSql)
      const total = Number(countResult?.total ?? 0)
      setTotalCount(total)

      // Data
      let dataSql: string
      if (isFileSource) {
        if (needAllRows) {
          dataSql = buildFileSourceConceptsQuery(filters, sorting, total, 0)
        } else {
          dataSql = buildFileSourceConceptsQuery(filters, sorting, PAGE_SIZE, page * PAGE_SIZE)
        }
      } else {
        const mapping = dataSource!.schemaMapping!
        if (needAllRows) {
          dataSql = buildSourceConceptsQuery(mapping, filters, isSortingByCount ? null : sorting, total, 0)
        } else {
          dataSql = buildSourceConceptsQuery(mapping, filters, sorting, PAGE_SIZE, page * PAGE_SIZE)
        }
      }

      const result = await queryDataSource(effectiveDsId, dataSql)

      // Parse info_json strings back to objects for file source
      const parsedRows: SourceConceptRow[] = (result as unknown as SourceConceptRow[]).map((row) => {
        if (isFileSource && row.info_json && typeof row.info_json === 'string') {
          try {
            return { ...row, info_json: JSON.parse(row.info_json as unknown as string) }
          } catch {
            return row
          }
        }
        return row
      })

      setRows(parsedRows)
    } catch (err) {
      console.error('Failed to load source concepts:', err)
      setQueryError(err instanceof Error ? err.message : String(err))
      setRows([])
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [isFileSource, fileSourceReady, dataSource?.id, dataSource?.schemaMapping, filters, sorting, page, mappingStatusFilter, ensureMounted, project.id])

  useEffect(() => {
    loadConcepts()
  }, [loadConcepts])

  // Reset page when filters change
  useEffect(() => {
    setPage(0)
  }, [filters, sorting])

  // --- Validation for database mode ---
  if (!isFileSource) {
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
  }

  // --- Validation for file mode ---
  if (isFileSource && !project.fileSourceData) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('concept_mapping.no_file_data')}</p>
      </div>
    )
  }

  // Merge cached counts into rows (database mode only)
  const rowsWithCounts = isFileSource
    ? rows
    : rows.map((row) => {
        const counts = countsCache.current.get(row.concept_id)
        return {
          ...row,
          record_count: counts?.record_count ?? 0,
          patient_count: counts?.patient_count ?? 0,
        }
      })

  // Sort client-side when sorting by counts (database mode only — file mode sorts via SQL)
  const isSortingByCount = !isFileSource && (sorting?.columnId === 'record_count' || sorting?.columnId === 'patient_count')
  let sortedRows = rowsWithCounts
  if (isSortingByCount && countsReady) {
    const col = sorting!.columnId as 'record_count' | 'patient_count'
    const dir = sorting!.desc ? -1 : 1
    sortedRows = [...rowsWithCounts].sort((a, b) => dir * (a[col] - b[col]))
  }

  // Apply pagination client-side when all rows were loaded (status filter or count sorting)
  const needAllRows = isSortingByCount || mappingStatusFilter !== 'all'
  const paginatedRows = needAllRows
    ? sortedRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    : sortedRows

  // Compute mapping status for each source concept (simplified: mapped or not)
  const mappingStatusMap = new Map<number, 'mapped'>()
  for (const m of mappings) {
    if (m.status !== 'ignored') mappingStatusMap.set(m.sourceConceptId, 'mapped')
  }

  // Build "mapped elsewhere" set: concepts mapped in other projects with same vocab+code
  const otherProjectMappings = useConceptMappingStore((s) => s.otherProjectsMappedKeys)
  const mappedElsewhereIds = useMemo(() => {
    const result = new Set<number>()
    if (!otherProjectMappings || otherProjectMappings.size === 0) return result
    for (const row of rows) {
      if (mappingStatusMap.has(row.concept_id)) continue // already mapped in this project
      const key = `${row.vocabulary_id ?? ''}:${row.concept_code ?? ''}`
      if (otherProjectMappings.has(key)) result.add(row.concept_id)
    }
    return result
  }, [otherProjectMappings, rows, mappingStatusMap])

  // Client-side filtering by mapping status
  const statusFilteredRows = mappingStatusFilter === 'all'
    ? sortedRows
    : sortedRows.filter((row) => {
        const isMapped = mappingStatusMap.has(row.concept_id)
        if (mappingStatusFilter === 'mapped') return isMapped
        if (mappingStatusFilter === 'unmapped') return !isMapped && !ignoredConceptIds.has(row.concept_id) && !mappedElsewhereIds.has(row.concept_id)
        if (mappingStatusFilter === 'mapped_elsewhere') return !isMapped && mappedElsewhereIds.has(row.concept_id)
        return true
      })

  const finalRows = mappingStatusFilter === 'all'
    ? paginatedRows
    : statusFilteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const filteredTotalCount = mappingStatusFilter === 'all'
    ? (isFileSource ? sortedRows.length : totalCount)
    : statusFilteredRows.length

  const selectedRow = (mappingStatusFilter === 'all' ? paginatedRows : finalRows)
    .find((r) => r.concept_id === selectedSourceConceptId)

  // Check if any row has info_json (for showing the chart icon column)
  const hasInfoJson = isFileSource && !!project.fileSourceData?.columnMapping.infoJsonColumn

  return (
    <div className="h-full">
      <Allotment defaultSizes={[55, 45]}>
        <Allotment.Pane minSize={300}>
          {detailConcept ? (
            <ConceptDetailView
              concept={detailConcept}
              onBack={() => setDetailConcept(null)}
            />
          ) : (
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
            conceptDicts={isFileSource ? [] : (dataSource?.schemaMapping?.conceptTables ?? [])}
            mappingStatusMap={mappingStatusMap}
            mappedElsewhereIds={mappedElsewhereIds}
            mappingStatusFilter={mappingStatusFilter}
            selectedConceptId={selectedSourceConceptId}
            isFileSource={isFileSource}
            hasRecordCount={isFileSource && !!project.fileSourceData?.columnMapping.recordCountColumn}
            hasPatientCount={isFileSource && !!project.fileSourceData?.columnMapping.patientCountColumn}
            hasInfoJson={hasInfoJson}
            ignoredConceptIds={ignoredConceptIds}
            onPageChange={setPage}
            onFiltersChange={setFilters}
            onSortingChange={setSorting}
            onMappingStatusFilterChange={setMappingStatusFilter}
            onSelectConcept={setSelectedSourceConcept}
            onShowDetail={setDetailConcept}
          />
          )}
        </Allotment.Pane>
        <Allotment.Pane minSize={300}>
          <TargetConceptPanel
            project={project}
            dataSource={dataSource}
            sourceConcept={selectedRow ?? null}
            ignoredConceptIds={ignoredConceptIds}
            onGoToConceptSets={onGoToConceptSets}
          />
        </Allotment.Pane>
      </Allotment>
    </div>
  )
}
