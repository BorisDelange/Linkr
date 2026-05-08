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
import { getStorage } from '@/lib/storage'
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
const EMPTY_CONCEPT_DICTS: import('@/types/schema-mapping').ConceptDictionary[] = []


export function MappingEditorTab({ project, dataSource, onGoToConceptSets }: MappingEditorTabProps) {
  const { t } = useTranslation()
  const { selectedSourceConceptId, setSelectedSourceConcept, mappings, createMapping, deleteMapping, updateMapping, loadOtherProjectsMappedKeys, loadOtherProjectsDetails, importExternalMapping } = useConceptMappingStore()
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  // Load cross-project data in two passes: the cheap key Set first (used by the
  // dot's "mapped elsewhere" badge), then the full detail Map (used by the
  // popover and the bulk-import modal) after the page has painted.
  useEffect(() => {
    if (!project.workspaceId) return
    loadOtherProjectsMappedKeys(project.id, project.workspaceId)
    const timer = setTimeout(() => {
      if (project.workspaceId) loadOtherProjectsDetails(project.id, project.workspaceId)
    }, 500)
    return () => clearTimeout(timer)
  }, [project.id, project.workspaceId, loadOtherProjectsMappedKeys, loadOtherProjectsDetails])

  // Source-concept-id registry: resolve `(vocabulary, code) → assigned id` from the project's badges.
  // When the same key exists under multiple badges, the FIRST badge in the project's badge list wins.
  const [sourceConceptIdMap, setSourceConceptIdMap] = useState<Map<string, number>>(new Map())
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const wsId = project.workspaceId
      const badgeLabels = (project.badges ?? []).map((b) => b.label).filter(Boolean)
      if (!wsId || badgeLabels.length === 0) {
        if (!cancelled) setSourceConceptIdMap(new Map())
        return
      }
      const storage = getStorage()
      const map = new Map<string, number>()
      // Iterate badges in declared order so the first one wins on conflict.
      for (const label of badgeLabels) {
        const entries = await storage.sourceConceptIdEntries.getByWorkspaceAndBadge(wsId, label)
        for (const e of entries) {
          const key = `${e.vocabularyId}__${e.conceptCode}`
          if (!map.has(key)) map.set(key, e.sourceConceptId)
        }
      }
      if (!cancelled) setSourceConceptIdMap(map)
    }
    load()
    return () => { cancelled = true }
  }, [project.workspaceId, project.badges])

  const isFileSource = project.sourceType === 'file'

  const [rows, setRows] = useState<SourceConceptRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [filters, setFilters] = useState<SourceConceptFilters>({})
  const [sorting, setSorting] = useState<SourceConceptSorting | null>(
    isFileSource ? { columnId: 'concept_name', desc: false } : { columnId: 'record_count', desc: true },
  )
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  const [mappingStatusFilter, setMappingStatusFilter] = useState<MappingStatusFilter>('all')
  const [detailConcept, setDetailConcept] = useState<SourceConceptRow | null>(null)
  const [fileSourceReady, setFileSourceReady] = useState(false)

  const loadingRef = useRef(false)
  /** Monotonic request id — incremented for each load. Stale completions are ignored. */
  const requestIdRef = useRef(0)
  const savedScrollTop = useRef(0)

  // Ignored source concepts: derived from mappings with status='ignored'
  const ignoredConceptIds = useMemo(
    () => new Set(mappings.filter((m) => m.status === 'ignored').map((m) => m.sourceConceptId)),
    [mappings],
  )
  // Refs for the SQL-side mapping-status filter — read inside loadConcepts
  // without making them deps (we don't want every vote to retrigger the query).
  const mappingStatusFilterRef = useRef<MappingStatusFilter>('all')
  const mappingStatusMapRef = useRef<Map<number, 'mapped'>>(new Map())
  const otherProjectsMappedKeysRef = useRef<Set<string> | null>(null)
  const ignoredConceptIdsRef = useRef<Set<number>>(new Set())
  ignoredConceptIdsRef.current = ignoredConceptIds

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
      // First: get actual columns in the table to avoid querying non-existent columns
      let availableCols: Set<string> = new Set()
      try {
        const colRows = await queryDataSource(dsId, `DESCRIBE source_concepts`)
        availableCols = new Set(colRows.map((r: Record<string, unknown>) => String(r.column_name ?? '')))
      } catch {
        return
      }
      const opts: Record<string, string[]> = {}
      for (const col of ['vocabulary_id', 'terminology_name', 'domain_id', 'concept_class_id', 'category', 'subcategory']) {
        if (!availableCols.has(col)) continue
        try {
          const sql = buildFileSourceFilterOptionsQuery(col)
          const result = await queryDataSource(dsId, sql)
          const values = result.map((r: Record<string, unknown>) => String(r.val ?? ''))
          if (values.length > 0) opts[col] = values
        } catch {
          // ignore
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
      } catch (err) {
        console.error('Failed to load concept counts:', err)
        countsCacheForDs.current = dataSource.id
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
  const loadConcepts = useCallback(async (pageToLoad: number) => {
    if (isFileSource && !fileSourceReady) return
    if (!isFileSource && (!dataSource?.id || !dataSource.schemaMapping)) return
    // Generate a fresh request id; any prior in-flight load becomes stale.
    const reqId = ++requestIdRef.current
    loadingRef.current = true
    setLoading(true)

    /** Apply state updates only if this request is still the most recent one. */
    const isStale = () => requestIdRef.current !== reqId

    try {
      setQueryError(null)

      const effectiveDsId = isFileSource ? fileSourceDataSourceId(project.id) : dataSource!.id

      if (!isFileSource) await ensureMounted(dataSource!.id)

      // Inject mapping-status SQL filter: pass the per-status id sets so the
      // active filter applies across the full paginated dataset (not just the
      // loaded pages). Read via refs so changes to the underlying mappings
      // don't retrigger loadConcepts on every vote.
      // For "mapped_elsewhere" we send (vocab, code) keys — the local concept_id
      // version of the set is paginated (computed only over loaded rows) and
      // would under-filter, so we use the canonical cross-project keyset
      // instead, which lives in the store and covers the full project. The
      // store keys use `vocab:code`; convert to `vocab\0code` for the SQL builder.
      const filtersWithStatus: SourceConceptFilters = mappingStatusFilterRef.current === 'all'
        ? filters
        : {
            ...filters,
            mappingStatus: mappingStatusFilterRef.current,
            mappedConceptIds: Array.from(mappingStatusMapRef.current.keys()),
            mappedElsewhereKeys: Array.from(otherProjectsMappedKeysRef.current ?? [])
              .map((k) => {
                const sep = k.indexOf(':')
                return sep < 0 ? '' : `${k.slice(0, sep)}\0${k.slice(sep + 1)}`
              })
              .filter((k) => k !== ''),
            ignoredConceptIds: Array.from(ignoredConceptIdsRef.current),
          }

      // Count (only on first page load)
      if (pageToLoad === 0) {
        const countSql = isFileSource
          ? buildFileSourceConceptsCountQuery(filtersWithStatus)
          : buildSourceConceptsCountQuery(dataSource!.schemaMapping!, filtersWithStatus)
        if (!countSql) {
          if (!isStale()) { setLoading(false); loadingRef.current = false }
          return
        }
        const [countResult] = await queryDataSource(effectiveDsId, countSql)
        if (isStale()) return
        const total = Number(countResult?.total ?? 0)
        setTotalCount(total)
      }

      // Data — always paginated (count sorting is handled SQL-side via JOIN)
      const dataSql = isFileSource
        ? buildFileSourceConceptsQuery(filtersWithStatus, sorting, PAGE_SIZE, pageToLoad * PAGE_SIZE)
        : buildSourceConceptsQuery(dataSource!.schemaMapping!, filtersWithStatus, sorting, PAGE_SIZE, pageToLoad * PAGE_SIZE)

      const result = await queryDataSource(effectiveDsId, dataSql)
      if (isStale()) return

      // Parse info_json strings back to objects for file source
      const parsedRows: SourceConceptRow[] = (result as unknown as SourceConceptRow[]).map((row) => {
        if (isFileSource && row.info_json && typeof row.info_json === 'string') {
          try {
            const parsed = JSON.parse(row.info_json as unknown as string)
            const isObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            return { ...row, info_json: isObj ? parsed : undefined }
          } catch {
            return { ...row, info_json: undefined }
          }
        }
        return row
      })

      setRows((prev) => pageToLoad === 0 ? parsedRows : [...prev, ...parsedRows])
      setHasMore(parsedRows.length === PAGE_SIZE)
    } catch (err) {
      if (isStale()) return
      console.error('Failed to load source concepts:', err)
      setQueryError(err instanceof Error ? err.message : String(err))
      if (pageToLoad === 0) setRows([])
    } finally {
      // Only the most recent request controls the loading flag.
      if (!isStale()) {
        setLoading(false)
        loadingRef.current = false
      }
    }
  }, [isFileSource, fileSourceReady, dataSource?.id, dataSource?.schemaMapping, filters, sorting, ensureMounted, project.id])

  const loadConceptsRef = useRef(loadConcepts)
  loadConceptsRef.current = loadConcepts

  // Single reset+load effect — triggers when anything that should reset the list changes
  useEffect(() => {
    if (isFileSource && !fileSourceReady) return
    // Sync the status filter into its ref before kicking off the load so the
    // SQL builder picks up the latest value.
    mappingStatusFilterRef.current = mappingStatusFilter
    setPage(0)
    setRows([])
    setHasMore(false)
    loadConceptsRef.current(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFileSource, fileSourceReady, dataSource?.id, dataSource?.schemaMapping, filters, sorting, mappingStatusFilter])

  // Load more when page increments (scroll infinite)
  useEffect(() => {
    if (page === 0) return
    loadConceptsRef.current(page)
  }, [page])

  const handleLoadMore = useCallback(() => {
    if (loading || !hasMore) return
    setPage((p) => p + 1)
  }, [loading, hasMore])

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

  // Merge cached counts into rows (database mode only, when NOT sorting by counts —
  // when sorting by counts the SQL query already JOINs counts)
  const isSortingByCount = !isFileSource && (sorting?.columnId === 'record_count' || sorting?.columnId === 'patient_count')
  const finalRows = isFileSource || isSortingByCount
    ? rows
    : rows.map((row) => {
        const counts = countsCache.current.get(row.concept_id)
        return {
          ...row,
          record_count: counts?.record_count ?? 0,
          patient_count: counts?.patient_count ?? 0,
        }
      })

  // Compute mapping status for each source concept (simplified: mapped or not).
  // Filter to the current project so foreign mappings (loaded for cross-project
  // detection) don't contaminate the local "mapped" set.
  const mappingStatusMap = useMemo(() => {
    const map = new Map<number, 'mapped'>()
    for (const m of mappings) {
      if (m.projectId !== project.id) continue
      if (m.status !== 'ignored') map.set(m.sourceConceptId, 'mapped')
    }
    return map
  }, [mappings, project.id])
  mappingStatusMapRef.current = mappingStatusMap

  // Build "mapped elsewhere" set: concepts mapped in other projects with same vocab+code
  const otherProjectMappings = useConceptMappingStore((s) => s.otherProjectsMappedKeys)
  const otherProjectsMappings = useConceptMappingStore((s) => s.otherProjectsMappings)
  otherProjectsMappedKeysRef.current = otherProjectMappings ?? null
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

  const filteredTotalCount = totalCount

  const selectedRow = finalRows.find((r) => r.concept_id === selectedSourceConceptId)

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
            hasMore={hasMore}
            loading={loading}
            queryError={queryError}
            filters={filters}
            sorting={sorting}
            filterOptions={filterOptions}
            conceptDicts={isFileSource ? EMPTY_CONCEPT_DICTS : (dataSource?.schemaMapping?.conceptTables ?? EMPTY_CONCEPT_DICTS)}
            mappingStatusMap={mappingStatusMap}
            mappedElsewhereIds={mappedElsewhereIds}
            projectMappings={mappings.filter((m) => m.projectId === project.id)}
            externalMappingsByKey={otherProjectsMappings}
            sourceConceptIdMap={sourceConceptIdMap}
            isFileSourceWithoutConceptId={isFileSource && !project.fileSourceData?.columnMapping?.conceptIdColumn}
            mappingStatusFilter={mappingStatusFilter}
            selectedConceptId={selectedSourceConceptId}
            isFileSource={isFileSource}
            hasRecordCount={isFileSource && !!project.fileSourceData?.columnMapping.recordCountColumn}
            hasPatientCount={isFileSource && !!project.fileSourceData?.columnMapping.patientCountColumn}
            hasInfoJson={hasInfoJson}
            ignoredConceptIds={ignoredConceptIds}
            onLoadMore={handleLoadMore}
            onFiltersChange={setFilters}
            onSortingChange={setSorting}
            onMappingStatusFilterChange={setMappingStatusFilter}
            onSelectConcept={setSelectedSourceConcept}
            onShowDetail={setDetailConcept}
            initialScrollTop={savedScrollTop.current}
            onScrollTopChange={(v) => { savedScrollTop.current = v }}
            onImportExternal={async (info, localSourceConceptId) => {
              await importExternalMapping(info, project.id, { sourceConceptId: localSourceConceptId })
            }}
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
