import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  Plus, BookOpen, Trash2, Search, Loader2,
  Info, Check, CheckCheck, X, CheckCircle2, ChevronLeft, ChevronRight, Pencil, SquareX,
  Settings2, SlidersHorizontal,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNavigate } from 'react-router'
import { paths } from '@/lib/paths'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedHeader, headerLabel } from '@/components/ui/truncated-header'
import { TruncatedText } from '@/components/ui/truncated-text'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'
import { normalizeConceptFlag } from '@/lib/concept-mapping/concept-flags'
import { ValidityBadge } from '@/lib/concept-mapping/validity-badge'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { NumberInput } from '@/components/ui/number-input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { PickConceptSetsDialog } from './PickConceptSetsDialog'
import { ConceptSetDetailSheet } from './ConceptSetDetailSheet'
import type { MappingProject, DataSource, ConceptSet, DatabaseConnectionConfig } from '@/types'
import { getConceptSetI18n } from '@/lib/concept-mapping/i18n'
import { localized } from '@/lib/localized'
import { buildStandardConceptSearchQuery } from '@/lib/concept-mapping/mapping-queries'
import { ATHENA_SCHEMA_MAPPING } from '@/lib/vocabulary-library/schema-mapping'
import { vocabularyDataSourceIdFor } from '@/lib/vocabulary-library/resolve'

const BROWSE_PAGE_SIZE = 25
/** Rows fetched per search, mirroring the target search's own cap. */
const BROWSE_MAX_RESULTS = 1000

// Text columns get the shared truncating cell (hover tooltip, copyable); the
// badge column renders itself. Same split as TargetConceptPanel.
const BROWSE_TOOLTIP_COLUMNS = new Set(['vocabulary_id', 'concept_id', 'concept_name', 'concept_code', 'domain_id', 'concept_class_id'])
const BROWSE_MONO_COLUMNS = new Set(['concept_id', 'concept_code'])

interface CsSorting {
  columnId: string
  desc: boolean
}

/** Translated row for the concept sets table. */
interface CsRow {
  id: string
  category: string
  subcategory: string
  name: string
  description: string
  items: number
  version: string
  provenance: string
  /** Distinct source concepts mapped onto this concept set. */
  mappedCount: number
  /** Names of those source concepts (for the hover tooltip). */
  mappedSources: string[]
  /** 'none' = no source concept mapped, 'mapped' = at least one. */
  mappedStatus: 'none' | 'mapped'
  raw: ConceptSet
}

interface ConceptSetsTabProps {
  project: MappingProject
  dataSource?: DataSource
}

