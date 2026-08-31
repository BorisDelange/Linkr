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
  Settings,
  ChevronDown,
  Check,
} from 'lucide-react'
import type { VisibilityState } from '@tanstack/react-table'
import { useProjectSource } from '@/stores/data-source-store'
import { DatabaseSelect } from '@/components/ui/database-select'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { columnLabel } from '@/lib/format-helpers'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { useConceptListStore } from '@/stores/concept-list-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { ConceptListModal } from './concepts/ConceptListModal'
import { ConceptListEditDialog } from './concepts/ConceptListEditDialog'
import { ConceptsSettingsDialog } from './concepts/ConceptsSettingsDialog'
import type { ConceptRow } from './concepts/use-concepts'
import type { ConceptList, ConceptListItem } from '@/types'
import { useConcepts } from './concepts/use-concepts'
import { useConceptSetIndex, membershipKey } from './concepts/use-concept-set-index'
import { ImportConceptSetDialog } from '@/features/warehouse/concept-mapping/ImportConceptSetDialog'
import { ConceptSetDetailSheet } from '@/features/warehouse/concept-mapping/ConceptSetDetailSheet'
import { getConceptSetI18n } from '@/lib/concept-mapping/i18n'
import {
  hasValueColumnForDict,
  buildDomainCountQuery,
  buildValueDistributionQuery,
  buildValueHistogramQuery,
  DEFAULT_HIDDEN_COLUMNS,
  CONCEPT_SET_COLUMNS,
} from './concepts/concept-queries'
import { packSetNames, unpackSetNames } from './concepts/concept-set-names'
import { ConceptTable } from './concepts/ConceptTable'
import { ConceptDetail } from './concepts/ConceptDetail'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useConceptsDatabase } from './concepts/use-concepts-database'

// Module-level cache for column visibility (survives unmount/remount)
const columnVisibilityCache = new Map<string, VisibilityState>()

