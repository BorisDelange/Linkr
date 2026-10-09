import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { queryDataSource, mountFileSourceIntoDuckDB, fileSourceDataSourceId } from '@/lib/duckdb/engine'
import {
  buildFileSourceConceptsQuery,
  buildFileSourceConceptsCountQuery,
  buildFileSourceFilterOptionsQuery,
  type SourceConceptFilters,
  type SourceConceptSorting,
  type FilterOptionsVocabScope,
} from '@/lib/concept-mapping/mapping-queries'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useSuggestionScoresStore } from '@/stores/suggestion-scores-store'
import { useMappingEditorFiltersStore } from '@/stores/mapping-editor-filters-store'
import { getStorage } from '@/lib/storage'
import { hasNativeOmopConceptId } from '@/lib/concept-mapping/mapping-status'
import { localized } from '@/lib/localized'
import { SourceConceptTable, type MappingStatusFilter } from './components/SourceConceptTable'
import { TargetConceptPanel } from './components/TargetConceptPanel'
import { ConceptDetailView } from './components/ConceptDetailView'
import { ClipboardListModal } from './components/ClipboardListModal'
import type { MappingProject, SuggestionCategory } from '@/types'

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
  onGoToConceptSets?: () => void
  onGoToSourceConcepts?: () => void
}

const PAGE_SIZE = 50

/**
 * Map a project's source concepts, read from its flat table only.
 *
 * A database project is never read live: counting records per concept scans
 * every event table, which over a remote warehouse ships whole tables to DuckDB
 * (GitHub discussion #21). Its Source concepts tab extracts the dictionary once,
 * resumably, into the same flat table an imported file gives — until then this
 * tab only points there.
 */
