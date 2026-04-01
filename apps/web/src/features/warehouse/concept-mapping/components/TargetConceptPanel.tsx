import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import { Search, Plus, Check, ArrowLeft, Loader2, ChevronLeft, ChevronRight, ChevronDown, Settings2, MessageSquare, ArrowUpDown, ArrowUp, ArrowDown, EyeOff, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildStandardConceptSearchQuery } from '@/lib/concept-mapping/mapping-queries'
import { getConceptSetI18n } from '@/lib/concept-mapping/i18n'
import { ConceptSetDetailSheet } from '../ConceptSetDetailSheet'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import type { MappingProject, DataSource, MappingEquivalence, ConceptSet, ResolvedConcept } from '@/types'
import type { SourceConceptRow } from '../MappingEditorTab'

interface TargetConceptPanelProps {
  project: MappingProject
  dataSource?: DataSource
  sourceConcept: SourceConceptRow | null
  /** Set of source concept IDs marked as ignored (derived from mappings). */
  ignoredConceptIds: Set<number>
  onGoToConceptSets?: () => void
}

interface SearchResult {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  standard_concept?: string
}

/** Derive the resolved concept set URL from the source URL. */
function getResolvedUrl(sourceUrl?: string): string | null {
  if (!sourceUrl) return null
  if (!sourceUrl.includes('/concept_sets/')) return null
  return sourceUrl.replace('/concept_sets/', '/concept_sets_resolved/')
}

const CS_PAGE_SIZE = 50
const RESOLVED_PAGE_SIZE = 50