export function ConceptsPage() {
  const { t, i18n } = useTranslation()
  const { wsUid, projectUid: uid } = useResolvedParams()
  const language = useAppStore((s) => s.language)
  const deleteConceptSetsBatch = useConceptMappingStore((s) => s.deleteConceptSetsBatch)
  const [chosenDatabaseId, chooseDatabase] = useConceptsDatabase(uid)
  const mappedSource = useProjectSource(uid, chosenDatabaseId)

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

  const [listOpen, setListOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingList, setEditingList] = useState<ConceptList | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [deletingList, setDeletingList] = useState<ConceptList | null>(null)
  const [importDictOpen, setImportDictOpen] = useState(false)
  /** Sets awaiting removal once a replacement dictionary has been imported. */
  const setsToReplaceRef = useRef<string[]>([])
  const [openSetName, setOpenSetName] = useState<string | null>(null)
  const [selectedConceptIds, setSelectedConceptIds] = useState<Set<number>>(new Set())

  // Saved, project-scoped concept lists.
  const {
    conceptLists,
    loaded: listsLoaded,
    loadConceptLists,
    createConceptList,
    updateConceptList,
    deleteConceptList,
    activeListIdByProject,
    setActiveListId,
  } = useConceptListStore()

  useEffect(() => {
    if (!listsLoaded) loadConceptLists()
  }, [listsLoaded, loadConceptLists])

  const projectLists = useMemo(
    () => (uid ? conceptLists.filter((l) => l.projectUid === uid) : []),
    [conceptLists, uid],
  )
  // Fall back to the first list so the "+" always has a target once one exists.
  const activeListId = uid
    ? (activeListIdByProject[uid] ?? projectLists[0]?.id)
    : undefined
  const activeList = projectLists.find((l) => l.id === activeListId) ?? null

  // The active list's concepts, in the shape the table and copy formats expect.
  const activeListRows = useMemo<ConceptRow[]>(
    () =>
      (activeList?.items ?? []).map((it) => ({
        concept_id: it.conceptId,
        concept_name: it.conceptName ?? '',
        record_count: 0,
        patient_count: 0,
        concept_code: it.conceptCode,
        vocabulary_id: it.vocabularyId,
        _dict_key: it.dictKey,
      })),
    [activeList],
  )

  // "+" adds the multi-selection when there is one, else the single selection.
  const pendingAdditions = useMemo<ConceptRow[]>(() => {
    if (selectedConceptIds.size > 0) {
      return concepts.filter((c) => selectedConceptIds.has(c.concept_id))
    }
    const row = selectedConcept as ConceptRow | null
    return row ? [row] : []
  }, [selectedConceptIds, concepts, selectedConcept])

  const toItem = (c: ConceptRow): ConceptListItem => ({
    conceptId: c.concept_id,
    conceptName: c.concept_name,
    conceptCode: c.concept_code != null ? String(c.concept_code) : undefined,
    vocabularyId: c.vocabulary_id != null ? String(c.vocabulary_id) : undefined,
    dictKey: c._dict_key,
  })

  /** Add the pending concepts to a list, de-duplicated by concept id. */
  const addToList = async (list: ConceptList) => {
    if (pendingAdditions.length === 0) return
    const seen = new Set(list.items.map((i) => i.conceptId))
    const additions = pendingAdditions.filter((c) => !seen.has(c.concept_id)).map(toItem)
    if (additions.length > 0) {
      await updateConceptList(list.id, { items: [...list.items, ...additions] })
    }
    if (uid) setActiveListId(uid, list.id)
    setSelectedConceptIds(new Set())
  }

  /** Create a list, then drop the pending concepts into it. */
  const createListWith = async (
    values: { name: string; description: string },
    seedItems: ConceptListItem[],
  ) => {
    if (!uid) return
    const now = new Date().toISOString()
    const list: ConceptList = {
      id: crypto.randomUUID(),
      projectUid: uid,
      name: setLocalized({}, language, values.name),
      description: setLocalized({}, language, values.description),
      items: seedItems,
      dataSourceId: mappedSource?.id,
      version: '0.1.0',
      createdAt: now,
      updatedAt: now,
    }
    await createConceptList(list)
  }

  const addSelectedToList = async () => {
    if (pendingAdditions.length === 0) return
    // No list yet → the edit dialog opens and the pending concepts seed it.
    if (!activeList) {
      setEditingList(null)
      setEditOpen(true)
      return
    }
    await addToList(activeList)
  }

  // Data dictionaries (concept sets) indexed by (vocabulary_id, concept_code),
  // so rows can show which dictionaries they belong to.
  const {
    index: conceptSetIndex,
    options: conceptSetOptions,
    workspaceSets: workspaceConceptSets,
  } = useConceptSetIndex(mappedSource?.workspaceId, i18n.language)
  // The page holds ONE data dictionary at a time. Its identity is derived from
  // the sets themselves (provenance / sourceRepo) rather than tracked
  // separately, so it stays right even if sets are imported from elsewhere.
  const importedDictionary = useMemo(() => {
    if (workspaceConceptSets.length === 0) return null
    const named = workspaceConceptSets.find((cs) => cs.provenance || cs.sourceRepo)
    const importedAt = workspaceConceptSets.reduce(
      (latest, cs) => (cs.createdAt > latest ? cs.createdAt : latest),
      workspaceConceptSets[0].createdAt,
    )
    return {
      name: named?.provenance ?? named?.sourceRepo ?? t('concepts.dictionary_unnamed'),
      sourceRepo: named?.sourceRepo,
      count: workspaceConceptSets.length,
      importedAt,
    }
  }, [workspaceConceptSets, t])

  /**
   * Replacing means only one dictionary survives — but the old one is dropped
   * *after* the new one lands, never before. Deleting up front left a cancelled
   * or failed import with neither: the sets are workspace-scoped, shared with
   * every mapping project in it, and there is no undo.
   */
  const replaceDictionary = () => {
    // A ref, not state: the dialog fires onImported immediately before closing,
    // and the close handler clears the pending list — through state those two
    // batch together and the removal is lost.
    setsToReplaceRef.current = workspaceConceptSets.map((cs) => cs.id)
    setSettingsOpen(false)
    setImportDictOpen(true)
  }

  /** The import committed, so the dictionary it replaces can now go. */
  const onDictionaryImported = async () => {
    const ids = setsToReplaceRef.current
    setsToReplaceRef.current = []
    if (ids.length > 0) await deleteConceptSetsBatch(ids)
  }

  const openConceptSet = useMemo(
    () =>
      openSetName
        ? workspaceConceptSets.find(
            (cs) => (getConceptSetI18n(cs, i18n.language).name ?? cs.name) === openSetName,
          ) ?? null
        : null,
    [openSetName, workspaceConceptSets, i18n.language],
  )

  /** Filters on the joined dictionary columns, which SQL never saw. */
  const activeConceptSetFilters = useMemo(
    () =>
      CONCEPT_SET_COLUMNS.map((id) => {
        const raw = filters[id]
        const values = Array.isArray(raw) ? raw : raw ? [raw] : []
        return { id, values }
      }).filter((f) => f.values.length > 0),
    [filters],
  )
  const hasConceptSetFilter = activeConceptSetFilters.length > 0

  // Join the dictionary columns onto the page of rows, then apply the filters for
  // those columns here — they have no SQL counterpart, so the server cannot.
  const enrichedConcepts = useMemo<ConceptRow[]>(() => {
    const rows = concepts.map((c) => {
      const membership = conceptSetIndex.get(membershipKey(c.vocabulary_id, c.concept_code))
      if (!membership) return c
      // Categories are plain text in the table, so they stay human-readable.
      // Set NAMES go through packSetNames instead: the cell splits them back
      // into one button each, and a set legitimately called "Labs, chemistry"
      // split on ", " into two phantom buttons that resolved to nothing.
      const uniq = (vals: string[]) => [...new Set(vals.filter(Boolean))].join(', ')
      return {
        ...c,
        concept_set_name: packSetNames(membership.sets.map((s) => s.name)),
        concept_set_category: uniq(membership.sets.map((s) => s.category)),
        concept_set_subcategory: uniq(membership.sets.map((s) => s.subcategory)),
      }
    })

    // A cell lists every set the concept belongs to, so a filter has to match on
    // an INDIVIDUAL value rather than the joined string.
    const active = activeConceptSetFilters
    if (active.length === 0) return rows

    return rows.filter((row) =>
      active.every(({ id, values }) => {
        const cell = String(row[id] ?? '')
        if (!cell) return false
        // Names carry the NUL separator, categories the readable one.
        const parts = id === 'concept_set_name' ? unpackSetNames(cell) : cell.split(', ')
        return values.some((v) => parts.includes(v))
      }),
    )
  }, [concepts, conceptSetIndex, activeConceptSetFilters])

  // Whether the source actually exposes concept codes. MIMIC's d_items/d_labitems
  // have no code column, so the column never appears and copying codes would
  // yield empty strings.
  const hasCodeColumn = useMemo(
    () => availableColumns.some((c) => c.id === 'concept_code'),
    [availableColumns],
  )

  // Same precedence as the table's leading column: vocabulary_id when the source
  // has one, else the dictionary key (MIMIC exposes neither a vocabulary nor a
  // code column, only d_items / d_labitems).
  const terminologyColumn = useMemo<'vocabulary_id' | '_dict_key' | null>(() => {
    if (availableColumns.some((c) => c.id === 'vocabulary_id')) return 'vocabulary_id'
    if (availableColumns.some((c) => c.id === '_dict_key')) return '_dict_key'
    return null
  }, [availableColumns])

  // Dictionary columns get their options from the imported sets, not from SQL.
  // Annotated: conceptSetOptions has literal keys, so the spread would infer an
  // object with only those three and reject the dynamic column ids below.
  const allFilterOptions = useMemo<Record<string, string[]>>(
    () => ({ ...filterOptions, ...conceptSetOptions }),
    [filterOptions, conceptSetOptions],
  )

  const filterableColumns = useMemo(
    () => availableColumns.filter((c) => c.filterable && (allFilterOptions[c.id]?.length ?? 0) > 0),
    [availableColumns, allFilterOptions],
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

  // The statements behind the stats panel, rebuilt for display from the same
  // pure builders the loader calls — never a transcript of what ran (in server
  // mode a shared cache may answer without querying at all), so the dialog says
  // so. `excludeOutliers` is a dependency: it changes the histogram's SQL.
  const statsSql = useMemo<{ titleKey: string; sql: string }[]>(() => {
    const mapping = mappedSource?.schemaMapping
    if (!mapping || selectedConceptId === null) return []
    const row = concepts.find((c) => c.concept_id === selectedConceptId)
    const dictKey = (row?._dict_key as string) ?? mapping.conceptTables?.[0]?.key
    if (!dictKey) return []

    const parts: { titleKey: string; sql: string }[] = []
    const count = buildDomainCountQuery(mapping, dictKey, selectedConceptId)
    if (count) parts.push({ titleKey: 'concepts.stats_sql_count', sql: count })
    if (hasValueColumnForDict(mapping, dictKey)) {
      // Same order as the panel: histogram, then the summary numbers.
      const hist = buildValueHistogramQuery(mapping, dictKey, selectedConceptId, 20, excludeOutliers)
      if (hist) parts.push({ titleKey: 'concepts.stats_sql_histogram', sql: hist })
      const dist = buildValueDistributionQuery(mapping, dictKey, selectedConceptId)
      if (dist) parts.push({ titleKey: 'concepts.stats_sql_distribution', sql: dist })
    }
    return parts
  }, [mappedSource?.schemaMapping, selectedConceptId, concepts, excludeOutliers])

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
          {/* Which database the page reads, ahead of the filters: it decides what
              they even have to filter. */}
          <DatabaseSelect
            workspaceId={wsUid}
            projectUid={uid}
            value={mappedSource?.id}
            onChange={(id) => {
              // The bulk-selection panel lives on the page, outside the hook that
              // resets the rest: left alone it would act on ids from the database
              // we just left.
              setSelectedConceptIds(new Set())
              chooseDatabase(id)
            }}
            size="sm"
            icon
            className="w-44 shrink-0"
          />

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
                      options={(allFilterOptions[col.id] ?? []).map((v) =>
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
              {activeList
                ? t('concepts.add_to_named_list', {
                    name: localized(activeList.name, i18n.language) || t('concepts.list_untitled'),
                    count: pendingAdditions.length,
                  })
                : t('concept_mapping.add_to_list')}
            </TooltipContent>
          </Tooltip>

          {/* Pick a different destination list, or create one, without leaving
              the toolbar. The plain + keeps filling the active list. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="outline"
                className="h-8 w-6 shrink-0 px-0"
                disabled={pendingAdditions.length === 0}
                aria-label={t('concepts.list_choose')}
              >
                <ChevronDown size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[220px]">
              <DropdownMenuLabel className="text-xs">
                {t('concepts.list_add_to')}
              </DropdownMenuLabel>
              {projectLists.map((l) => (
                <DropdownMenuItem
                  key={l.id}
                  className="text-xs"
                  onClick={() => addToList(l)}
                >
                  {l.id === activeListId && <Check size={12} className="mr-1" />}
                  <span className="truncate">
                    {localized(l.name, i18n.language) || t('concepts.list_untitled')}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {l.items.length}
                  </span>
                </DropdownMenuItem>
              ))}
              {projectLists.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                className="text-xs"
                onClick={() => { setEditingList(null); setEditOpen(true) }}
              >
                <Plus size={12} className="mr-1" />
                {t('concepts.list_new')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
                {activeListRows.length > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                    {activeListRows.length}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {t('concept_mapping.view_list')}
            </TooltipContent>
          </Tooltip>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Three groups: search + concept list, then refresh… */}
            <div className="mx-0.5 h-4 w-px bg-border" />
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

            {/* …then the view options. */}
            <div className="mx-0.5 h-4 w-px bg-border" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-8 w-8"
                  onClick={() => setSettingsOpen(true)}
                  aria-label={t('concepts.settings_title')}
                >
                  <Settings size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {t('concepts.settings_title')}
              </TooltipContent>
            </Tooltip>

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
        concepts={activeListRows}
        onRemove={(id) => {
          if (!activeList) return
          updateConceptList(activeList.id, {
            items: activeList.items.filter((i) => i.conceptId !== id),
          })
        }}
        onClear={() => {
          if (activeList) updateConceptList(activeList.id, { items: [] })
        }}
        hasCodeColumn={hasCodeColumn}
        terminologyColumn={terminologyColumn}
        lists={projectLists}
        activeListId={activeListId}
        onSelectList={(listId) => { if (uid) setActiveListId(uid, listId) }}
        onCreateList={() => { setEditingList(null); setEditOpen(true) }}
        onEditList={(l) => { setEditingList(l); setEditOpen(true) }}
        onDeleteList={(l) => setDeletingList(l)}
      />

      {/* Deleting a list is not undoable and can discard a long selection. */}
      <AlertDialog open={!!deletingList} onOpenChange={(o) => { if (!o) setDeletingList(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concepts.list_delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concepts.list_delete_confirm', {
                name: deletingList
                  ? localized(deletingList.name, i18n.language) || t('concepts.list_untitled')
                  : '',
                count: deletingList?.items.length ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deletingList) deleteConceptList(deletingList.id)
                setDeletingList(null)
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConceptListEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        list={editingList}
        onSave={(values) => {
          if (editingList) {
            // Merge into the active language only, so the other translations survive.
            updateConceptList(editingList.id, {
              name: setLocalized(editingList.name, language, values.name),
              description: setLocalized(editingList.description, language, values.description),
            })
            return
          }
          // Creating from the "+" seeds the new list with what was selected.
          createListWith(values, pendingAdditions.map(toItem))
          setSelectedConceptIds(new Set())
        }}
      />

      <ConceptsSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        statsEnabled={statsEnabled}
        onStatsEnabledChange={setStatsEnabled}
        excludeOutliers={excludeOutliers}
        onExcludeOutliersChange={setExcludeOutliers}
        dictionary={importedDictionary}
        onImportDictionary={() => { setsToReplaceRef.current = []; setSettingsOpen(false); setImportDictOpen(true) }}
        onReplaceDictionary={replaceDictionary}
      />

      <ImportConceptSetDialog
        open={importDictOpen}
        onOpenChange={(o) => {
          // Dismissed without importing: the old dictionary stays, so forget
          // the pending removal rather than applying it to the next import.
          // onImported has already consumed the list when the import succeeded.
          if (!o) setsToReplaceRef.current = []
          setImportDictOpen(o)
        }}
        onImported={onDictionaryImported}
        dictionaryMode
      />

      <ConceptSetDetailSheet
        conceptSet={openConceptSet}
        open={!!openConceptSet}
        onOpenChange={(o) => { if (!o) setOpenSetName(null) }}
      />

      {/* Main content: table + detail */}
      <div className="flex-1 overflow-hidden">
        <Allotment>
          <Allotment.Pane minSize={400}>
            <ConceptTable
              concepts={enrichedConcepts}
              totalCount={totalCount}
              clientFiltered={hasConceptSetFilter}
              page={page}
              pageSize={pageSize}
              totalPages={totalPages}
              isLoading={isLoading}
              selectedConceptId={selectedConceptId}
              availableColumns={availableColumns}
              filters={filters}
              filterOptions={allFilterOptions}
              sorting={sorting}
              columnVisibility={columnVisibility}
              onColumnVisibilityChange={setColumnVisibility}
              onFilterChange={updateFilter}
              onSortingChange={updateSorting}
              onSelect={setSelectedConceptId}
              selectedConceptIds={selectedConceptIds}
              onSelectedConceptIdsChange={setSelectedConceptIds}
              onEnter={() => { void addSelectedToList() }}
              onOpenConceptSet={setOpenSetName}
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
                  <Button size="sm-tight" onClick={addSelectedToList}>
                    <Plus size={12} />
                    {t('concept_mapping.add_to_list')}
                  </Button>
                  <Button
                    size="sm-tight"
                    variant="outline"
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
              statsEnabled={statsEnabled}
              statsSql={statsSql}
            />
            )}
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