export function MappingEditorTab({ project, onGoToConceptSets, onGoToSourceConcepts }: MappingEditorTabProps) {
  const { t } = useTranslation()
  const { selectedSourceConceptId, setSelectedSourceConcept, mappings, loadOtherProjectsMappedKeys, loadOtherProjectsDetails, importExternalMapping } = useConceptMappingStore()

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
      const badgeLabels = (project.badges ?? []).map((b) => localized(b.label, 'en')).filter(Boolean)
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

  const fileSourceData = project.fileSourceData
  /** The displayed source concept id comes from the badge registry, not the data. */
  const isFileSourceWithoutConceptId = !!fileSourceData && !fileSourceData.columnMapping?.conceptIdColumn

  const [rows, setRows] = useState<SourceConceptRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  // Filters are restored from the editor-filters store so they survive navigating
  // away and back. Read non-reactively: it only seeds the useState initializers
  // below, and re-reading it on later renders must not clobber live edits.
  const savedFilters = useMappingEditorFiltersStore.getState().get(project.id)
  const saveFilterState = useMappingEditorFiltersStore((s) => s.save)

  const [filters, setFilters] = useState<SourceConceptFilters>(() => savedFilters?.filters ?? {})
  const [sorting, setSorting] = useState<SourceConceptSorting | null>(
    // Busiest first when the source carries counts: those are the concepts a
    // mapping project is worked through in.
    savedFilters
      ? savedFilters.sorting
      : fileSourceData?.columnMapping.recordCountColumn
        ? { columnId: 'record_count', desc: true }
        : { columnId: 'concept_name', desc: false },
  )
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  const [mappingStatusFilter, setMappingStatusFilter] = useState<MappingStatusFilter>(
    savedFilters?.mappingStatusFilter ?? 'all',
  )
  const [detailConcept, setDetailConcept] = useState<SourceConceptRow | null>(null)
  const [fileSourceReady, setFileSourceReady] = useState(false)
  const [suggestionCategories, setSuggestionCategories] = useState<Set<SuggestionCategory>>(
    () => new Set(savedFilters?.suggestionCategories ?? []),
  )

  // Multi-selection (Ctrl/Cmd/Shift click) + a persistent "copy list" the user
  // builds up to copy source concepts as SQL/R/Python IN-lists.
  const [selectedConceptIds, setSelectedConceptIds] = useState<Set<number>>(new Set())
  const [clipboardList, setClipboardList] = useState<SourceConceptRow[]>([])
  const [clipboardModalOpen, setClipboardModalOpen] = useState(false)

  // Suggestion scores index: drives the source-side "filter by suggestion" control.
  const scoresIndex = useSuggestionScoresStore((s) => s.index)
  const loadScoresMeta = useSuggestionScoresStore((s) => s.loadProjectMeta)
  const reindexScores = useSuggestionScoresStore((s) => s.reindexProject)
  useEffect(() => { void loadScoresMeta(project.id) }, [project.id, loadScoresMeta])
  const hasScores = scoresIndex?.projectId === project.id && (scoresIndex?.rowCount ?? 0) > 0

  // Indexes written before category filtering carry rows but no category keys.
  // Rebuild once from the persisted parquet so the filter has data to match.
  // Guarded by a per-project ref so a genuinely-empty result can't loop.
  const reindexAttemptedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!scoresIndex || scoresIndex.projectId !== project.id || scoresIndex.rowCount === 0) return
    if (reindexAttemptedRef.current === project.id) return
    const cats = scoresIndex.categorySourceKeys
    const hasAnyCategoryKey = !!cats && Object.values(cats).some((s) => s.size > 0)
    if (!hasAnyCategoryKey) {
      reindexAttemptedRef.current = project.id
      void reindexScores(project.id)
    }
  }, [scoresIndex, project.id, reindexScores])

  // Union of source keys across the selected suggestion categories → SQL filter keys.
  // Store keys use `vocab::code`; the query builder expects `vocab\0code` tuples.
  const suggestionCategoryKeys = useMemo(() => {
    if (suggestionCategories.size === 0 || !scoresIndex || scoresIndex.projectId !== project.id) return null
    const union = new Set<string>()
    for (const cat of suggestionCategories) {
      for (const k of scoresIndex.categorySourceKeys[cat] ?? []) union.add(k)
    }
    return [...union].map((k) => {
      const sep = k.indexOf('::')
      return sep < 0 ? '' : `${k.slice(0, sep)}\0${k.slice(sep + 2)}`
    }).filter((k) => k !== '')
  }, [suggestionCategories, scoresIndex, project.id])
  const suggestionCategoryKeysRef = useRef<string[] | null>(null)
  suggestionCategoryKeysRef.current = suggestionCategoryKeys

  const loadingRef = useRef(false)
  /** Monotonic request id — incremented for each load. Stale completions are ignored. */
  const requestIdRef = useRef(0)
  const savedScrollTop = useRef(0)

  // Persist the user-set filters. The derived key lists (mappedKeys,
  // suggestionCategoryKeys…) are rebuilt from live store state on each load, so
  // only the column filters are kept — persisting the rest would restore stale keys.
  useEffect(() => {
    saveFilterState(project.id, {
      filters: {
        searchText: filters.searchText,
        searchId: filters.searchId,
        searchCode: filters.searchCode,
        searchTextFuzzy: filters.searchTextFuzzy,
        vocabularyId: filters.vocabularyId,
        terminologyName: filters.terminologyName,
        category: filters.category,
        subcategory: filters.subcategory,
        domainId: filters.domainId,
        conceptClassId: filters.conceptClassId,
      },
      sorting,
      mappingStatusFilter,
      suggestionCategories: [...suggestionCategories],
    })
  }, [filters, sorting, mappingStatusFilter, suggestionCategories, project.id, saveFilterState])

  // Refs for the SQL-side mapping-status filter — read inside loadConcepts
  // without making them deps (we don't want every vote to retrigger the query).
  // All keyed by (vocabulary_id, concept_code) via `vocab\0code`.
  const mappingStatusFilterRef = useRef<MappingStatusFilter>('all')
  const otherProjectsMappedKeysRef = useRef<Set<string> | null>(null)
  const projectMappedKeysRef = useRef<Set<string>>(new Set())
  const projectIgnoredKeysRef = useRef<Set<string>>(new Set())
  // Same treatment for the registry-backed source concept id: read at query time
  // so filling the registry does not retrigger a load on its own.
  const sourceConceptIdMapRef = useRef<Map<string, number>>(new Map())
  const isFileSourceWithoutConceptIdRef = useRef(false)

  // Columns actually present in the file source_concepts table (from DESCRIBE), so the
  // vocab re-scope pass never queries a missing column (e.g. subcategory) and triggers a
  // DuckDB Binder Error. Populated by the initial file-source options load.
  const fileSourceColsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!fileSourceData) return
    let cancelled = false
    const mount = async () => {
      try {
        await mountFileSourceIntoDuckDB(
          project.id,
          fileSourceData.rows,
          fileSourceData.columnMapping,
          fileSourceData.rawFileBuffer,
        )
        if (!cancelled) setFileSourceReady(true)
      } catch (err) {
        console.error('Failed to mount file source into DuckDB:', err)
        if (!cancelled) setQueryError(err instanceof Error ? err.message : String(err))
      }
    }
    mount()
    return () => { cancelled = true }
  }, [project.id, fileSourceData])

  // Filter options via DuckDB DISTINCT queries
  useEffect(() => {
    if (!fileSourceReady) return
    const dsId = fileSourceDataSourceId(project.id)
    const loadOptions = async () => {
      // First: get actual columns in the table to avoid querying non-existent columns
      let availableCols: Set<string> = new Set()
      try {
        const colRows = await queryDataSource(dsId, `DESCRIBE source_concepts`)
        availableCols = new Set(colRows.map((r: Record<string, unknown>) => String(r.column_name ?? '')))
        fileSourceColsRef.current = availableCols
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
  }, [fileSourceReady, project.id])

  // Re-scope category/subcategory options to the selected vocabulary. With ~3700
  // categories across all vocabularies, narrowing to the picked vocabulary keeps
  // the filter dropdown small and relevant. Empty selection → full list restored.
  const vocabScopeKey = `${(filters.terminologyName ?? []).join('|')}__${(filters.vocabularyId ?? []).join('|')}`
  useEffect(() => {
    const vocabScope: FilterOptionsVocabScope | undefined =
      (filters.terminologyName?.length ?? 0) > 0
        ? { column: 'terminology_name', values: filters.terminologyName! }
        : (filters.vocabularyId?.length ?? 0) > 0
          ? { column: 'vocabulary_id', values: filters.vocabularyId! }
          : undefined

    let cancelled = false
    const rescope = async () => {
      if (!fileSourceReady) return
      const next: Record<string, string[]> = {}
      const dsId = fileSourceDataSourceId(project.id)
      for (const col of ['category', 'subcategory']) {
        // Skip columns absent from source_concepts — querying one throws a DuckDB Binder Error.
        if (!fileSourceColsRef.current.has(col)) continue
        try {
          const result = await queryDataSource(dsId, buildFileSourceFilterOptionsQuery(col, vocabScope))
          next[col] = result.map((r: Record<string, unknown>) => String(r.val ?? '')).filter(Boolean)
        } catch {
          // column may not exist
        }
      }
      if (cancelled) return
      setFilterOptions((prev) => ({ ...prev, ...next }))
      // Drop selected category/subcategory values that no longer exist in the
      // newly scoped option lists, so stale selections don't silently filter out
      // everything.
      setFilters((prev) => {
        let changed = false
        const patch: Partial<SourceConceptFilters> = {}
        for (const key of ['category', 'subcategory'] as const) {
          const selected = prev[key]
          if (!selected?.length || !next[key]) continue
          const allowed = new Set(next[key])
          const kept = selected.filter((v) => allowed.has(v))
          if (kept.length !== selected.length) {
            patch[key] = kept.length ? kept : undefined
            changed = true
          }
        }
        return changed ? { ...prev, ...patch } : prev
      })
    }
    rescope()
    return () => { cancelled = true }
    // vocabScopeKey captures the selected-vocabulary identity; other deps gate readiness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocabScopeKey, fileSourceReady, project.id])

  const loadConcepts = useCallback(async (pageToLoad: number) => {
    if (!fileSourceReady) return
    // Generate a fresh request id; any prior in-flight load becomes stale.
    const reqId = ++requestIdRef.current
    loadingRef.current = true
    setLoading(true)

    /** Apply state updates only if this request is still the most recent one. */
    const isStale = () => requestIdRef.current !== reqId

    try {
      setQueryError(null)

      const dsId = fileSourceDataSourceId(project.id)

      // Inject mapping-status SQL filter: pass the per-status (vocab, code) key
      // sets so the active filter applies across the full paginated dataset (not
      // just the loaded pages). Read via refs so changes to the underlying
      // mappings don't retrigger loadConcepts on every vote. The cross-project
      // store keys use `vocab:code`; convert to `vocab\0code` for the SQL builder.
      // The id shown for a file project without a conceptIdColumn comes from the
      // badge registry, not from the data, so searching it against `concept_id`
      // never matches — including the value the user just copied off a row.
      // Resolve it to the concepts it identifies and filter on those instead.
      // `__` separates vocabulary from code, and a code may itself contain one,
      // so split on the FIRST occurrence only — the vocabulary never has any.
      const registryIdKeys = isFileSourceWithoutConceptIdRef.current && filters.searchId
        ? Array.from(sourceConceptIdMapRef.current)
            .filter(([, id]) => String(id).startsWith(filters.searchId!))
            .map(([key]) => {
              const sep = key.indexOf('__')
              return sep < 0 ? '' : `${key.slice(0, sep)}\0${key.slice(sep + 2)}`
            })
            .filter((k) => k !== '')
        : undefined

      const filtersWithStatus: SourceConceptFilters = mappingStatusFilterRef.current === 'all'
        ? { ...filters, registryIdKeys }
        : {
            ...filters,
            registryIdKeys,
            mappingStatus: mappingStatusFilterRef.current,
            mappedKeys: Array.from(projectMappedKeysRef.current),
            mappedElsewhereKeys: Array.from(otherProjectsMappedKeysRef.current ?? [])
              .map((k) => {
                const sep = k.indexOf(':')
                return sep < 0 ? '' : `${k.slice(0, sep)}\0${k.slice(sep + 1)}`
              })
              .filter((k) => k !== ''),
            ignoredKeys: Array.from(projectIgnoredKeysRef.current),
          }

      // Suggestion-category filter (source side): a non-null key set means at least
      // one category is selected. Read via ref so it retriggers via the effect below,
      // not by widening loadConcepts' deps.
      if (suggestionCategoryKeysRef.current) {
        filtersWithStatus.hasSuggestionCategoryFilter = true
        filtersWithStatus.suggestionCategoryKeys = suggestionCategoryKeysRef.current
      }

      // Count (only on first page load)
      if (pageToLoad === 0) {
        const [countResult] = await queryDataSource(dsId, buildFileSourceConceptsCountQuery(filtersWithStatus))
        if (isStale()) return
        setTotalCount(Number(countResult?.total ?? 0))
      }

      const dataSql = buildFileSourceConceptsQuery(filtersWithStatus, sorting, PAGE_SIZE, pageToLoad * PAGE_SIZE)
      const result = await queryDataSource(dsId, dataSql)
      if (isStale()) return

      const parsedRows: SourceConceptRow[] = (result as unknown as SourceConceptRow[]).map((row) => {
        if (row.info_json && typeof row.info_json === 'string') {
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

      // Each page replaces the last: the table pages rather than accumulating,
      // so the DOM holds PAGE_SIZE rows however deep into the list you go.
      setRows(parsedRows)
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
  }, [fileSourceReady, filters, sorting, project.id])

  const loadConceptsRef = useRef(loadConcepts)
  loadConceptsRef.current = loadConcepts

  // Single reset+load effect — triggers when anything that should reset the list changes
  useEffect(() => {
    if (!fileSourceReady) return
    // Sync the status filter into its ref before kicking off the load so the
    // SQL builder picks up the latest value.
    mappingStatusFilterRef.current = mappingStatusFilter
    sourceConceptIdMapRef.current = sourceConceptIdMap
    isFileSourceWithoutConceptIdRef.current = isFileSourceWithoutConceptId
    setPage(0)
    setRows([])
    loadConceptsRef.current(0)

    // `sourceConceptIdMap` is a dependency because an id search is resolved
    // through it: the registry loads asynchronously, so a search typed (or
    // restored from saved filters) before it arrived would otherwise stay empty.
  }, [isFileSourceWithoutConceptId, fileSourceReady, filters, sorting, mappingStatusFilter, suggestionCategoryKeys, sourceConceptIdMap])

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  // The fetch is driven from the click, not from an effect on `page`. An effect
  // had to special-case page 0 (the reset effect having just loaded it), and
  // that exception is what left the previous page's rows on screen when the
  // user paged back to the first one.
  const handlePageChange = useCallback((next: number) => {
    if (loading) return
    const clamped = Math.min(Math.max(0, next), totalPages - 1)
    if (clamped === page) return
    setPage(clamped)
    loadConceptsRef.current(clamped)
  }, [loading, totalPages, page])

  // Mapping status is keyed by (vocabulary_id, concept_code) — a source concept's
  // stable identity — not by the row-position concept_id (which shifts if the
  // source CSV is reordered). Build the local mapped/ignored key sets here; the
  // SQL filter (loadConcepts) consumes them via `vocab\0code` keys, and the green
  // dot resolves them against loaded rows below.
  // NOTE: these hooks must stay above the early returns below — calling a hook
  // after a conditional return breaks the Rules of Hooks.
  const conceptKey = (vocab: unknown, code: unknown) => `${vocab ?? ''}\0${code ?? ''}`
  const { projectMappedKeys, projectIgnoredKeys } = useMemo(() => {
    const mapped = new Set<string>()
    const ignored = new Set<string>()
    for (const m of mappings) {
      if (m.projectId !== project.id) continue
      const key = conceptKey(m.sourceVocabularyId, m.sourceConceptCode)
      if (m.status === 'ignored') ignored.add(key)
      else mapped.add(key)
    }
    return { projectMappedKeys: mapped, projectIgnoredKeys: ignored }
  }, [mappings, project.id])
  projectMappedKeysRef.current = projectMappedKeys
  projectIgnoredKeysRef.current = projectIgnoredKeys

  // Resolve the local mapped/ignored keys to concept_ids of currently-loaded rows
  // so the child table can flag the green "mapped" / muted "ignored" dot (child
  // works in concept_id space).
  const mappingStatusMap = useMemo(() => {
    const map = new Map<number, 'mapped'>()
    for (const row of rows) {
      if (projectMappedKeys.has(conceptKey(row.vocabulary_id, row.concept_code))) {
        map.set(row.concept_id, 'mapped')
      }
    }
    return map
  }, [rows, projectMappedKeys])

  const ignoredConceptIds = useMemo(() => {
    const set = new Set<number>()
    for (const row of rows) {
      if (projectIgnoredKeys.has(conceptKey(row.vocabulary_id, row.concept_code))) {
        set.add(row.concept_id)
      }
    }
    return set
  }, [rows, projectIgnoredKeys])

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

  if (!fileSourceData) {
    if (project.sourceType === 'database') {
      return (
        <div className="flex h-full items-center justify-center">
          <EmptyState
            icon={Database}
            title={t('concept_mapping.editor_not_extracted_title')}
            description={t('concept_mapping.editor_not_extracted_description')}
            action={onGoToSourceConcepts && (
              <Button onClick={onGoToSourceConcepts}>
                <Database size={14} />
                {t('concept_mapping.editor_not_extracted_action')}
              </Button>
            )}
          />
        </div>
      )
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('concept_mapping.no_file_data')}</p>
      </div>
    )
  }

  const filteredTotalCount = totalCount

  const selectedRow = rows.find((r) => r.concept_id === selectedSourceConceptId)

  // When more than one source concept is selected, the right-hand mapping panel
  // is meaningless (there's no single source to map) — hand it `null` so it shows
  // its empty prompt, effectively disabling the Exact/Broad mapping buttons.
  const isMultiSelect = selectedConceptIds.size > 1
  const panelSourceConcept = isMultiSelect ? null : (selectedRow ?? null)

  // Add the current multi-selection to the copy list, de-duplicated by concept_id,
  // preserving list order. Resolves each id against the loaded rows. Plain fn (not a
  // hook) so it can live after the validation early-returns above.
  const addSelectionToList = () => {
    setClipboardList((prev) => {
      const existing = new Set(prev.map((r) => r.concept_id))
      const additions = rows.filter((r) => selectedConceptIds.has(r.concept_id) && !existing.has(r.concept_id))
      return additions.length ? [...prev, ...additions] : prev
    })
    setSelectedConceptIds(new Set())
  }

  // Check if any row has info_json (for showing the chart icon column)
  const hasInfoJson = !!fileSourceData.columnMapping.infoJsonColumn

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
            rows={rows}
            totalCount={filteredTotalCount}
            loading={loading}
            queryError={queryError}
            filters={filters}
            sorting={sorting}
            filterOptions={filterOptions}
            mappingStatusMap={mappingStatusMap}
            mappedElsewhereIds={mappedElsewhereIds}
            projectMappings={mappings.filter((m) => m.projectId === project.id)}
            externalMappingsByKey={otherProjectsMappings}
            sourceConceptIdMap={sourceConceptIdMap}
            isFileSourceWithoutConceptId={isFileSourceWithoutConceptId}
            hasNativeOmopConceptId={hasNativeOmopConceptId(project)}
            mappingStatusFilter={mappingStatusFilter}
            selectedConceptId={selectedSourceConceptId}
            selectedConceptIds={selectedConceptIds}
            onSelectedConceptIdsChange={setSelectedConceptIds}
            onAddSelectionToList={addSelectionToList}
            onOpenList={() => setClipboardModalOpen(true)}
            listCount={clipboardList.length}
            hasRecordCount={!!fileSourceData.columnMapping.recordCountColumn}
            hasPatientCount={!!fileSourceData.columnMapping.patientCountColumn}
            hasInfoJson={hasInfoJson}
            ignoredConceptIds={ignoredConceptIds}
            page={page}
            totalPages={totalPages}
            onPageChange={handlePageChange}
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
            suggestionCategories={suggestionCategories}
            onSuggestionCategoriesChange={setSuggestionCategories}
            hasScores={hasScores}
          />
          )}
        </Allotment.Pane>
        <Allotment.Pane minSize={300}>
          <TargetConceptPanel
            project={project}
            sourceConcept={panelSourceConcept}
            ignoredConceptIds={ignoredConceptIds}
            onGoToConceptSets={onGoToConceptSets}
          />
        </Allotment.Pane>
      </Allotment>
      <ClipboardListModal
        open={clipboardModalOpen}
        onOpenChange={setClipboardModalOpen}
        items={clipboardList}
        onRemove={(id) => setClipboardList((prev) => prev.filter((r) => r.concept_id !== id))}
        onClear={() => setClipboardList([])}
      />
    </div>
  )
}