/** Small dropdown for categorical column filters. */
function ColumnFilterSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string | null
  options: string[]
  placeholder: string
  onChange: (v: string | null) => void
}) {
  const { t } = useTranslation()
  return (
    <Select
      value={value ?? '__all__'}
      onValueChange={(v) => onChange(v === '__all__' ? null : v)}
    >
      <SelectTrigger className="h-6 w-full border-dashed text-[10px] font-normal">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">{t('concepts.filter_all')}</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt} value={opt} className="text-xs">{opt}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Fuzzy match: all query characters appear in order in the target. */
function fuzzyMatch(target: string, query: string): boolean {
  let qi = 0
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++
  }
  return qi === query.length
}

function textMatch(text: string, query: string): boolean {
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  return t.includes(q) || fuzzyMatch(t, q)
}

export function TargetConceptPanel({ project, dataSource, sourceConcept, ignoredConceptIds, onGoToConceptSets }: TargetConceptPanelProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { mappings, conceptSets, createMapping, deleteMapping } = useConceptMappingStore()
  const getUserDisplayName = useAppStore((s) => s.getUserDisplayName)
  const allDataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  // Search for mapping
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  // "Map with comment" dialog
  const [commentDialogOpen, setCommentDialogOpen] = useState(false)
  const [commentEquivalence, setCommentEquivalence] = useState<MappingEquivalence>('skos:exactMatch')
  const [commentText, setCommentText] = useState('')

  // "Ignore with comment" dialog
  const [ignoreDialogOpen, setIgnoreDialogOpen] = useState(false)
  const [ignoreCommentText, setIgnoreCommentText] = useState('')

  // Browse mode state
  const [csFilterCategory, setCsFilterCategory] = useState('')
  const [csFilterSubcategory, setCsFilterSubcategory] = useState('')
  const [csFilterName, setCsFilterName] = useState('')
  const [csPage, setCsPage] = useState(0)

  // Selected concept set for resolved view
  const [selectedCs, setSelectedCs] = useState<ConceptSet | null>(null)
  const selectedCsTr = useMemo(
    () => selectedCs ? getConceptSetI18n(selectedCs, lang) : { name: '', description: '', category: undefined, subcategory: undefined },
    [selectedCs, lang],
  )
  const [detailSheetOpen, setDetailSheetOpen] = useState(false)
  const [detailSheetCs, setDetailSheetCs] = useState<ConceptSet | null>(null)
  const [resolvedConcepts, setResolvedConcepts] = useState<ResolvedConcept[]>([])
  const [resolvedLoading, setResolvedLoading] = useState(false)
  const [resolvedError, setResolvedError] = useState<string | null>(null)
  const [resolvedSearch, setResolvedSearch] = useState('')
  const [resolvedPage, setResolvedPage] = useState(0)

  // Browse mode toggle
  const [browseMode, setBrowseMode] = useState<'concept_sets' | 'search'>('concept_sets')

  // Selected target concept (for resolved concepts or search results)
  const [selectedTarget, setSelectedTarget] = useState<{ conceptId: number; conceptName: string; vocabularyId: string; domainId: string; conceptCode: string } | null>(null)

  // Clear selected target when source concept changes
  useEffect(() => {
    setSelectedTarget(null)
  }, [sourceConcept?.concept_id])

  // Linked concept sets
  const linkedSets = conceptSets.filter((cs) => project.conceptSetIds.includes(cs.id))


  // Existing mappings for selected source concept (match by ID or by code for code-only tables)
  const existingMappings = sourceConcept
    ? mappings.filter((m) =>
        m.sourceConceptId === sourceConcept.concept_id ||
        (m.sourceConceptCode && sourceConcept.concept_code && m.sourceConceptCode === sourceConcept.concept_code)
      )
    : []

  // Unique dropdown options for category, subcategory, provenance
  const csCategoryOptions = useMemo(() => [...new Set(linkedSets.map((cs) => getConceptSetI18n(cs, lang).category).filter(Boolean) as string[])].sort(), [linkedSets, lang])
  const csSubcategoryOptions = useMemo(() => [...new Set(linkedSets.map((cs) => getConceptSetI18n(cs, lang).subcategory).filter(Boolean) as string[])].sort(), [linkedSets, lang])
  const csProvenanceOptions = useMemo(() => [...new Set(linkedSets.map((cs) => cs.provenance).filter(Boolean) as string[])].sort(), [linkedSets])

  // Filter concept sets by column filters
  const filteredCs = linkedSets.filter((cs) => {
    const tr = getConceptSetI18n(cs, lang)
    if (csFilterCategory && (tr.category ?? '') !== csFilterCategory) return false
    if (csFilterSubcategory && (tr.subcategory ?? '') !== csFilterSubcategory) return false
    if (csFilterName && !textMatch(tr.name, csFilterName)) return false
    return true
  })

  // csTotalPages and csPageItems computed in renderConceptSetsBrowse via fullyFilteredCs

  // Reset cs page when filters change
  const prevFiltersRef = useRef({ csFilterCategory, csFilterSubcategory, csFilterName })
  if (
    prevFiltersRef.current.csFilterCategory !== csFilterCategory ||
    prevFiltersRef.current.csFilterSubcategory !== csFilterSubcategory ||
    prevFiltersRef.current.csFilterName !== csFilterName
  ) {
    prevFiltersRef.current = { csFilterCategory, csFilterSubcategory, csFilterName }
    setCsPage(0)
  }

  // Load resolved concepts when a concept set is selected
  const loadResolved = useCallback(async (cs: ConceptSet) => {
    setResolvedConcepts([])
    setResolvedError(null)
    setResolvedSearch('')
    setResolvedPage(0)

    const url = getResolvedUrl(cs.sourceUrl)
    if (!url) {
      // Fall back to expression items as "resolved"
      setResolvedConcepts(
        cs.expression.items
          .filter((item) => !item.isExcluded)
          .map((item) => ({
            conceptId: item.concept.conceptId,
            conceptName: item.concept.conceptName,
            vocabularyId: item.concept.vocabularyId,
            domainId: item.concept.domainId,
            conceptClassId: item.concept.conceptClassId,
            conceptCode: item.concept.conceptCode,
            standardConcept: item.concept.standardConcept,
          })),
      )
      return
    }

    setResolvedLoading(true)
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()
      const obj = json as Record<string, unknown>
      const items = obj.resolvedConcepts as Record<string, unknown>[] | undefined
      if (!Array.isArray(items)) throw new Error('Invalid format')

      setResolvedConcepts(
        items.map((c) => ({
          conceptId: Number(c.conceptId ?? c.concept_id ?? 0),
          conceptName: String(c.conceptName ?? c.concept_name ?? ''),
          vocabularyId: String(c.vocabularyId ?? c.vocabulary_id ?? ''),
          domainId: String(c.domainId ?? c.domain_id ?? ''),
          conceptClassId: String(c.conceptClassId ?? c.concept_class_id ?? ''),
          conceptCode: String(c.conceptCode ?? c.concept_code ?? ''),
          standardConcept: (c.standardConcept ?? c.standard_concept ?? null) as string | null,
        })),
      )
    } catch (err) {
      setResolvedError(err instanceof Error ? err.message : String(err))
    } finally {
      setResolvedLoading(false)
    }
  }, [])

  // When selecting a concept set, load its resolved concepts
  const handleSelectCs = useCallback((cs: ConceptSet) => {
    setSelectedCs(cs)
    loadResolved(cs)
  }, [loadResolved])

  // Filter resolved concepts
  const filteredResolved = resolvedSearch.trim()
    ? resolvedConcepts.filter((c) => {
        const q = resolvedSearch.toLowerCase()
        return (
          c.conceptName.toLowerCase().includes(q) ||
          String(c.conceptId).includes(q) ||
          c.vocabularyId.toLowerCase().includes(q) ||
          c.domainId.toLowerCase().includes(q)
        )
      })
    : resolvedConcepts

  const resolvedTotalPages = Math.max(1, Math.ceil(filteredResolved.length / RESOLVED_PAGE_SIZE))
  const resolvedPageItems = filteredResolved.slice(
    resolvedPage * RESOLVED_PAGE_SIZE,
    (resolvedPage + 1) * RESOLVED_PAGE_SIZE,
  )

  // Reset resolved page when search changes
  useEffect(() => {
    setResolvedPage(0)
  }, [resolvedSearch])

  const handleSearch = useCallback(async () => {
    if (!searchTerm.trim()) return
    // Determine which data source and schema mapping to use for the search.
    // If a vocabulary reference is imported, use it; otherwise fall back to the clinical DB.
    const vocabDs = project.vocabularyDataSourceId
      ? allDataSources.find((ds) => ds.id === project.vocabularyDataSourceId)
      : null
    const targetDsId = vocabDs?.id ?? dataSource?.id
    const targetMapping = vocabDs?.schemaMapping ?? dataSource?.schemaMapping
    if (!targetDsId || !targetMapping) return
    setSearching(true)
    try {
      await ensureMounted(targetDsId)
      const sql = buildStandardConceptSearchQuery(targetMapping, searchTerm.trim())
      if (!sql) { setSearching(false); return }
      const results = await queryDataSource(targetDsId, sql)
      setSearchResults(results as unknown as SearchResult[])
      setSearchPage(0)
    } catch (err) {
      console.error('Search failed:', err)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [searchTerm, dataSource, project.vocabularyDataSourceId, allDataSources, ensureMounted])

  /** Add mapping from the selected target concept with a given predicate and optional comment. */
  const handleAddSelectedMapping = async (predicate: MappingEquivalence = 'skos:exactMatch', comment = '') => {
    if (!sourceConcept || !selectedTarget) return
    const alreadyMapped = existingMappings.some((m) => m.targetConceptId === selectedTarget.conceptId)
    if (alreadyMapped) return
    const now = new Date().toISOString()
    await createMapping({
      id: crypto.randomUUID(),
      projectId: project.id,
      sourceConceptId: sourceConcept.concept_id,
      sourceConceptName: sourceConcept.concept_name,
      sourceVocabularyId: sourceConcept.vocabulary_id ?? '',
      sourceDomainId: sourceConcept.domain_id ?? '',
      sourceConceptCode: sourceConcept.concept_code ?? '',
      sourceFrequency: sourceConcept.record_count,
      sourceCategoryId: sourceConcept.category,
      sourceSubcategoryId: sourceConcept.subcategory,
      targetConceptId: selectedTarget.conceptId,
      targetConceptName: selectedTarget.conceptName,
      targetVocabularyId: selectedTarget.vocabularyId,
      targetDomainId: selectedTarget.domainId,
      targetConceptCode: selectedTarget.conceptCode,
      conceptSetId: selectedCs?.id,
      mappingType: 'maps_to',
      equivalence: predicate,
      status: 'unchecked',
      comment,
      comments: comment ? [{
        id: crypto.randomUUID(),
        authorId: getUserDisplayName(),
        text: comment,
        createdAt: now,
      }] : undefined,
      mappedBy: getUserDisplayName(),
      mappedOn: now,
      createdAt: now,
      updatedAt: now,
    })
    setSelectedTarget(null)
  }

  /** Submit from the "Map with comment" dialog. */
  const handleCommentDialogSubmit = () => {
    handleAddSelectedMapping(commentEquivalence, commentText.trim())
    setCommentDialogOpen(false)
    setCommentText('')
    setCommentEquivalence('skos:exactMatch')
  }

  /** Toggle ignored status: create or delete the ignored mapping. */
  const handleToggleIgnored = async (comment = '') => {
    if (!sourceConcept) return
    const isIgnored = ignoredConceptIds.has(sourceConcept.concept_id)
    if (isIgnored) {
      // Remove the ignored mapping
      const ignoredMapping = mappings.find(
        (m) => m.sourceConceptId === sourceConcept.concept_id && m.status === 'ignored',
      )
      if (ignoredMapping) await deleteMapping(ignoredMapping.id)
    } else {
      // Create an ignored mapping (targetConceptId=0)
      const now = new Date().toISOString()
      await createMapping({
        id: crypto.randomUUID(),
        projectId: project.id,
        sourceConceptId: sourceConcept.concept_id,
        sourceConceptName: sourceConcept.concept_name,
        sourceVocabularyId: sourceConcept.vocabulary_id ?? '',
        sourceDomainId: sourceConcept.domain_id ?? '',
        sourceConceptCode: sourceConcept.concept_code ?? '',
        sourceFrequency: sourceConcept.record_count,
        sourceCategoryId: sourceConcept.category,
        sourceSubcategoryId: sourceConcept.subcategory,
        targetConceptId: 0,
        targetConceptName: '',
        targetVocabularyId: '',
        targetDomainId: '',
        targetConceptCode: '',
        equivalence: 'skos:exactMatch',
        status: 'ignored',
        comment,
        comments: comment ? [{
          id: crypto.randomUUID(),
          authorId: getUserDisplayName(),
          text: comment,
          createdAt: now,
        }] : undefined,
        mappedBy: getUserDisplayName(),
        mappedOn: now,
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  /** Submit from the "Ignore with comment" dialog. */
  const handleIgnoreDialogSubmit = () => {
    handleToggleIgnored(ignoreCommentText.trim())
    setIgnoreDialogOpen(false)
    setIgnoreCommentText('')
  }

  // ─── Concept sets datatable (browse view) ───────────────────────────

  // Filters for additional concept set columns
  const [csFilterVersion, setCsFilterVersion] = useState('')
  const [csFilterProvenance, setCsFilterProvenance] = useState('')

  // TanStack table state for concept sets browse
  const [csColVisibility, setCsColVisibility] = useState<VisibilityState>({
    items: false,
    version: false,
    provenance: false,
  })
  const [csColSizing, setCsColSizing] = useState<Record<string, number>>({})
  const [csSorting, setCsSorting] = useState<{ columnId: string; desc: boolean } | null>(null)

  // Reset cs page when provenance/version filters change too
  const prevExtraFiltersRef = useRef({ csFilterVersion, csFilterProvenance })
  if (prevExtraFiltersRef.current.csFilterVersion !== csFilterVersion || prevExtraFiltersRef.current.csFilterProvenance !== csFilterProvenance) {
    prevExtraFiltersRef.current = { csFilterVersion, csFilterProvenance }
    setCsPage(0)
  }

  /** Translated row for the concept sets browse table. */
  interface CsBrowseRow {
    id: string
    category: string
    subcategory: string
    name: string
    items: number
    version: string
    provenance: string
    raw: ConceptSet
  }

  // Build translated rows
  const csBrowseRows = useMemo<CsBrowseRow[]>(() => {
    return filteredCs
      .filter((cs) => {
        if (csFilterVersion && !(cs.version ?? '').toLowerCase().includes(csFilterVersion.toLowerCase())) return false
        if (csFilterProvenance && (cs.provenance ?? '') !== csFilterProvenance) return false
        return true
      })
      .map((cs) => {
        const tr = getConceptSetI18n(cs, lang)
        return {
          id: cs.id,
          category: tr.category ?? '',
          subcategory: tr.subcategory ?? '',
          name: tr.name,
          items: cs.expression.items.length,
          version: cs.version ?? '',
          provenance: cs.provenance ?? '',
          raw: cs,
        }
      })
  }, [filteredCs, csFilterVersion, csFilterProvenance, lang])

  // Apply sorting
  const csSortedRows = useMemo(() => {
    if (!csSorting) return csBrowseRows
    const col = csSorting.columnId as keyof CsBrowseRow
    const dir = csSorting.desc ? -1 : 1
    return [...csBrowseRows].sort((a, b) => {
      const va = a[col] ?? ''
      const vb = b[col] ?? ''
      if (typeof va === 'number' && typeof vb === 'number') return dir * (va - vb)
      return dir * String(va).localeCompare(String(vb))
    })
  }, [csBrowseRows, csSorting])

  const csFullTotalPages = Math.max(1, Math.ceil(csSortedRows.length / CS_PAGE_SIZE))
  const csFullPageItems = csSortedRows.slice(csPage * CS_PAGE_SIZE, (csPage + 1) * CS_PAGE_SIZE)

  const handleCsSort = (columnId: string) => {
    if (csSorting?.columnId === columnId) {
      if (csSorting.desc) setCsSorting({ columnId, desc: false })
      else setCsSorting(null)
    } else {
      setCsSorting({ columnId, desc: true })
    }
  }

  const FILTER_INPUT_CLASS = 'h-5 w-full rounded border border-dashed bg-transparent px-1 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

  const renderCsFilter = (columnId: string) => {
    if (columnId === 'category') return (
      <Select value={csFilterCategory || '__all__'} onValueChange={(v) => setCsFilterCategory(v === '__all__' ? '' : v)}>
        <SelectTrigger className="h-5 border-dashed text-[10px] px-1 [&>svg]:size-3"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">...</SelectItem>
          {csCategoryOptions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
    )
    if (columnId === 'subcategory') return (
      <Select value={csFilterSubcategory || '__all__'} onValueChange={(v) => setCsFilterSubcategory(v === '__all__' ? '' : v)}>
        <SelectTrigger className="h-5 border-dashed text-[10px] px-1 [&>svg]:size-3"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">...</SelectItem>
          {csSubcategoryOptions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
    )
    if (columnId === 'name') return <input className={FILTER_INPUT_CLASS} placeholder="..." value={csFilterName} onChange={(e) => setCsFilterName(e.target.value)} />
    if (columnId === 'version') return <input className={FILTER_INPUT_CLASS} placeholder="..." value={csFilterVersion} onChange={(e) => setCsFilterVersion(e.target.value)} />
    if (columnId === 'provenance') return (
      <Select value={csFilterProvenance || '__all__'} onValueChange={(v) => setCsFilterProvenance(v === '__all__' ? '' : v)}>
        <SelectTrigger className="h-5 border-dashed text-[10px] px-1 [&>svg]:size-3"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">...</SelectItem>
          {csProvenanceOptions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
    )
    return null
  }

  // TanStack column definitions for concept sets browse
  const csColumns = useMemo<ColumnDef<CsBrowseRow>[]>(() => [
    {
      id: 'category',
      header: () => t('concept_mapping.col_category'),
      accessorFn: (row) => row.category,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.category}</span>,
      size: 80,
      minSize: 50,
    },
    {
      id: 'subcategory',
      header: () => t('concept_mapping.col_subcategory'),
      accessorFn: (row) => row.subcategory,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.subcategory}</span>,
      size: 80,
      minSize: 50,
    },
    {
      id: 'name',
      header: () => t('concept_mapping.col_concept_set'),
      accessorFn: (row) => row.name,
      cell: ({ row }) => row.original.name,
      size: 180,
      minSize: 80,
    },
    {
      id: 'items',
      header: () => t('concept_mapping.cs_col_items'),
      accessorFn: (row) => row.items,
      cell: ({ row }) => (
        <span className="flex justify-center">
          <Badge variant="secondary" className="text-[9px]">{row.original.items}</Badge>
        </span>
      ),
      size: 50,
      minSize: 40,
    },
    {
      id: 'version',
      header: () => t('concept_mapping.cs_col_version'),
      accessorFn: (row) => row.version,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.version}</span>,
      size: 60,
      minSize: 40,
    },
    {
      id: 'provenance',
      header: () => t('concept_mapping.cs_filter_provenance'),
      accessorFn: (row) => row.provenance,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.provenance}</span>,
      size: 80,
      minSize: 50,
    },
    {
      id: '_actions',
      header: '',
      cell: ({ row }) => (
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
          title={t('concept_mapping.cs_view_detail')}
          onClick={(e) => {
            e.stopPropagation()
            setDetailSheetCs(row.original.raw)
            setDetailSheetOpen(true)
          }}
        >
          <Info size={12} />
        </button>
      ),
      size: 28,
      minSize: 28,
      enableResizing: false,
    },
  ], [t])

  /** Get human-readable label for a concept set column. */
  const getCsColLabel = (id: string): string => {
    const def = csColumns.find((c) => 'id' in c && c.id === id)
    if (def && typeof def.header === 'function') {
      const result = (def.header as () => unknown)()
      if (typeof result === 'string') return result
    }
    return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }

  const csTable = useReactTable({
    data: csFullPageItems,
    columns: csColumns,
    state: { columnVisibility: csColVisibility, columnSizing: csColSizing },
    onColumnVisibilityChange: setCsColVisibility,
    onColumnSizingChange: setCsColSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    pageCount: csFullTotalPages,
  })

  const renderConceptSetsBrowse = () => (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
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
                      className="relative select-none text-[10px]"
                      style={{ width: header.getSize() }}
                    >
                      {isMetaCol ? null : (
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-1 hover:text-foreground"
                          onClick={() => handleCsSort(colId)}
                        >
                          <span className="truncate">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                          {!csSorting || csSorting.columnId !== colId
                            ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                            : csSorting.desc
                              ? <ArrowDown size={10} className="shrink-0 text-primary" />
                              : <ArrowUp size={10} className="shrink-0 text-primary" />}
                        </button>
                      )}
                      {/* Resize handle */}
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                          className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                        >
                          <div
                            className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${
                              header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40'
                            }`}
                          />
                        </div>
                      )}
                    </TableHead>
                  )
                })
              )}
            </TableRow>
            {/* Inline filters */}
            <TableRow className="hover:bg-transparent">
              {csTable.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => (
                  <TableHead
                    key={`filter-${header.id}`}
                    className="px-1 py-1"
                    style={{ width: header.getSize() }}
                  >
                    {renderCsFilter(header.column.id)}
                  </TableHead>
                ))
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {csFullPageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={csTable.getVisibleLeafColumns().length} className="h-40 text-center">
                  {linkedSets.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 px-4">
                      <p className="text-xs text-muted-foreground">{t('concept_mapping.no_concept_sets_hint')}</p>
                      {onGoToConceptSets && (
                        <button
                          type="button"
                          onClick={onGoToConceptSets}
                          className="text-xs text-primary underline-offset-2 hover:underline"
                        >
                          {t('concept_mapping.go_to_concept_sets')}
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('common.no_results')}</p>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              csTable.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.original.id}
                  className="cursor-pointer"
                  onClick={() => handleSelectCs(row.original.raw)}
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
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination + column visibility */}
      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {csSortedRows.length} concept sets
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                <Settings2 size={12} />
              </Button>
            </DropdownMenuTrigger>
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
                    {getCsColLabel(col.id)}
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
            {csPage + 1} / {csFullTotalPages}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={csPage >= csFullTotalPages - 1} onClick={() => setCsPage(csPage + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )

  // ─── Resolved concepts view ─────────────────────────────────────────

  const renderResolvedConcepts = () => (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header with back button */}
      <div className="border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => setSelectedCs(null)}>
            <ArrowLeft size={14} />
          </Button>
          <div className="min-w-0 flex-1 rounded-md bg-blue-50 dark:bg-blue-950/50 px-2.5 py-1.5">
            <p className="truncate text-xs font-semibold text-blue-900 dark:text-blue-100">{selectedCsTr.name}</p>
            <div className="flex gap-1 mt-0.5">
              {selectedCsTr.category && (
                <Badge variant="outline" className="text-[9px] border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300">{selectedCsTr.category}</Badge>
              )}
              {selectedCsTr.subcategory && (
                <Badge variant="outline" className="text-[9px] border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300">{selectedCsTr.subcategory}</Badge>
              )}
              <Badge variant="secondary" className="text-[9px] bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 border-0">
                {resolvedConcepts.length} {t('concept_mapping.cs_concepts')}
              </Badge>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            title={t('concept_mapping.cs_detail_info')}
            onClick={() => { setDetailSheetCs(selectedCs); setDetailSheetOpen(true) }}
          >
            <Info size={14} />
          </Button>
        </div>
        <div className="relative mt-2">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-7 pl-8 text-xs"
            placeholder={t('concept_mapping.browse_search_resolved')}
            value={resolvedSearch}
            onChange={(e) => setResolvedSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[1fr_60px_70px_70px_20px] items-center gap-1 border-b bg-muted/30 px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        <span>{t('concept_mapping.col_name')}</span>
        <span>ID</span>
        <span>{t('concept_mapping.col_vocab')}</span>
        <span>{t('concept_mapping.col_domain')}</span>
        <span />
      </div>

      {/* Table body */}
      <div className="flex-1 overflow-auto">
        {resolvedLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : resolvedError ? (
          <div className="flex h-32 items-center justify-center px-4">
            <p className="text-xs text-destructive">{resolvedError}</p>
          </div>
        ) : resolvedPageItems.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-xs text-muted-foreground">{t('common.no_results')}</p>
          </div>
        ) : (
          resolvedPageItems.map((rc) => {
            const alreadyMapped = sourceConcept
              ? existingMappings.some((m) => m.targetConceptId === rc.conceptId)
              : false
            const isSelected = selectedTarget?.conceptId === rc.conceptId
            return (
              <button
                key={rc.conceptId}
                className={`grid w-full grid-cols-[1fr_60px_70px_70px_20px] items-center gap-1 px-3 py-1.5 text-left text-xs transition-colors border-b border-border/40 ${
                  isSelected ? 'bg-accent' : 'hover:bg-accent/50'
                } ${alreadyMapped ? 'opacity-50' : ''}`}
                onClick={() => {
                  if (!alreadyMapped && sourceConcept) {
                    setSelectedTarget(isSelected ? null : {
                      conceptId: rc.conceptId,
                      conceptName: rc.conceptName,
                      vocabularyId: rc.vocabularyId,
                      domainId: rc.domainId,
                      conceptCode: rc.conceptCode,
                    })
                  }
                }}
              >
                <span className="truncate" title={rc.conceptName}>{rc.conceptName}</span>
                <span className="text-muted-foreground">{rc.conceptId}</span>
                <span className="truncate text-muted-foreground">{rc.vocabularyId}</span>
                <span className="truncate text-muted-foreground">{rc.domainId}</span>
                <span className="flex justify-center">
                  {alreadyMapped && (
                    <Check size={12} className="text-green-600" />
                  )}
                </span>
              </button>
            )
          })
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <span className="text-[10px] text-muted-foreground">
          {filteredResolved.length} {t('concept_mapping.cs_concepts')}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={resolvedPage === 0} onClick={() => setResolvedPage(resolvedPage - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {resolvedPage + 1} / {resolvedTotalPages}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={resolvedPage >= resolvedTotalPages - 1} onClick={() => setResolvedPage(resolvedPage + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )

  // ─── Search mode: TanStack DataTable ─────────────────────────────

  const [searchColVisibility, setSearchColVisibility] = useState<VisibilityState>({})
  const [searchColSizing, setSearchColSizing] = useState<Record<string, number>>({})
  const [searchSorting, setSearchSorting] = useState<{ columnId: string; desc: boolean } | null>(null)
  const [searchPage, setSearchPage] = useState(0)
  const SEARCH_PAGE_SIZE = 50

  // Inline column filters for search results (client-side post-filtering)
  interface SearchColumnFilters {
    concept_id?: string
    concept_name?: string
    concept_code?: string
    vocabulary_id?: string
    domain_id?: string
    concept_class_id?: string
    standard_concept?: string | null
  }
  const [searchColFilters, setSearchColFilters] = useState<SearchColumnFilters>({})

  // Apply inline filters to search results
  const filteredSearchResults = searchResults.filter((r) => {
    const f = searchColFilters
    if (f.concept_id && !String(r.concept_id).includes(f.concept_id)) return false
    if (f.concept_name && !textMatch(r.concept_name, f.concept_name)) return false
    if (f.concept_code && !r.concept_code.toLowerCase().includes(f.concept_code.toLowerCase())) return false
    if (f.vocabulary_id && r.vocabulary_id !== f.vocabulary_id) return false
    if (f.domain_id && (r.domain_id ?? '') !== f.domain_id) return false
    if (f.concept_class_id && (r.concept_class_id ?? '') !== f.concept_class_id) return false
    if (f.standard_concept && (r.standard_concept ?? '') !== f.standard_concept) return false
    return true
  })

  const updateSearchFilter = (key: keyof SearchColumnFilters, value: string | null) => {
    setSearchColFilters((prev) => ({ ...prev, [key]: value ?? undefined }))
    setSearchPage(0)
  }

  const SEARCH_FILTER_INPUT_CLASS = 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

  // Compute distinct values for dropdown filters from search results
  const searchFilterOptions = useMemo(() => {
    const unique = (fn: (r: SearchResult) => string | undefined) =>
      [...new Set(searchResults.map(fn).filter(Boolean) as string[])].sort()
    return {
      vocabulary_id: unique((r) => r.vocabulary_id),
      domain_id: unique((r) => r.domain_id),
      concept_class_id: unique((r) => r.concept_class_id),
    }
  }, [searchResults])

  const renderSearchColumnFilter = (columnId: string) => {
    if (columnId === 'concept_id') {
      return <input className={`${SEARCH_FILTER_INPUT_CLASS} font-mono`} placeholder="ID..." value={searchColFilters.concept_id ?? ''} onChange={(e) => updateSearchFilter('concept_id', e.target.value || null)} />
    }
    if (columnId === 'concept_name') {
      return <input className={SEARCH_FILTER_INPUT_CLASS} placeholder="..." value={searchColFilters.concept_name ?? ''} onChange={(e) => updateSearchFilter('concept_name', e.target.value || null)} />
    }
    if (columnId === 'concept_code') {
      return <input className={`${SEARCH_FILTER_INPUT_CLASS} font-mono`} placeholder="Code..." value={searchColFilters.concept_code ?? ''} onChange={(e) => updateSearchFilter('concept_code', e.target.value || null)} />
    }
    if (columnId === 'vocabulary_id' && searchFilterOptions.vocabulary_id.length > 0) {
      return <ColumnFilterSelect value={searchColFilters.vocabulary_id ?? null} options={searchFilterOptions.vocabulary_id} placeholder="Vocab" onChange={(v) => updateSearchFilter('vocabulary_id', v)} />
    }
    if (columnId === 'domain_id' && searchFilterOptions.domain_id.length > 0) {
      return <ColumnFilterSelect value={searchColFilters.domain_id ?? null} options={searchFilterOptions.domain_id} placeholder="Domain" onChange={(v) => updateSearchFilter('domain_id', v)} />
    }
    if (columnId === 'concept_class_id' && searchFilterOptions.concept_class_id.length > 0) {
      return <ColumnFilterSelect value={searchColFilters.concept_class_id ?? null} options={searchFilterOptions.concept_class_id} placeholder="Class" onChange={(v) => updateSearchFilter('concept_class_id', v)} />
    }
    if (columnId === 'standard_concept') {
      return (
        <Select value={searchColFilters.standard_concept ?? '__all__'} onValueChange={(v) => updateSearchFilter('standard_concept', v === '__all__' ? null : v)}>
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

  const searchColumns = useMemo<ColumnDef<SearchResult>[]>(() => [
    {
      id: 'concept_id',
      header: 'ID',
      accessorFn: (row) => row.concept_id,
      cell: ({ row }) => <span className="font-mono">{row.original.concept_id}</span>,
      size: 70,
      minSize: 50,
    },
    {
      id: 'concept_name',
      header: () => t('concept_mapping.col_name'),
      accessorFn: (row) => row.concept_name,
      cell: ({ row }) => row.original.concept_name,
      size: 200,
      minSize: 100,
    },
    {
      id: 'concept_code',
      header: 'Code',
      accessorFn: (row) => row.concept_code,
      cell: ({ row }) => <span className="font-mono">{row.original.concept_code}</span>,
      size: 80,
      minSize: 50,
    },
    {
      id: 'vocabulary_id',
      header: () => t('concept_mapping.col_vocab'),
      accessorFn: (row) => row.vocabulary_id,
      cell: ({ row }) => row.original.vocabulary_id,
      size: 80,
      minSize: 50,
    },
    {
      id: 'domain_id',
      header: () => t('concept_mapping.col_domain'),
      accessorFn: (row) => row.domain_id,
      cell: ({ row }) => row.original.domain_id ?? '',
      size: 80,
      minSize: 50,
    },
    {
      id: 'concept_class_id',
      header: () => t('concept_mapping.col_concept_class'),
      accessorFn: (row) => row.concept_class_id,
      cell: ({ row }) => row.original.concept_class_id ?? '',
      size: 90,
      minSize: 50,
    },
    {
      id: 'standard_concept',
      header: 'Std',
      accessorFn: (row) => row.standard_concept,
      cell: ({ row }) => {
        const sc = row.original.standard_concept
        if (sc === 'S') return <Badge variant="default" className="px-1 py-0 text-[8px]">S</Badge>
        if (sc === 'C') return <Badge variant="secondary" className="px-1 py-0 text-[8px]">C</Badge>
        return <span className="text-[10px] text-muted-foreground">{sc ?? ''}</span>
      },
      size: 40,
      minSize: 30,
    },
    {
      id: '_check',
      header: '',
      cell: ({ row }) => {
        const alreadyMapped = sourceConcept
          ? existingMappings.some((m) => m.targetConceptId === row.original.concept_id)
          : false
        return alreadyMapped ? <Check size={12} className="text-green-600" /> : null
      },
      size: 28,
      minSize: 28,
      enableResizing: false,
    },
  ], [t, sourceConcept, existingMappings])

  // Apply sorting to filtered search results
  const sortedSearchResults = useMemo(() => {
    if (!searchSorting) return filteredSearchResults
    const { columnId, desc } = searchSorting
    const dir = desc ? -1 : 1
    return [...filteredSearchResults].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[columnId]
      const bv = (b as unknown as Record<string, unknown>)[columnId]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv)
      return dir * String(av).localeCompare(String(bv))
    })
  }, [filteredSearchResults, searchSorting])

  const handleSearchSort = (columnId: string) => {
    if (searchSorting?.columnId === columnId) {
      if (searchSorting.desc) setSearchSorting({ columnId, desc: false })
      else setSearchSorting(null)
    } else {
      setSearchSorting({ columnId, desc: true })
    }
    setSearchPage(0)
  }

  const searchPageItems = sortedSearchResults.slice(searchPage * SEARCH_PAGE_SIZE, (searchPage + 1) * SEARCH_PAGE_SIZE)
  const searchTotalPages = Math.max(1, Math.ceil(sortedSearchResults.length / SEARCH_PAGE_SIZE))

  const searchTable = useReactTable({
    data: searchPageItems,
    columns: searchColumns,
    state: { columnVisibility: searchColVisibility, columnSizing: searchColSizing },
    onColumnVisibilityChange: setSearchColVisibility,
    onColumnSizingChange: setSearchColSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: searchTotalPages,
  })

  /** Get human-readable label for a column. */
  const getSearchColLabel = (id: string): string => {
    const col = searchColumns.find((c) => 'id' in c && c.id === id)
    if (col && typeof col.header === 'function') {
      const result = (col.header as () => string)()
      if (typeof result === 'string') return result
    }
    if (col && typeof col.header === 'string') return col.header
    return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }

  const renderSearchMode = () => (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Search bar + columns toggle */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder={t('concept_mapping.search_standard')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={handleSearch} disabled={searching}>
          {searching ? <Loader2 size={14} className="animate-spin" /> : t('common.search')}
        </Button>
        {/* Column visibility — moved to footer */}
      </div>

      {/* Results table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {searchResults.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 px-4">
            {searching ? (
              <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
            ) : !project.vocabularyDataSourceId && !dataSource ? (
              <>
                <p className="text-center text-xs text-muted-foreground">{t('concept_mapping.no_vocab_for_search_hint')}</p>
                {onGoToConceptSets && (
                  <button
                    type="button"
                    onClick={onGoToConceptSets}
                    className="text-xs text-primary underline-offset-2 hover:underline"
                  >
                    {t('concept_mapping.go_to_concept_sets')}
                  </button>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t('concept_mapping.search_hint')}</p>
            )}
          </div>
        ) : (
          <Table className="w-full" style={{ tableLayout: 'fixed' }}>
            <TableHeader>
              {/* Column titles */}
              <TableRow>
                {searchTable.getHeaderGroups().map((hg) =>
                  hg.headers.map((header) => {
                    const colId = header.column.id
                    const isSortable = colId !== '_check'
                    const sortIcon = !searchSorting || searchSorting.columnId !== colId
                      ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                      : searchSorting.desc
                        ? <ArrowDown size={10} className="shrink-0 text-primary" />
                        : <ArrowUp size={10} className="shrink-0 text-primary" />
                    return (
                    <TableHead
                      key={header.id}
                      className="relative select-none text-xs"
                      style={{ width: header.getSize() }}
                    >
                      {isSortable ? (
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-1 hover:text-foreground"
                          onClick={() => handleSearchSort(colId)}
                        >
                          <span className="truncate">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                          {sortIcon}
                        </button>
                      ) : (
                        <span className="truncate">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </span>
                      )}
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                          className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                        >
                          <div
                            className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${
                              header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40'
                            }`}
                          />
                        </div>
                      )}
                    </TableHead>
                    )
                  })
                )}
              </TableRow>
              {/* Inline column filters */}
              <TableRow className="hover:bg-transparent">
                {searchTable.getHeaderGroups().map((hg) =>
                  hg.headers.map((header) => (
                    <TableHead
                      key={`filter-${header.id}`}
                      className="px-1 py-1"
                      style={{ width: header.getSize() }}
                    >
                      {renderSearchColumnFilter(header.column.id)}
                    </TableHead>
                  ))
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {searchTable.getRowModel().rows.map((row) => {
                const alreadyMapped = sourceConcept
                  ? existingMappings.some((m) => m.targetConceptId === row.original.concept_id)
                  : false
                const isSelected = selectedTarget?.conceptId === row.original.concept_id
                return (
                  <TableRow
                    key={row.original.concept_id}
                    className={`cursor-pointer ${isSelected ? 'bg-accent' : ''} ${alreadyMapped ? 'opacity-50' : ''}`}
                    onClick={() => {
                      if (!alreadyMapped && sourceConcept) {
                        setSelectedTarget(isSelected ? null : {
                          conceptId: row.original.concept_id,
                          conceptName: row.original.concept_name,
                          vocabularyId: row.original.vocabulary_id,
                          domainId: row.original.domain_id ?? '',
                          conceptCode: row.original.concept_code,
                        })
                      }
                    }}
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
        )}
      </div>

      {/* Pagination + column visibility */}
      {searchResults.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              {filteredSearchResults.length} / {searchResults.length} {t('common.results').toLowerCase()}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                  <Settings2 size={12} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[180px]">
                <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {searchTable.getAllColumns()
                  .filter((col) => !col.id.startsWith('_'))
                  .map((col) => (
                    <DropdownMenuCheckboxItem
                      key={col.id}
                      checked={col.getIsVisible()}
                      onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                      onSelect={(e) => e.preventDefault()}
                      className="text-xs"
                    >
                      {getSearchColLabel(col.id)}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" disabled={searchPage === 0} onClick={() => setSearchPage(searchPage - 1)}>
              <ChevronLeft size={14} />
            </Button>
            <span className="text-[10px] text-muted-foreground">
              {searchPage + 1} / {searchTotalPages}
            </span>
            <Button variant="ghost" size="icon-sm" disabled={searchPage >= searchTotalPages - 1} onClick={() => setSearchPage(searchPage + 1)}>
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  )

  // ─── Main layout (always show tabs) ──────────────────────────────────

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Mode toggle + add mapping button */}
      <div className="relative flex items-center justify-center border-b px-3 py-1 gap-2">
        <div className="flex rounded-md bg-muted p-0.5">
          <button
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              browseMode === 'concept_sets'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setBrowseMode('concept_sets'); setSelectedTarget(null) }}
          >
            {t('concept_mapping.mode_concept_sets')}
          </button>
          <button
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              browseMode === 'search'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setBrowseMode('search'); setSelectedTarget(null) }}
          >
            {t('concept_mapping.mode_search')}
          </button>
        </div>

        {/* Split add-mapping button (only when a source concept is selected) */}
        {sourceConcept && (
          <div className="absolute right-3 flex items-center">
            {selectedTarget ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 rounded-r-none gap-1 px-2 text-[10px]"
                  onClick={() => handleAddSelectedMapping('skos:exactMatch')}
                >
                  <Plus size={10} />
                  {t('concept_mapping.skos_exact_match_short')}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 rounded-l-none border-l px-1"
                    >
                      <ChevronDown size={10} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[180px]">
                    <DropdownMenuItem onClick={() => handleAddSelectedMapping('skos:exactMatch')}>
                      <span className="text-xs">{t('concept_mapping.skos_exact_match')}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleAddSelectedMapping('skos:closeMatch')}>
                      <span className="text-xs">{t('concept_mapping.skos_close_match')}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleAddSelectedMapping('skos:broadMatch')}>
                      <span className="text-xs">{t('concept_mapping.skos_broad_match')}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleAddSelectedMapping('skos:narrowMatch')}>
                      <span className="text-xs">{t('concept_mapping.skos_narrow_match')}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleAddSelectedMapping('skos:relatedMatch')}>
                      <span className="text-xs">{t('concept_mapping.skos_related_match')}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {/* Map with comment button */}
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-1.5 h-6 gap-1 px-1.5 text-[10px]"
                  title={t('concept_mapping.map_with_comment')}
                  onClick={() => setCommentDialogOpen(true)}
                >
                  <MessageSquare size={10} />
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant={ignoredConceptIds.has(sourceConcept.concept_id) ? 'default' : 'outline'}
                  className={`h-6 gap-1 px-2 text-[10px] ${ignoredConceptIds.has(sourceConcept.concept_id) ? 'bg-gray-500 hover:bg-gray-600' : ''}`}
                  onClick={() => handleToggleIgnored()}
                >
                  <EyeOff size={10} />
                  {ignoredConceptIds.has(sourceConcept.concept_id)
                    ? t('concept_mapping.unignore')
                    : t('concept_mapping.ignore')}
                </Button>
                {!ignoredConceptIds.has(sourceConcept.concept_id) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-1.5 h-6 gap-1 px-1.5 text-[10px]"
                    title={t('concept_mapping.ignore_with_comment')}
                    onClick={() => setIgnoreDialogOpen(true)}
                  >
                    <MessageSquare size={10} />
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Mode content */}
      <div className="flex-1 overflow-hidden">
        {browseMode === 'concept_sets' ? (
          selectedCs ? renderResolvedConcepts() : renderConceptSetsBrowse()
        ) : (
          renderSearchMode()
        )}
      </div>

      {/* "Map with comment" dialog */}
      <Dialog open={commentDialogOpen} onOpenChange={setCommentDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">{t('concept_mapping.map_with_comment')}</DialogTitle>
          </DialogHeader>
          {selectedTarget && (
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium">{selectedTarget.conceptName}</p>
                <div className="mt-1 flex gap-1">
                  <Badge variant="outline" className="text-[10px]">ID: {selectedTarget.conceptId}</Badge>
                  <Badge variant="outline" className="text-[10px]">{selectedTarget.vocabularyId}</Badge>
                </div>
              </div>
              <div>
                <p className="mb-1 text-[10px] text-muted-foreground">{t('concept_mapping.equivalence')}</p>
                <Select value={commentEquivalence} onValueChange={(v) => setCommentEquivalence(v as MappingEquivalence)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skos:exactMatch">{t('concept_mapping.skos_exact_match')}</SelectItem>
                    <SelectItem value="skos:closeMatch">{t('concept_mapping.skos_close_match')}</SelectItem>
                    <SelectItem value="skos:broadMatch">{t('concept_mapping.skos_broad_match')}</SelectItem>
                    <SelectItem value="skos:narrowMatch">{t('concept_mapping.skos_narrow_match')}</SelectItem>
                    <SelectItem value="skos:relatedMatch">{t('concept_mapping.skos_related_match')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="mb-1 text-[10px] text-muted-foreground">{t('concept_mapping.comment_placeholder')}</p>
                <Textarea
                  className="text-xs"
                  rows={3}
                  placeholder={t('concept_mapping.comment_placeholder')}
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCommentDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleCommentDialogSubmit}>
              {t('concept_mapping.save_mapping')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* "Ignore with comment" dialog */}
      <Dialog open={ignoreDialogOpen} onOpenChange={setIgnoreDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">{t('concept_mapping.ignore_with_comment')}</DialogTitle>
          </DialogHeader>
          {sourceConcept && (
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium">{sourceConcept.concept_name}</p>
                <div className="mt-1 flex gap-1">
                  {sourceConcept.concept_code && (
                    <Badge variant="outline" className="text-[10px]">{sourceConcept.concept_code}</Badge>
                  )}
                  {sourceConcept.vocabulary_id && (
                    <Badge variant="outline" className="text-[10px]">{sourceConcept.vocabulary_id}</Badge>
                  )}
                </div>
              </div>
              <div>
                <p className="mb-1 text-[10px] text-muted-foreground">{t('concept_mapping.comment_placeholder')}</p>
                <Textarea
                  className="text-xs"
                  rows={3}
                  placeholder={t('concept_mapping.comment_placeholder')}
                  value={ignoreCommentText}
                  onChange={(e) => setIgnoreCommentText(e.target.value)}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setIgnoreDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleIgnoreDialogSubmit}>
              <EyeOff size={12} className="mr-1" />
              {t('concept_mapping.ignore')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Concept set detail sheet */}
      <ConceptSetDetailSheet
        conceptSet={detailSheetCs}
        open={detailSheetOpen}
        onOpenChange={setDetailSheetOpen}
      />
    </div>
  )
}
