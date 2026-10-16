import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { labelMatcher } from '@/lib/fuzzy-search'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import { Search, Loader2, Info, ChevronLeft, ChevronRight, Settings2, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedHeader, headerLabel } from '@/components/ui/truncated-header'
import { TruncatedText } from '@/components/ui/truncated-text'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'
import { normalizeConceptFlag } from '@/lib/concept-mapping/concept-flags'
import { ValidityBadge } from '@/lib/concept-mapping/validity-badge'
import { Input } from '@/components/ui/input'
import { NumberInput } from '@/components/ui/number-input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { ColumnResizeHandle, FILTER_INPUT_CLASS, SortIndicator, columnLabel } from '@/components/ui/table-primitives'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildStandardConceptSearchQuery } from '@/lib/concept-mapping/mapping-queries'
import { ATHENA_SCHEMA_MAPPING } from '@/lib/vocabulary-library/schema-mapping'
import { ConceptDetailSheet, type ConceptInfoTarget } from './ConceptDetailSheet'

const BROWSE_PAGE_SIZE = 25
/** Rows fetched per search, mirroring the target search's own cap. */
const BROWSE_MAX_RESULTS = 1000

// Text columns get the shared truncating cell (hover tooltip, copyable); the
// badge column renders itself. Same split as TargetConceptPanel.
const BROWSE_TOOLTIP_COLUMNS = new Set(['vocabulary_id', 'concept_id', 'concept_name', 'concept_code', 'domain_id', 'concept_class_id'])
const BROWSE_MONO_COLUMNS = new Set(['concept_id', 'concept_code'])

/** The trailing Info button column: no header, never sorted, filtered or hidden. */
const INFO_COLUMN_ID = 'info'

interface VocabularyBrowserProps {
  /** The vocabulary database (the workspace library) to search. */
  dataSourceId: string
}

/**
 * Search and browse the concepts of an OHDSI vocabulary database: the ranked
 * search of the Mapping Editor's target panel, server-side filters, inline
 * column filters on the loaded set, and an Info button opening the concept
 * (details, relations, hierarchy, synonyms). Used by a mapping project's
 * Target concepts tab and the workspace Vocabularies page.
 */
function toInfoTarget(row: Record<string, unknown>): ConceptInfoTarget {
  const text = (v: unknown) => (v == null || v === '' ? undefined : String(v))
  return {
    concept_id: Number(row.concept_id),
    concept_name: String(row.concept_name ?? ''),
    concept_code: text(row.concept_code),
    vocabulary_id: text(row.vocabulary_id),
    domain_id: text(row.domain_id),
    concept_class_id: text(row.concept_class_id),
    standard_concept: normalizeConceptFlag(row.standard_concept) || undefined,
    invalid_reason: text(row.invalid_reason),
  }
}

