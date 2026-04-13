import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
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
import { ConceptDetailView } from './components/ConceptDetailView'
import type { MappingProject, DataSource, FileColumnMapping } from '@/types'

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

/** Convert file rows to SourceConceptRow[] using column mapping. */
function fileRowsToSourceRows(
  rows: Record<string, unknown>[],
  mapping: FileColumnMapping,
): SourceConceptRow[] {
  return rows.map((row, index) => {
    const conceptId = mapping.conceptIdColumn
      ? Number(row[mapping.conceptIdColumn]) || index + 1
      : index + 1
    const conceptName = mapping.conceptNameColumn
      ? String(row[mapping.conceptNameColumn] ?? '')
      : ''
    const conceptCode = mapping.conceptCodeColumn
      ? String(row[mapping.conceptCodeColumn] ?? '')
      : ''

    let infoJson: Record<string, unknown> | undefined
    if (mapping.infoJsonColumn && row[mapping.infoJsonColumn]) {
      try {
        const raw = row[mapping.infoJsonColumn]
        infoJson = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
      } catch {
        // Invalid JSON, ignore
      }
    }

    return {
      concept_id: conceptId,
      concept_name: conceptName,
      concept_code: conceptCode,
      vocabulary_id: mapping.terminologyColumn ? String(row[mapping.terminologyColumn] ?? '') : undefined,
      terminology_name: mapping.terminologyColumn ? String(row[mapping.terminologyColumn] ?? '') : undefined,
      domain_id: mapping.domainColumn ? String(row[mapping.domainColumn] ?? '') : undefined,
      concept_class_id: mapping.conceptClassColumn ? String(row[mapping.conceptClassColumn] ?? '') : undefined,
      category: mapping.categoryColumn ? String(row[mapping.categoryColumn] ?? '') : undefined,
      subcategory: mapping.subcategoryColumn ? String(row[mapping.subcategoryColumn] ?? '') : undefined,
      record_count: mapping.recordCountColumn ? (Number(row[mapping.recordCountColumn]) || 0) : 0,
      patient_count: mapping.patientCountColumn ? (Number(row[mapping.patientCountColumn]) || 0) : 0,
      info_json: infoJson,
    }
  })
}

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

  const loadingRef = useRef(false)

  // Ignored source concepts: derived from mappings with status='ignored'
  const ignoredConceptIds = useMemo(
    () => new Set(mappings.filter((m) => m.status === 'ignored').map((m) => m.sourceConceptId)),
    [mappings],
  )

  // Cached concept counts: computed once per data source, never recomputed on page/filter change
  const countsCache = useRef<Map<number, { record_count: number; patient_count: number }>>(new Map())
  const countsCacheForDs = useRef<string | null>(null)

  // --- FILE SOURCE: convert file data to rows ---
  const allFileRows = useMemo(() => {
    if (!isFileSource || !project.fileSourceData) return []
    return fileRowsToSourceRows(project.fileSourceData.rows, project.fileSourceData.columnMapping)
  }, [isFileSource, project.fileSourceData])

  // File source: compute filter options from data
  useEffect(() => {
    if (!isFileSource || allFileRows.length === 0) return
    const opts: Record<string, string[]> = {}
    const sets: Record<string, Set<string>> = {}
    for (const row of allFileRows) {
      for (const col of ['vocabulary_id', 'terminology_name', 'domain_id', 'concept_class_id'] as const) {
        const val = row[col]
        if (val) {
          if (!sets[col]) sets[col] = new Set()
          sets[col].add(String(val))
        }
      }
    }
    for (const [col, set] of Object.entries(sets)) {
      opts[col] = [...set].sort()
    }
    setFilterOptions(opts)
  }, [isFileSource, allFileRows])

  // File source: apply filters + sorting + pagination client-side
  useEffect(() => {
    if (!isFileSource) return
    let filtered = allFileRows

    // Apply text filters
    if (filters.searchText) {
      const q = filters.searchText.toLowerCase()
      filtered = filtered.filter((r) =>
        r.concept_name.toLowerCase().includes(q) ||
        (r.concept_code && r.concept_code.toLowerCase().includes(q)),
      )
    }
    if (filters.searchId) {
      const q = filters.searchId
      filtered = filtered.filter((r) => String(r.concept_id).includes(q))
    }
    if (filters.searchCode) {
      const q = filters.searchCode.toLowerCase()
      filtered = filtered.filter((r) => r.concept_code?.toLowerCase().includes(q))
    }
    if (filters.vocabularyId) {
      filtered = filtered.filter((r) => r.vocabulary_id === filters.vocabularyId)
    }
    if (filters.terminologyName) {
      filtered = filtered.filter((r) => r.terminology_name === filters.terminologyName)
    }
    if (filters.domainId) {
      filtered = filtered.filter((r) => r.domain_id === filters.domainId)
    }
    if (filters.conceptClassId) {
      filtered = filtered.filter((r) => r.concept_class_id === filters.conceptClassId)
    }

    setTotalCount(filtered.length)
    setRows(filtered)
    setLoading(false)
  }, [isFileSource, allFileRows, filters])

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

  // Load source concepts (database mode)
  const loadConcepts = useCallback(async () => {
    if (isFileSource) return
    if (!dataSource?.id || !dataSource.schemaMapping || loadingRef.current) return
    loadingRef.current = true
    setLoading(true)

    try {
      setQueryError(null)
      await ensureMounted(dataSource.id)
      const mapping = dataSource.schemaMapping

      const isSortingByCount = sorting?.columnId === 'record_count' || sorting?.columnId === 'patient_count'
      const needAllRows = isSortingByCount || mappingStatusFilter !== 'all'

      const countSql = buildSourceConceptsCountQuery(mapping, filters)
      if (!countSql) { setLoading(false); loadingRef.current = false; return }

      const [countResult] = await queryDataSource(dataSource.id, countSql)
      const total = Number(countResult?.total ?? 0)
      setTotalCount(total)

      if (needAllRows) {
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
  }, [isFileSource, dataSource?.id, dataSource?.schemaMapping, filters, sorting, page, mappingStatusFilter, ensureMounted])

  useEffect(() => {
    if (!isFileSource) loadConcepts()
  }, [loadConcepts, isFileSource])

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

  // Sort client-side when sorting by counts (database) or always for file
  const isSortingByCount = sorting?.columnId === 'record_count' || sorting?.columnId === 'patient_count'
  let sortedRows = rowsWithCounts
  if (isFileSource && sorting) {
    const col = sorting.columnId as keyof SourceConceptRow
    const dir = sorting.desc ? -1 : 1
    sortedRows = [...rowsWithCounts].sort((a, b) => {
      const va = a[col] ?? ''
      const vb = b[col] ?? ''
      if (typeof va === 'number' && typeof vb === 'number') return dir * (va - vb)
      return dir * String(va).localeCompare(String(vb))
    })
  } else if (isSortingByCount && countsReady) {
    const col = sorting!.columnId as 'record_count' | 'patient_count'
    const dir = sorting!.desc ? -1 : 1
    sortedRows = [...rowsWithCounts].sort((a, b) => dir * (a[col] - b[col]))
  }

  // Apply pagination client-side when all rows were loaded
  const needAllRows = isFileSource || isSortingByCount || mappingStatusFilter !== 'all'
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
    const allRows = isFileSource ? allFileRows : rows
    for (const row of allRows) {
      if (mappingStatusMap.has(row.concept_id)) continue // already mapped in this project
      const key = `${row.vocabulary_id ?? ''}:${row.concept_code ?? ''}`
      if (otherProjectMappings.has(key)) result.add(row.concept_id)
    }
    return result
  }, [otherProjectMappings, isFileSource, allFileRows, rows, mappingStatusMap])

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
  const hasInfoJson = isFileSource && allFileRows.some((r) => r.info_json)

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