export function ConceptSetsTab({ project }: ConceptSetsTabProps) {
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('concept-mapping:write')
  const lang = i18n.language
  const { conceptSets, mappings, updateMappingProject } = useConceptMappingStore()

  const [importOpen, setImportOpen] = useState(false)

  // Detail sheet
  const [detailConceptSet, setDetailConceptSet] = useState<ConceptSet | null>(null)

  // Bulk selection (edit mode)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  const navigate = useNavigate()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

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

  // Inline column filters
  const [filterCategory, setFilterCategory] = useState('')
  const [filterSubcategory, setFilterSubcategory] = useState('')
  const [filterName, setFilterName] = useState('')
  const [filterVersion, setFilterVersion] = useState('')
  const [filterProvenance, setFilterProvenance] = useState('')
  // '' = all, 'none' = no source concept mapped, 'mapped' = at least one
  const [filterStatus, setFilterStatus] = useState('')

  // TanStack table state
  const [csSorting, setCsSorting] = useState<CsSorting | null>(null)
  const [csColVisibility, setCsColVisibility] = useState<VisibilityState>({})
  const [csColSizing, setCsColSizing] = useState<Record<string, number>>({})

  // Pagination
  const CS_PAGE_SIZE = 25
  const [csPage, setCsPage] = useState(0)

  const linkedSets = conceptSets.filter((cs) => (project.conceptSetIds ?? []).includes(cs.id))

  // Fuzzy match: all query characters appear in order in the target
  const fuzzyMatch = (target: string, query: string): boolean => {
    let qi = 0
    for (let ti = 0; ti < target.length && qi < query.length; ti++) {
      if (target[ti] === query[qi]) qi++
    }
    return qi === query.length
  }

  const textMatch = (text: string, query: string): boolean =>
    text.includes(query) || fuzzyMatch(text, query)

  // Unique dropdown options for category, subcategory, provenance
  const categoryOptions = useMemo(() => [...new Set(linkedSets.map((cs) => getConceptSetI18n(cs, lang).category).filter(Boolean) as string[])].sort(), [linkedSets, lang])
  const subcategoryOptions = useMemo(() => [...new Set(linkedSets.map((cs) => getConceptSetI18n(cs, lang).subcategory).filter(Boolean) as string[])].sort(), [linkedSets, lang])
  const provenanceOptions = useMemo(() => [...new Set(linkedSets.map((cs) => cs.provenance).filter(Boolean) as string[])].sort(), [linkedSets])

  // Distinct source concepts mapped onto each concept set. A source counts when
  // one of its mappings targets a concept in the set (resolved ids if available,
  // else the expression items) with a real status — exclude rejected/invalid/
  // ignored/suggested, which are not actual alignments.
  const mappedByCsId = useMemo(() => {
    const REAL: ReadonlySet<string> = new Set(['unchecked', 'approved', 'flagged'])
    const realMappings = mappings.filter((m) => m.projectId === project.id && REAL.has(m.status) && m.targetConceptId > 0)
    const byCs = new Map<string, { count: number; sources: string[] }>()
    for (const cs of linkedSets) {
      const targetIds = new Set<number>(
        cs.resolvedConceptIds && cs.resolvedConceptIds.length > 0
          ? cs.resolvedConceptIds
          : cs.expression.items.map((it) => it.concept.conceptId),
      )
      const seen = new Set<number>()
      const sources: string[] = []
      for (const m of realMappings) {
        if (targetIds.has(m.targetConceptId) && !seen.has(m.sourceConceptId)) {
          seen.add(m.sourceConceptId)
          sources.push(`${m.sourceVocabularyId} - ${m.sourceConceptCode} - ${m.sourceConceptName}`)
        }
      }
      byCs.set(cs.id, { count: sources.length, sources })
    }
    return byCs
  }, [mappings, linkedSets, project.id])

  // Build translated rows for the table
  const csRows = useMemo<CsRow[]>(() => {
    return linkedSets.map((cs) => {
      const tr = getConceptSetI18n(cs, lang)
      const mapped = mappedByCsId.get(cs.id) ?? { count: 0, sources: [] }
      return {
        id: cs.id,
        category: tr.category ?? '',
        subcategory: tr.subcategory ?? '',
        name: tr.name,
        description: tr.description ?? '',
        items: cs.expression.items.length,
        version: cs.version ?? '',
        provenance: cs.provenance ?? '',
        mappedCount: mapped.count,
        mappedSources: mapped.sources,
        mappedStatus: mapped.count > 0 ? 'mapped' : 'none',
        raw: cs,
      }
    })

  }, [linkedSets, lang, mappedByCsId])

  // Apply inline column filters
  const filteredRows = useMemo(() => {
    return csRows.filter((r) => {
      if (filterCategory && r.category !== filterCategory) return false
      if (filterSubcategory && r.subcategory !== filterSubcategory) return false
      if (filterName && !textMatch(r.name.toLowerCase(), filterName.toLowerCase())) return false
      if (filterVersion && !r.version.toLowerCase().includes(filterVersion.toLowerCase())) return false
      if (filterProvenance && r.provenance !== filterProvenance) return false
      if (filterStatus && r.mappedStatus !== filterStatus) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csRows, filterCategory, filterSubcategory, filterName, filterVersion, filterProvenance, filterStatus])

  // Also keep filteredSets for backward compat with selection mode
  const filteredSets = useMemo(() => {
    return linkedSets.filter((cs) => filteredRows.some((r) => r.id === cs.id))
  }, [linkedSets, filteredRows])

  // Apply sorting
  const sortedRows = useMemo(() => {
    if (!csSorting) return filteredRows
    const col = csSorting.columnId as keyof CsRow
    const dir = csSorting.desc ? -1 : 1
    return [...filteredRows].sort((a, b) => {
      const va = a[col] ?? ''
      const vb = b[col] ?? ''
      if (typeof va === 'number' && typeof vb === 'number') return dir * (va - vb)
      return dir * String(va).localeCompare(String(vb))
    })
  }, [filteredRows, csSorting])

  // Reset page when filters change
  const prevFiltersRef = useRef({ filterCategory, filterSubcategory, filterName, filterVersion, filterProvenance, filterStatus })
  if (
    prevFiltersRef.current.filterCategory !== filterCategory ||
    prevFiltersRef.current.filterSubcategory !== filterSubcategory ||
    prevFiltersRef.current.filterName !== filterName ||
    prevFiltersRef.current.filterVersion !== filterVersion ||
    prevFiltersRef.current.filterProvenance !== filterProvenance ||
    prevFiltersRef.current.filterStatus !== filterStatus
  ) {
    prevFiltersRef.current = { filterCategory, filterSubcategory, filterName, filterVersion, filterProvenance, filterStatus }
    setCsPage(0)
  }

  const csTotalPages = Math.max(1, Math.ceil(sortedRows.length / CS_PAGE_SIZE))
  const csPageItems = sortedRows.slice(csPage * CS_PAGE_SIZE, (csPage + 1) * CS_PAGE_SIZE)

  const handleCsSort = (columnId: string) => {
    if (csSorting?.columnId === columnId) {
      if (csSorting.desc) setCsSorting({ columnId, desc: false })
      else setCsSorting(null)
    } else {
      setCsSorting({ columnId, desc: true })
    }
  }

  // Column filter renderer
  const renderCsColumnFilter = (columnId: string) => {
    if (columnId === 'category') return (
      <Select value={filterCategory || '__all__'} onValueChange={(v) => setFilterCategory(v === '__all__' ? '' : v)}>
        <SelectTrigger className="h-5 border-dashed text-[10px] px-1 [&>svg]:size-3"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">...</SelectItem>
          {categoryOptions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
    )
    if (columnId === 'subcategory') return (
      <Select value={filterSubcategory || '__all__'} onValueChange={(v) => setFilterSubcategory(v === '__all__' ? '' : v)}>
        <SelectTrigger className="h-5 border-dashed text-[10px] px-1 [&>svg]:size-3"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">...</SelectItem>
          {subcategoryOptions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
    )
    if (columnId === 'name') return <input className={FILTER_INPUT_CLASS} placeholder="..." value={filterName} onChange={(e) => setFilterName(e.target.value)} />
    if (columnId === 'version') return <input className={FILTER_INPUT_CLASS} placeholder="..." value={filterVersion} onChange={(e) => setFilterVersion(e.target.value)} />
    if (columnId === 'provenance') return (
      <Select value={filterProvenance || '__all__'} onValueChange={(v) => setFilterProvenance(v === '__all__' ? '' : v)}>
        <SelectTrigger className="h-5 border-dashed text-[10px] px-1 [&>svg]:size-3"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">...</SelectItem>
          {provenanceOptions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
    )
    if (columnId === 'mappedStatus') return (
      <Select value={filterStatus || '__all__'} onValueChange={(v) => setFilterStatus(v === '__all__' ? '' : v)}>
        <SelectTrigger className="h-5 border-dashed text-[10px] px-1 [&>svg]:size-3"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">{t('concept_mapping.cs_status_all')}</SelectItem>
          <SelectItem value="mapped">{t('concept_mapping.cs_status_mapped')}</SelectItem>
          <SelectItem value="none">{t('concept_mapping.cs_status_none')}</SelectItem>
        </SelectContent>
      </Select>
    )
    return null
  }

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredSets.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredSets.map((cs) => cs.id)))
    }
  }

  // TanStack column definitions
  const csColumns = useMemo<ColumnDef<CsRow>[]>(() => {
    const cols: ColumnDef<CsRow>[] = []

    if (selectionMode) {
      cols.push({
        id: '_selection',
        header: '',
        cell: ({ row }) => {
          const isSelected = selectedIds.has(row.original.id)
          return (
            <div
              className={`flex h-4 w-4 cursor-pointer items-center justify-center rounded border ${isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'}`}
              onClick={(e) => { e.stopPropagation(); toggleSelection(row.original.id) }}
            >
              {isSelected && <Check size={12} />}
            </div>
          )
        },
        size: 36,
        minSize: 36,
        enableResizing: false,
      })
    }

    cols.push(
      {
        id: 'category',
        header: () => t('concept_mapping.cs_filter_category'),
        accessorFn: (row) => row.category,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.category}</span>,
        size: 120,
        minSize: 60,
      },
      {
        id: 'subcategory',
        header: () => t('concept_mapping.cs_filter_subcategory'),
        accessorFn: (row) => row.subcategory,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.subcategory}</span>,
        size: 120,
        minSize: 60,
      },
      {
        id: 'name',
        header: () => t('concept_mapping.col_name'),
        accessorFn: (row) => row.name,
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="cursor-default">
                <div className="truncate font-medium">{row.original.name}</div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-sm">
              <p className="text-xs font-medium">{row.original.name}</p>
              {row.original.description && (
                <p className="mt-1 text-[11px] text-muted-foreground">{row.original.description}</p>
              )}
            </TooltipContent>
          </Tooltip>
        ),
        size: 250,
        minSize: 100,
      },
      {
        id: 'items',
        header: () => t('concept_mapping.cs_col_items'),
        accessorFn: (row) => row.items,
        cell: ({ row }) => (
          <span className="flex justify-center">
            <Badge variant="secondary" >{row.original.items}</Badge>
          </span>
        ),
        size: 60,
        minSize: 40,
      },
      {
        id: 'version',
        header: () => t('concept_mapping.cs_col_version'),
        accessorFn: (row) => row.version,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.version}</span>,
        size: 80,
        minSize: 50,
      },
      {
        id: 'provenance',
        header: () => t('concept_mapping.cs_filter_provenance'),
        accessorFn: (row) => row.provenance,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.provenance}</span>,
        size: 120,
        minSize: 60,
      },
      {
        id: 'mappedStatus',
        header: () => t('concept_mapping.cs_col_status'),
        accessorFn: (row) => row.mappedStatus,
        cell: ({ row }) => (
          <span className="flex justify-center">
            {row.original.mappedStatus === 'mapped' ? (
              <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">
                {t('concept_mapping.cs_status_mapped')}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                {t('concept_mapping.cs_status_none')}
              </Badge>
            )}
          </span>
        ),
        size: 110,
        minSize: 70,
      },
      {
        id: 'mappedCount',
        header: () => t('concept_mapping.cs_col_mapped_count'),
        accessorFn: (row) => row.mappedCount,
        cell: ({ row }) => {
          const { mappedCount, mappedSources } = row.original
          const badge = <Badge variant="secondary" >{mappedCount}</Badge>
          if (mappedCount === 0) return <span className="flex justify-center">{badge}</span>
          return (
            <span className="flex justify-center">
              <Tooltip>
                <TooltipTrigger asChild><span className="cursor-default">{badge}</span></TooltipTrigger>
                <TooltipContent side="left" className="max-w-sm">
                  <ul className="space-y-0.5 text-[11px]">
                    {mappedSources.slice(0, 10).map((s, i) => <li key={i} className="truncate">- {s}</li>)}
                    {mappedSources.length > 10 && <li className="text-muted-foreground">…</li>}
                  </ul>
                </TooltipContent>
              </Tooltip>
            </span>
          )
        },
        size: 90,
        minSize: 50,
      },
    )

    if (!selectionMode) {
      cols.push({
        id: '_actions',
        header: '',
        cell: ({ row }) => (
          <button
            type="button"
            className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
            title={t('concept_mapping.cs_view_detail')}
            onClick={(e) => { e.stopPropagation(); setDetailConceptSet(row.original.raw) }}
          >
            <Info size={14} />
          </button>
        ),
        size: 40,
        minSize: 40,
        enableResizing: false,
      })
    }

    return cols
  }, [t, selectionMode, selectedIds, toggleSelection])

  const csTable = useReactTable({
    data: csPageItems,
    columns: csColumns,
    state: { columnVisibility: csColVisibility, columnSizing: csColSizing },
    onColumnVisibilityChange: setCsColVisibility,
    onColumnSizingChange: setCsColSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    pageCount: csTotalPages,
  })

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return
    await updateMappingProject(project.id, {
      conceptSetIds: (project.conceptSetIds ?? []).filter((id) => !selectedIds.has(id)),
    })
    setSelectedIds(new Set())
    setSelectionMode(false)
    setBulkDeleteOpen(false)
  }

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }

  // The workspace library (or, until it is filled, this project's own older
  // vocabulary database).
  const vocabDsId = vocabularyDataSourceIdFor(project, dataSources)
  const vocabDs = vocabDsId ? dataSources.find((ds) => ds.id === vocabDsId) : null
  const libraryVocabularies = vocabDs ? (vocabDs.connectionConfig as DatabaseConnectionConfig).vocabularies ?? [] : []
  const openVocabularySettings = () => navigate(paths.workspaceSettings(project.workspaceId, 'vocabularies'))

  // --- Browse vocabulary queries ---

  // Load filter options when vocabulary is connected.
  // We bail out silently if the linked vocabularyDataSource is gone (e.g. workspace was
  // re-imported without re-importing the database files), to avoid spurious console errors.
  useEffect(() => {
    if (!vocabDsId) return
    if (!vocabDs) return
    const load = async () => {
      try {
        await ensureMounted(vocabDsId!)
        const vocabs = await queryDataSource(
          vocabDsId!,
          `SELECT DISTINCT vocabulary_id AS val FROM concept ORDER BY vocabulary_id`,
        )
        setBrowseVocabOptions(vocabs.map((r) => String(r.val ?? '')).filter(Boolean))
        const domains = await queryDataSource(
          vocabDsId!,
          `SELECT DISTINCT domain_id AS val FROM concept ORDER BY domain_id`,
        )
        setBrowseDomainOptions(domains.map((r) => String(r.val ?? '')).filter(Boolean))
        const classes = await queryDataSource(
          vocabDsId!,
          `SELECT DISTINCT concept_class_id AS val FROM concept ORDER BY concept_class_id`,
        )
        setBrowseClassOptions(classes.map((r) => String(r.val ?? '')).filter(Boolean))
      } catch (err) {
        console.error('Failed to load vocabulary filter options:', err)
      }
    }
    load()
  }, [vocabDsId, vocabDs, ensureMounted])

  const loadBrowseResults = useCallback(async () => {
    if (!vocabDsId) return
    // Linked vocabulary database was removed (e.g. after a workspace re-import) — skip silently.
    if (!vocabDs) return
    setBrowseLoading(true)
    try {
      await ensureMounted(vocabDsId)

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
      setBrowseResults(sql ? await queryDataSource(vocabDsId, sql) : [])
    } catch (err) {
      console.error('Browse vocabulary query failed:', err)
      setBrowseResults([])
    } finally {
      setBrowseLoading(false)
    }
  }, [vocabDsId, vocabDs, appliedSearch, browseVocabs, browseDomains, browseClasses, browseStandards, browseMaxResults, ensureMounted])

  // Runs on mount with an empty term, then on every submitted search. The empty
  // term takes the builder's cheap `ORDER BY concept_id LIMIT n` branch, not the
  // fuzzy scan, so opening the tab costs one bounded query.
  useEffect(() => {
    if (!vocabDsId) return
    if (!browseSubmitted) return
    loadBrowseResults()
  }, [loadBrowseResults, vocabDsId, browseSubmitted])

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
    return browseResults.filter((r) => {
      if (f.concept_id && !String(r.concept_id ?? '').includes(f.concept_id)) return false
      if (f.concept_name && !String(r.concept_name ?? '').toLowerCase().includes(f.concept_name.toLowerCase())) return false
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
    <div className="h-full overflow-auto p-4">
      {/* The vocabulary reference comes first: importing ATHENA is what makes
          mapping possible at all, and concept sets are a refinement on top. */}
      <Tabs defaultValue="vocabulary">
        <div className="flex justify-center">
          <TabsList className="w-fit">
            <TabsTrigger value="vocabulary">{t('concept_mapping.cs_vocabulary_ref')}</TabsTrigger>
            <TabsTrigger value="concept-sets">{t('concept_mapping.cs_project_sets')}</TabsTrigger>
          </TabsList>
        </div>

        {/* ================================================================
            Tab 1: Concept Sets — DataTable
        ================================================================ */}
        <TabsContent value="concept-sets">
          <div className="mx-auto max-w-5xl">
            {/* Toolbar */}
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t('concept_mapping.cs_description')}
              </p>
              <div className="flex gap-2">
                {linkedSets.length > 0 && (
                  <>
                    {selectionMode ? (
                      <Button size="sm" variant="outline" onClick={exitSelectionMode}>
                        <X size={14} />
                        {t('concept_mapping.cs_exit_selection')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={!canWrite} onClick={() => setSelectionMode(true)}>
                        <Pencil size={14} />
                        {t('concept_mapping.cs_edit')}
                      </Button>
                    )}
                  </>
                )}
                <Button size="sm" disabled={!canWrite} onClick={() => setImportOpen(true)}>
                  <Plus size={14} />
                  {t('concept_mapping.cs_add')}
                </Button>
              </div>
            </div>

            {/* Edit mode toolbar */}
            {selectionMode && filteredSets.length > 0 && (
              <div className="mb-3 flex items-center gap-3">
                <Button variant="outline" size="sm-tight" onClick={() => {
                  if (selectedIds.size === filteredSets.length) setSelectedIds(new Set())
                  else setSelectedIds(new Set(filteredSets.map((cs) => cs.id)))
                }}>
                  <CheckCheck size={12} />
                  {t('concept_mapping.cs_select_all')}
                </Button>
                {selectedIds.size > 0 && (
                  <>
                    <Button variant="outline" size="sm-tight" onClick={() => setSelectedIds(new Set())}>
                      <SquareX size={12} />
                      {t('concept_mapping.cs_deselect_all')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm-tight"
                      onClick={() => setBulkDeleteOpen(true)}
                    >
                      <Trash2 size={12} />
                      {t('concept_mapping.cs_delete_selected', { count: selectedIds.size })}
                    </Button>
                  </>
                )}
              </div>
            )}

            {/* DataTable content. The "no concept sets linked" empty state is
                an onboarding card; once at least one set is linked, render the
                full table even when current filters narrow it to zero rows so
                the user can clear them. */}
            {linkedSets.length === 0 ? (
              <Card>
                <div className="flex flex-col items-center py-10">
                  <BookOpen size={32} className="text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {t('concept_mapping.cs_empty')}
                  </p>
                </div>
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <div className="overflow-auto">
                  <Table className="w-full" style={{ tableLayout: 'fixed' }}>
                    <TableHeader>
                      {/* Column titles */}
                      <TableRow>
                        {csTable.getHeaderGroups().map((headerGroup) =>
                          headerGroup.headers.map((header) => {
                            const colId = header.column.id
                            const isMetaCol = colId.startsWith('_')
                            return (
                              <TableHead
                                key={header.id}
                                className="relative select-none overflow-hidden text-xs"
                                style={{ width: header.getSize(), maxWidth: header.getSize() }}
                              >
                                {isMetaCol ? (
                                  colId === '_selection' ? (
                                    <div
                                      className={`flex h-4 w-4 cursor-pointer items-center justify-center rounded border ${selectedIds.size === filteredSets.length && filteredSets.length > 0 ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'}`}
                                      onClick={toggleSelectAll}
                                    >
                                      {selectedIds.size === filteredSets.length && filteredSets.length > 0 && <Check size={12} />}
                                    </div>
                                  ) : null
                                ) : (
                                  <button
                                    type="button"
                                    className="flex w-full min-w-0 items-center gap-1 overflow-hidden hover:text-foreground"
                                    onClick={() => handleCsSort(colId)}
                                  >
                                    <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                                      {flexRender(header.column.columnDef.header, header.getContext())}
                                    </TruncatedHeader>
                                    <SortIndicator columnId={colId} sorting={csSorting} />
                                  </button>
                                )}
                                <ColumnResizeHandle header={header} />
                              </TableHead>
                            )
                          })
                        )}
                      </TableRow>
                      {/* Inline column filters */}
                      <TableRow className="hover:bg-transparent">
                        {csTable.getHeaderGroups().map((headerGroup) =>
                          headerGroup.headers.map((header) => (
                            <TableHead
                              key={`filter-${header.id}`}
                              className="px-1 py-1"
                              style={{ width: header.getSize() }}
                            >
                              {renderCsColumnFilter(header.column.id)}
                            </TableHead>
                          ))
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {csTable.getRowModel().rows.map((row) => {
                          const isSelected = selectedIds.has(row.original.id)
                          return (
                            <TableRow
                              key={row.original.id}
                              className={isSelected ? 'bg-accent' : ''}
                              data-state={isSelected ? 'selected' : undefined}
                            >
                              {row.getVisibleCells().map((cell) => {
                                const rendered = flexRender(cell.column.columnDef.cell, cell.getContext())
                                const raw = cell.getValue()
                                const title = raw != null ? String(raw) : undefined
                                return (
                                  <TableCell
                                    key={cell.id}
                                    className="overflow-hidden truncate text-xs"
                                    style={{ maxWidth: cell.column.getSize() }}
                                    title={title}
                                  >
                                    {rendered}
                                  </TableCell>
                                )
                              })}
                            </TableRow>
                          )
                        })}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination + column visibility */}
                <div className="flex items-center justify-between border-t px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      {sortedRows.length} / {linkedSets.length} concept sets
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
                      <DropdownMenuContent align="start" className="w-[180px]">
                        <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {csTable.getAllColumns()
                          .filter((col) => !col.id.startsWith('_'))
                          .map((col) => (
                            <DropdownMenuCheckboxItem
                              key={col.id}
                              checked={col.getIsVisible()}
                              onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                              onSelect={(e) => e.preventDefault()}
                              className="text-xs"
                            >
                              {columnLabel(csColumns, col.id)}
                            </DropdownMenuCheckboxItem>
                          ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon-sm" disabled={csPage === 0} onClick={() => setCsPage(csPage - 1)}>
                      <ChevronLeft size={14} />
                    </Button>
                    <span className="text-[10px] text-muted-foreground">
                      {csPage + 1} / {csTotalPages}
                    </span>
                    <Button variant="ghost" size="icon-sm" disabled={csPage >= csTotalPages - 1} onClick={() => setCsPage(csPage + 1)}>
                      <ChevronRight size={14} />
                    </Button>
                  </div>
                </div>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* ================================================================
            Tab 2: Vocabulary Reference (import + browse merged)
        ================================================================ */}
        <TabsContent value="vocabulary">
          <div className="mx-auto max-w-4xl space-y-4">
            {vocabDs ? (
              /* Vocabulary already imported — compact status + browse below */
              <>
                <Card className="p-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 size={20} className="shrink-0 text-green-500" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {(vocabDs.connectionConfig as DatabaseConnectionConfig).vocabularyLibrary
                          ? t('concept_mapping.vocab_library_summary', { count: libraryVocabularies.length })
                          : localized(vocabDs.name, i18n.language)}
                      </p>
                      {libraryVocabularies.length > 0 && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {libraryVocabularies.map((v) => v.vocabularyId).join(', ')}
                        </p>
                      )}
                    </div>
                    <Button size="sm" variant="outline" onClick={openVocabularySettings}>
                      <Settings2 size={14} />
                      {t('concept_mapping.vocab_library_manage')}
                    </Button>
                  </div>
                </Card>

                {/* Browse vocabulary */}
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
                            {browseTable.getAllColumns().map((col) => (
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
              </>
            ) : (
              /* No vocabulary in the workspace: it is imported in the workspace settings */
              <Card className="p-6">
                <div className="flex flex-col items-center">
                  <BookOpen size={32} className="text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">{t('concept_mapping.vocab_library_empty_title')}</p>
                  <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                    {t('concept_mapping.vocab_library_empty_hint')}
                  </p>
                  <Button size="sm" variant="outline" className="mt-4" onClick={openVocabularySettings}>
                    <Settings2 size={14} />
                    {t('concept_mapping.vocab_library_manage')}
                  </Button>
                </div>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <PickConceptSetsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        project={project}
      />

      <ConceptSetDetailSheet
        conceptSet={detailConceptSet}
        open={!!detailConceptSet}
        onOpenChange={(open) => { if (!open) setDetailConceptSet(null) }}
      />

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

      {/* Bulk delete dialog */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.cs_bulk_delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.cs_bulk_delete_description', { count: selectedIds.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleBulkDelete}>{t('concept_mapping.cs_detach')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  )
}