export function VocabularyBrowser({ dataSourceId }: VocabularyBrowserProps) {
  const { t } = useTranslation()
  const vocabDs = useDataSourceStore((s) => s.dataSources.find((d) => d.id === dataSourceId))
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const [infoTarget, setInfoTarget] = useState<ConceptInfoTarget | null>(null)

  // Browse vocabulary state. `browseSearch` is the text typed in the input; `appliedSearch`
  // is the term actually sent to SQL — only updated when the user clicks Search or hits
  // Enter. This avoids running an expensive multi-tier ranked query on every keystroke.
  // Filters are multi-select arrays (empty = no filter), like the Mapping Editor's search.
  const [browseSearch, setBrowseSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [browseVocabs, setBrowseVocabs] = useState<string[]>([])
  const [browseDomains, setBrowseDomains] = useState<string[]>([])
  const [browseClasses, setBrowseClasses] = useState<string[]>([])
  const [browseStandards, setBrowseStandards] = useState<string[]>([])
  const [browseMaxResults, setBrowseMaxResults] = useState(BROWSE_MAX_RESULTS)
  const [browseResults, setBrowseResults] = useState<Record<string, unknown>[]>([])
  // Starts submitted so the table opens on a first page of concepts, exactly as
  // if Enter had been pressed on the empty box.
  const [browseSubmitted, setBrowseSubmitted] = useState(true)
  const [browsePage, setBrowsePage] = useState(0)
  // Warning shown when the user submits a text search with no other filter applied.
  const [searchWarningOpen, setSearchWarningOpen] = useState(false)
  const pendingSearchRef = useRef<string>('')
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseVocabOptions, setBrowseVocabOptions] = useState<string[]>([])
  const [browseDomainOptions, setBrowseDomainOptions] = useState<string[]>([])
  const [browseClassOptions, setBrowseClassOptions] = useState<string[]>([])
  // TanStack column visibility / sizing for the browse-results datatable.
  // The verbose columns are hidden by default, matching TargetConceptPanel.
  const [browseColVisibility, setBrowseColVisibility] = useState<VisibilityState>({ concept_id: false, concept_code: false, valid: false })
  const [browseColSizing, setBrowseColSizing] = useState<Record<string, number>>({})
  const [browseSorting, setBrowseSorting] = useState<{ columnId: string; desc: boolean } | null>(null)
  // Inline column filters applied client-side to the visible page (server-side
  // filters above the search bar narrow the underlying query; these refine
  // within the loaded page, the same way TargetConceptPanel does it).
  const [browseColFilters, setBrowseColFilters] = useState<{
    concept_id?: string
    concept_name?: string
    concept_code?: string
    vocabulary_id?: string[]
    domain_id?: string[]
    concept_class_id?: string[]
    standard_concept?: string
  }>({})

  // Load filter options when vocabulary is connected.
  // We bail out silently if the linked vocabularyDataSource is gone (e.g. workspace was
  // re-imported without re-importing the database files), to avoid spurious console errors.
  useEffect(() => {
    if (!dataSourceId) return
    if (!vocabDs) return
    const load = async () => {
      try {
        await ensureMounted(dataSourceId)
        const vocabs = await queryDataSource(
          dataSourceId,
          `SELECT DISTINCT vocabulary_id AS val FROM concept ORDER BY vocabulary_id`,
        )
        setBrowseVocabOptions(vocabs.map((r) => String(r.val ?? '')).filter(Boolean))
        const domains = await queryDataSource(
          dataSourceId,
          `SELECT DISTINCT domain_id AS val FROM concept ORDER BY domain_id`,
        )
        setBrowseDomainOptions(domains.map((r) => String(r.val ?? '')).filter(Boolean))
        const classes = await queryDataSource(
          dataSourceId,
          `SELECT DISTINCT concept_class_id AS val FROM concept ORDER BY concept_class_id`,
        )
        setBrowseClassOptions(classes.map((r) => String(r.val ?? '')).filter(Boolean))
      } catch (err) {
        console.error('Failed to load vocabulary filter options:', err)
      }
    }
    load()
  }, [dataSourceId, vocabDs, ensureMounted])

  const loadBrowseResults = useCallback(async () => {
    if (!dataSourceId) return
    // Linked vocabulary database was removed (e.g. after a workspace re-import) — skip silently.
    if (!vocabDs) return
    setBrowseLoading(true)
    try {
      await ensureMounted(dataSourceId)

      // Use the same multi-tier ranked search as the Mapping Editor's target panel
      // (exact id match → substring on code/name → Jaro-Winkler ≥ 0.8). Far better
      // relevance than the previous ILIKE-only query.
      const term = appliedSearch.trim()
      const filters = {
        vocabularyIds: browseVocabs.length > 0 ? browseVocabs : undefined,
        domainIds: browseDomains.length > 0 ? browseDomains : undefined,
        conceptClassIds: browseClasses.length > 0 ? browseClasses : undefined,
        standardConcepts: browseStandards.length > 0 ? browseStandards : undefined,
      }

      // One query for up to `browseMaxResults` rows, then page/sort/filter that
      // set client-side — same model as the target search. Paging server-side
      // would be cheaper per query, but the inline column filters could then
      // only ever offer the values present on the current page.
      const sql = buildStandardConceptSearchQuery(ATHENA_SCHEMA_MAPPING, term, filters, browseMaxResults)
      setBrowseResults(sql ? await queryDataSource(dataSourceId, sql) : [])
    } catch (err) {
      console.error('Browse vocabulary query failed:', err)
      setBrowseResults([])
    } finally {
      setBrowseLoading(false)
    }
  }, [dataSourceId, vocabDs, appliedSearch, browseVocabs, browseDomains, browseClasses, browseStandards, browseMaxResults, ensureMounted])

  // Runs on mount with an empty term, then on every submitted search. The empty
  // term takes the builder's cheap `ORDER BY concept_id LIMIT n` branch, not the
  // fuzzy scan, so opening the tab costs one bounded query.
  useEffect(() => {
    if (!dataSourceId) return
    if (!browseSubmitted) return
    loadBrowseResults()
  }, [loadBrowseResults, dataSourceId, browseSubmitted])

  // Picking a filter is itself a search: it narrows the query, so it refreshes
  // the table without making the user hit Enter.
  useEffect(() => {
    if (browseVocabs.length || browseDomains.length || browseClasses.length || browseStandards.length) {
      setBrowseSubmitted(true)
    }
  }, [browseVocabs, browseDomains, browseClasses, browseStandards])

  // Reset page when applied search or filters change
  useEffect(() => {
    setBrowsePage(0)
  }, [appliedSearch, browseVocabs, browseDomains, browseClasses, browseStandards, browseMaxResults])

  /** Submit the search input. If the user typed text without picking any filter, warn
   *  them first (a fully-fuzzy scan over millions of OHDSI concepts can take seconds). */
  const submitSearch = useCallback(() => {
    const term = browseSearch.trim()
    const noFilter =
      browseVocabs.length === 0 &&
      browseDomains.length === 0 &&
      browseClasses.length === 0 &&
      browseStandards.length === 0
    if (term && noFilter) {
      pendingSearchRef.current = term
      setSearchWarningOpen(true)
      return
    }
    setBrowseSubmitted(true)
    setAppliedSearch(term)
  }, [browseSearch, browseVocabs, browseDomains, browseClasses, browseStandards])

  const confirmUnfilteredSearch = useCallback(() => {
    setBrowseSubmitted(true)
    setAppliedSearch(pendingSearchRef.current)
    pendingSearchRef.current = ''
    setSearchWarningOpen(false)
  }, [])


  // ─── OHDSI vocab browse — TanStack column defs (mirrors TargetConceptPanel) ──
  type BrowseRow = Record<string, unknown>
  const browseColumns = useMemo<ColumnDef<BrowseRow>[]>(() => [
    {
      id: 'vocabulary_id',
      header: () => t('concept_mapping.col_vocabulary'),
      accessorFn: (row) => row.vocabulary_id,
      cell: ({ row }) => String(row.original.vocabulary_id ?? ''),
      size: 90,
      minSize: 50,
    },
    {
      id: 'concept_id',
      header: () => t('concept_mapping.col_concept_id'),
      accessorFn: (row) => row.concept_id,
      cell: ({ row }) => <span className="font-mono">{String(row.original.concept_id ?? '')}</span>,
      size: 80,
      minSize: 50,
    },
    {
      id: 'concept_name',
      header: () => t('concept_mapping.col_name'),
      accessorFn: (row) => row.concept_name,
      cell: ({ row }) => String(row.original.concept_name ?? ''),
      size: 220,
      minSize: 100,
    },
    {
      id: 'concept_code',
      header: () => t('concept_mapping.col_concept_code'),
      accessorFn: (row) => row.concept_code,
      cell: ({ row }) => <span className="font-mono">{String(row.original.concept_code ?? '')}</span>,
      size: 90,
      minSize: 50,
    },
    {
      id: 'domain_id',
      header: () => t('concept_mapping.col_domain'),
      accessorFn: (row) => row.domain_id,
      cell: ({ row }) => String(row.original.domain_id ?? ''),
      size: 90,
      minSize: 50,
    },
    {
      id: 'concept_class_id',
      header: () => t('concept_mapping.col_concept_class'),
      accessorFn: (row) => row.concept_class_id,
      cell: ({ row }) => String(row.original.concept_class_id ?? ''),
      size: 100,
      minSize: 50,
    },
    {
      id: 'standard_concept',
      header: () => t('concept_mapping.col_std'),
      accessorFn: (row) => normalizeConceptFlag(row.standard_concept),
      cell: ({ row }) => <StandardConceptBadge value={normalizeConceptFlag(row.original.standard_concept)} />,
      size: 40,
      minSize: 30,
    },
    {
      id: 'valid',
      header: () => t('concept_mapping.col_valid'),
      accessorFn: (row) => row.invalid_reason ?? '',
      cell: ({ row }) => <ValidityBadge value={normalizeConceptFlag(row.original.invalid_reason)} />,
      size: 40,
      minSize: 30,
    },
    {
      id: INFO_COLUMN_ID,
      header: '',
      enableHiding: false,
      enableResizing: false,
      cell: ({ row }) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-primary"
              aria-label={t('concept_mapping.concept_info_btn')}
              onClick={() => setInfoTarget(toInfoTarget(row.original))}
            >
              <Info size={12} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('concept_mapping.concept_info_btn')}</TooltipContent>
        </Tooltip>
      ),
      size: 32,
      minSize: 32,
    },
  ], [t])

  // Distinct values for the inline column filters, taken from the whole loaded
  // result set rather than the visible page — so the dropdowns offer every
  // combination the search returned, not just what page 1 happens to show.
  const browseFilterOptions = useMemo(() => {
    const unique = (key: string) =>
      [...new Set(browseResults.map((r) => String(r[key] ?? '')).filter(Boolean))].sort()
    return {
      vocabulary_id: unique('vocabulary_id'),
      domain_id: unique('domain_id'),
      concept_class_id: unique('concept_class_id'),
    }
  }, [browseResults])

  // Apply inline column filters first, then sort.
  const filteredBrowseResults = useMemo(() => {
    const f = browseColFilters
    const name = labelMatcher(browseResults, (r) => String(r.concept_name ?? ''), f.concept_name)
    return browseResults.filter((r) => {
      if (f.concept_id && !String(r.concept_id ?? '').includes(f.concept_id)) return false
      if (!name(r)) return false
      if (f.concept_code && !String(r.concept_code ?? '').toLowerCase().includes(f.concept_code.toLowerCase())) return false
      if (f.vocabulary_id?.length && !f.vocabulary_id.includes(String(r.vocabulary_id ?? ''))) return false
      if (f.domain_id?.length && !f.domain_id.includes(String(r.domain_id ?? ''))) return false
      if (f.concept_class_id?.length && !f.concept_class_id.includes(String(r.concept_class_id ?? ''))) return false
      if (f.standard_concept && normalizeConceptFlag(r.standard_concept) !== f.standard_concept) return false
      return true
    })
  }, [browseResults, browseColFilters])

  const sortedBrowseResults = useMemo(() => {
    if (!browseSorting) return filteredBrowseResults
    const { columnId, desc } = browseSorting
    const dir = desc ? -1 : 1
    // The validity column is named for what it shows, not for the column it
    // reads — sorting on its own id would compare undefined on every row.
    const field = columnId === 'valid' ? 'invalid_reason' : columnId
    return [...filteredBrowseResults].sort((a, b) => {
      const av = a[field]
      const bv = b[field]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv)
      return dir * String(av).localeCompare(String(bv))
    })
  }, [filteredBrowseResults, browseSorting])

  const browseTotalPages = Math.max(1, Math.ceil(sortedBrowseResults.length / BROWSE_PAGE_SIZE))
  const browsePageItems = sortedBrowseResults.slice(browsePage * BROWSE_PAGE_SIZE, (browsePage + 1) * BROWSE_PAGE_SIZE)

  /** Render the inline filter input for a given column id. */
  const renderBrowseColumnFilter = (columnId: string) => {
    if (columnId === 'vocabulary_id' && browseFilterOptions.vocabulary_id.length > 0) {
      return <MultiSelectFilter
        value={browseColFilters.vocabulary_id ?? []}
        options={browseFilterOptions.vocabulary_id}
        placeholder="Vocab"
        onChange={(v) => setBrowseColFilters((prev) => ({ ...prev, vocabulary_id: v.length ? v : undefined }))}
        triggerClass={FILTER_INPUT_CLASS}
      />
    }
    if (columnId === 'concept_id') {
      return <input className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="ID..." value={browseColFilters.concept_id ?? ''} onChange={(e) => setBrowseColFilters((prev) => ({ ...prev, concept_id: e.target.value || undefined }))} />
    }
    if (columnId === 'concept_name') {
      return <input className={FILTER_INPUT_CLASS} placeholder="..." value={browseColFilters.concept_name ?? ''} onChange={(e) => setBrowseColFilters((prev) => ({ ...prev, concept_name: e.target.value || undefined }))} />
    }
    if (columnId === 'concept_code') {
      return <input className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="Code..." value={browseColFilters.concept_code ?? ''} onChange={(e) => setBrowseColFilters((prev) => ({ ...prev, concept_code: e.target.value || undefined }))} />
    }
    if (columnId === 'domain_id' && browseFilterOptions.domain_id.length > 0) {
      return <MultiSelectFilter
        value={browseColFilters.domain_id ?? []}
        options={browseFilterOptions.domain_id}
        placeholder="Domain"
        onChange={(v) => setBrowseColFilters((prev) => ({ ...prev, domain_id: v.length ? v : undefined }))}
        triggerClass={FILTER_INPUT_CLASS}
      />
    }
    if (columnId === 'concept_class_id' && browseFilterOptions.concept_class_id.length > 0) {
      return <MultiSelectFilter
        value={browseColFilters.concept_class_id ?? []}
        options={browseFilterOptions.concept_class_id}
        placeholder="Class"
        onChange={(v) => setBrowseColFilters((prev) => ({ ...prev, concept_class_id: v.length ? v : undefined }))}
        triggerClass={FILTER_INPUT_CLASS}
      />
    }
    if (columnId === 'standard_concept') {
      return (
        <Select
          value={browseColFilters.standard_concept ?? '__all__'}
          onValueChange={(v) => setBrowseColFilters((prev) => ({ ...prev, standard_concept: v === '__all__' ? undefined : v }))}
        >
          <SelectTrigger className="h-6 w-full overflow-hidden border-dashed text-[10px] font-normal [&>svg]:hidden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('concept_mapping.filter_all')}</SelectItem>
            <SelectItem value="S" className="text-xs">S</SelectItem>
            <SelectItem value="C" className="text-xs">C</SelectItem>
          </SelectContent>
        </Select>
      )
    }
    return null
  }

  const handleBrowseSort = (columnId: string) => {
    if (browseSorting?.columnId === columnId) {
      if (browseSorting.desc) setBrowseSorting({ columnId, desc: false })
      else setBrowseSorting(null)
    } else {
      setBrowseSorting({ columnId, desc: true })
    }
  }

  // TODO(concept-mapping): migrate to DataTable (docs/ui-patterns.md)
  const browseTable = useReactTable({
    data: browsePageItems,
    columns: browseColumns,
    state: { columnVisibility: browseColVisibility, columnSizing: browseColSizing },
    onColumnVisibilityChange: setBrowseColVisibility,
    onColumnSizingChange: setBrowseColSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: browseTotalPages,
  })

  return (
    <>
      <div className="space-y-3">
        {/* Filters popover + Search input + Search button — mirrors the
            Mapping Editor's target-search UI for consistency. */}
        <div className="flex items-center gap-1.5">
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={`h-8 w-8 shrink-0 ${(browseVocabs.length + browseDomains.length + browseClasses.length + browseStandards.length) > 0 ? 'text-primary' : ''}`}
                  >
                    <SlidersHorizontal size={14} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.search_filters')}</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" className="w-[280px] p-3 space-y-3" onCloseAutoFocus={(e) => e.preventDefault()}>
              <p className="text-xs font-medium">{t('concept_mapping.search_filters')}</p>
              {/* Vocabulary */}
              {browseVocabOptions.length > 0 && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_vocabulary')}</label>
                  <MultiSelectFilter
                    value={browseVocabs}
                    options={browseVocabOptions}
                    placeholder={t('concept_mapping.vocab_browse_all_vocabs')}
                    onChange={setBrowseVocabs}
                    popoverWidthClass="w-[220px]"
                    triggerClass={`${FILTER_INPUT_CLASS} justify-between`}
                  />
                </div>
              )}
              {/* Domain */}
              {browseDomainOptions.length > 0 && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_domain')}</label>
                  <MultiSelectFilter
                    value={browseDomains}
                    options={browseDomainOptions}
                    placeholder={t('concept_mapping.vocab_browse_all_domains')}
                    onChange={setBrowseDomains}
                    popoverWidthClass="w-[220px]"
                    triggerClass={`${FILTER_INPUT_CLASS} justify-between`}
                  />
                </div>
              )}
              {/* Concept Class */}
              {browseClassOptions.length > 0 && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_concept_class')}</label>
                  <MultiSelectFilter
                    value={browseClasses}
                    options={browseClassOptions}
                    placeholder={t('concept_mapping.vocab_browse_all_classes')}
                    onChange={setBrowseClasses}
                    popoverWidthClass="w-[220px]"
                    triggerClass={`${FILTER_INPUT_CLASS} justify-between`}
                  />
                </div>
              )}
              {/* Standard concept */}
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_std')}</label>
                <div className="flex gap-1">
                  {(['S', 'C'] as const).map((s) => {
                    const active = browseStandards.includes(s)
                    return (
                      <Button
                        key={s}
                        size="xs"
                        variant={active ? 'default' : 'outline'}
                        className={`h-6 text-[10px] ${active && s === 'S' ? 'bg-green-600 hover:bg-green-700' : ''}`}
                        onClick={() => {
                          setBrowseStandards((prev) => prev.includes(s)
                            ? prev.filter((x) => x !== s)
                            : [...prev, s])
                        }}
                      >
                        {s}
                      </Button>
                    )
                  })}
                </div>
              </div>
              {/* Max results */}
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.search_max_results')}</label>
                <NumberInput
                  className="h-7 text-xs"
                  value={browseMaxResults}
                  min={1}
                  max={100000}
                  onValueChange={setBrowseMaxResults}
                />
                {browseMaxResults > 10000 && (
                  <p className="text-[10px] text-destructive">{t('concept_mapping.search_max_results_warning')}</p>
                )}
              </div>
            </PopoverContent>
          </Popover>
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 pl-8 text-xs"
              placeholder={t('concept_mapping.vocab_browse_search')}
              value={browseSearch}
              onChange={(e) => setBrowseSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // preventDefault stops the keydown from bubbling into the
                  // warning AlertDialog that submitSearch may open — without
                  // this the focused AlertDialogAction immediately receives
                  // the Enter and auto-confirms, closing the dialog.
                  e.preventDefault()
                  submitSearch()
                }
              }}
            />
          </div>
          <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={submitSearch} disabled={browseLoading}>
            {browseLoading ? <Loader2 size={14} className="animate-spin" /> : t('common.search')}
          </Button>
        </div>

        {/* Results table — same TanStack pattern as TargetConceptPanel:
            sortable resizable headers, hidden-by-default verbose columns,
            column-visibility menu in the footer toolbar. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
          <div className="min-h-0 flex-1 overflow-auto">
            {browseLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 size={16} className="animate-spin text-muted-foreground" />
              </div>
            ) : !browseSubmitted ? (
              <div className="flex h-32 items-center justify-center">
                <p className="text-xs text-muted-foreground">{t('concept_mapping.search_hint')}</p>
              </div>
            ) : browseResults.length === 0 ? (
              <div className="flex h-32 items-center justify-center">
                <p className="text-xs text-muted-foreground">{t('common.no_results')}</p>
              </div>
            ) : (
              <Table className="w-full" style={{ tableLayout: 'fixed' }}>
                <TableHeader>
                  <TableRow>
                    {browseTable.getHeaderGroups().map((hg) =>
                      hg.headers.map((header) => {
                        const colId = header.column.id
                        return (
                          <TableHead
                            key={header.id}
                            className="relative select-none overflow-hidden text-xs"
                            style={{ width: header.getSize(), maxWidth: header.getSize() }}
                          >
                            {colId !== INFO_COLUMN_ID && (
                              <>
                                <button
                                  type="button"
                                  className="flex w-full min-w-0 items-center gap-1 overflow-hidden hover:text-foreground"
                                  onClick={() => handleBrowseSort(colId)}
                                >
                                  <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                                    {flexRender(header.column.columnDef.header, header.getContext())}
                                  </TruncatedHeader>
                                  <SortIndicator columnId={colId} sorting={browseSorting} />
                                </button>
                                <ColumnResizeHandle header={header} />
                              </>
                            )}
                          </TableHead>
                        )
                      })
                    )}
                  </TableRow>
                  {/* Inline column filters */}
                  <TableRow className="hover:bg-transparent">
                    {browseTable.getHeaderGroups().map((hg) =>
                      hg.headers.map((header) => (
                        <TableHead
                          key={`filter-${header.id}`}
                          className="px-1 py-1"
                          style={{ width: header.getSize() }}
                        >
                          {renderBrowseColumnFilter(header.column.id)}
                        </TableHead>
                      ))
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {browseTable.getRowModel().rows.map((row) => (
                    <TableRow key={String(row.original.concept_id)}>
                      {row.getVisibleCells().map((cell) => {
                        const raw = cell.getValue()
                        const useTooltip = BROWSE_TOOLTIP_COLUMNS.has(cell.column.id) && raw != null && String(raw) !== ''
                        const rendered = useTooltip
                          ? <TruncatedText text={String(raw)} className={BROWSE_MONO_COLUMNS.has(cell.column.id) ? 'font-mono' : undefined} />
                          : flexRender(cell.column.columnDef.cell, cell.getContext())
                        return (
                          <TableCell
                            key={cell.id}
                            className="overflow-hidden truncate px-2 py-1 text-xs"
                            style={{ maxWidth: cell.column.getSize() }}
                          >
                            {rendered}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          {/* Footer: count + column-visibility toggle + pagination */}
          <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5">
            <div className="flex items-center gap-2">
              {/* The ratio only says something while an inline column
                  filter is hiding rows. */}
              <span className="text-[10px] text-muted-foreground">
                {filteredBrowseResults.length < browseResults.length
                  ? `${filteredBrowseResults.length} / ${browseResults.length}`
                  : browseResults.length}{' '}
                {t('common.results').toLowerCase()}
              </span>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                        <Settings2 size={12} />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">{t('common.columns')}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start" className="w-[200px]">
                  <DropdownMenuLabel className="text-xs">{t('common.columns')}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {browseTable.getAllColumns().filter((col) => col.getCanHide()).map((col) => (
                    <DropdownMenuCheckboxItem
                      key={col.id}
                      checked={col.getIsVisible()}
                      onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                      onSelect={(e) => e.preventDefault()}
                      className="text-xs"
                    >
                      {columnLabel(browseColumns, col.id)}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" disabled={browsePage === 0} onClick={() => setBrowsePage(browsePage - 1)}>
                <ChevronLeft size={14} />
              </Button>
              <span className="text-[10px] text-muted-foreground">
                {browsePage + 1} / {browseTotalPages}
              </span>
              <Button variant="ghost" size="icon-sm" disabled={browsePage >= browseTotalPages - 1} onClick={() => setBrowsePage(browsePage + 1)}>
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Unfiltered-search warning */}
      <AlertDialog open={searchWarningOpen} onOpenChange={setSearchWarningOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.unfiltered_search_warning_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.unfiltered_search_warning_desc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmUnfilteredSearch}>{t('concept_mapping.unfiltered_search_warning_proceed')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConceptDetailSheet
        target={infoTarget}
        open={infoTarget !== null}
        onOpenChange={(open) => { if (!open) setInfoTarget(null) }}
        dataSourceId={dataSourceId}
        conceptTable="concept"
      />
    </>
  )
}
