import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import { Search, Plus, Check, ArrowLeft, Loader2, ChevronLeft, ChevronRight, ChevronDown, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
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
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { MappingProject, DataSource, MappingType, MappingEquivalence, ConceptSet, ResolvedConcept } from '@/types'
import type { SourceConceptRow } from '../MappingEditorTab'

interface TargetConceptPanelProps {
  project: MappingProject
  dataSource?: DataSource
  sourceConcept: SourceConceptRow | null
}

interface SearchResult {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
  domain_id?: string
}

/** Derive the resolved concept set URL from the source URL. */
function getResolvedUrl(sourceUrl?: string): string | null {
  if (!sourceUrl) return null
  if (!sourceUrl.includes('/concept_sets/')) return null
  return sourceUrl.replace('/concept_sets/', '/concept_sets_resolved/')
}

const CS_PAGE_SIZE = 50
const RESOLVED_PAGE_SIZE = 50

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

export function TargetConceptPanel({ project, dataSource, sourceConcept }: TargetConceptPanelProps) {
  const { t } = useTranslation()
  const { mappings, conceptSets, createMapping } = useConceptMappingStore()
  const allDataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  // Search for mapping
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [addingTarget, setAddingTarget] = useState<SearchResult | null>(null)
  const [mappingType, setMappingType] = useState<MappingType>('maps_to')
  const [equivalence, setEquivalence] = useState<MappingEquivalence>('skos:exactMatch')
  const [comment, setComment] = useState('')

  // Browse mode state
  const [catalogFilter, setCatalogFilter] = useState<string>('__all__')
  const [csFilterCategory, setCsFilterCategory] = useState('')
  const [csFilterSubcategory, setCsFilterSubcategory] = useState('')
  const [csFilterName, setCsFilterName] = useState('')
  const [csPage, setCsPage] = useState(0)

  // Selected concept set for resolved view
  const [selectedCs, setSelectedCs] = useState<ConceptSet | null>(null)
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

  // Import batches for catalog dropdown
  const importBatches = project.importBatches ?? []

  // Existing mappings for selected source concept
  const existingMappings = sourceConcept
    ? mappings.filter((m) => m.sourceConceptId === sourceConcept.concept_id)
    : []

  // Compute unique catalog source names from import batches
  const catalogSources = importBatches.map((b) => b.sourceName).filter((v, i, a) => a.indexOf(v) === i).sort()

  // Filter concept sets by catalog and column filters
  const filteredCs = linkedSets.filter((cs) => {
    // Catalog filter: match by importBatchId
    if (catalogFilter !== '__all__') {
      const batchIds = importBatches.filter((b) => b.sourceName === catalogFilter).map((b) => b.id)
      if (!cs.importBatchId || !batchIds.includes(cs.importBatchId)) return false
    }
    if (csFilterCategory && !textMatch(cs.category ?? '', csFilterCategory)) return false
    if (csFilterSubcategory && !textMatch(cs.subcategory ?? '', csFilterSubcategory)) return false
    if (csFilterName && !textMatch(cs.name, csFilterName)) return false
    return true
  })

  const csTotalPages = Math.max(1, Math.ceil(filteredCs.length / CS_PAGE_SIZE))
  const csPageItems = filteredCs.slice(csPage * CS_PAGE_SIZE, (csPage + 1) * CS_PAGE_SIZE)

  // Reset cs page when filters change
  const prevFiltersRef = useRef({ catalogFilter, csFilterCategory, csFilterSubcategory, csFilterName })
  if (
    prevFiltersRef.current.catalogFilter !== catalogFilter ||
    prevFiltersRef.current.csFilterCategory !== csFilterCategory ||
    prevFiltersRef.current.csFilterSubcategory !== csFilterSubcategory ||
    prevFiltersRef.current.csFilterName !== csFilterName
  ) {
    prevFiltersRef.current = { catalogFilter, csFilterCategory, csFilterSubcategory, csFilterName }
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
    } catch (err) {
      console.error('Search failed:', err)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [searchTerm, dataSource, project.vocabularyDataSourceId, allDataSources, ensureMounted])

  const handleAddMapping = async () => {
    if (!addingTarget || !sourceConcept) return
    const now = new Date().toISOString()
    await createMapping({
      id: crypto.randomUUID(),
      projectId: project.id,
      sourceConceptId: sourceConcept.concept_id,
      sourceConceptName: sourceConcept.concept_name,
      sourceVocabularyId: sourceConcept.vocabulary_id,
      sourceDomainId: sourceConcept.domain_id ?? '',
      sourceConceptCode: sourceConcept.concept_code,
      sourceFrequency: sourceConcept.record_count,
      targetConceptId: addingTarget.concept_id,
      targetConceptName: addingTarget.concept_name,
      targetVocabularyId: addingTarget.vocabulary_id,
      targetDomainId: addingTarget.domain_id ?? '',
      targetConceptCode: addingTarget.concept_code,
      mappingType,
      equivalence,
      status: 'unchecked',
      comment,
      createdAt: now,
      updatedAt: now,
    })
    setAddingTarget(null)
    setComment('')
    setSearchTerm('')
    setSearchResults([])
  }

  /** Add mapping from the selected target concept with a given predicate. */
  const handleAddSelectedMapping = async (predicate: MappingEquivalence = 'skos:exactMatch') => {
    if (!sourceConcept || !selectedTarget) return
    const alreadyMapped = existingMappings.some((m) => m.targetConceptId === selectedTarget.conceptId)
    if (alreadyMapped) return
    const now = new Date().toISOString()
    await createMapping({
      id: crypto.randomUUID(),
      projectId: project.id,
      sourceConceptId: sourceConcept.concept_id,
      sourceConceptName: sourceConcept.concept_name,
      sourceVocabularyId: sourceConcept.vocabulary_id,
      sourceDomainId: sourceConcept.domain_id ?? '',
      sourceConceptCode: sourceConcept.concept_code,
      sourceFrequency: sourceConcept.record_count,
      targetConceptId: selectedTarget.conceptId,
      targetConceptName: selectedTarget.conceptName,
      targetVocabularyId: selectedTarget.vocabularyId,
      targetDomainId: selectedTarget.domainId,
      targetConceptCode: selectedTarget.conceptCode,
      conceptSetId: selectedCs?.id,
      mappingType: 'maps_to',
      equivalence: predicate,
      status: 'unchecked',
      comment: '',
      createdAt: now,
      updatedAt: now,
    })
    setSelectedTarget(null)
  }

  // ─── Concept sets datatable (browse view) ───────────────────────────

  const renderConceptSetsBrowse = () => (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Catalog dropdown */}
      <div className="border-b px-3 py-2 space-y-2">
        {catalogSources.length > 0 && (
          <Select value={catalogFilter} onValueChange={setCatalogFilter}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('concept_mapping.browse_all_catalogs')}</SelectItem>
              {catalogSources.map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Table header with column filters */}
      <div className="grid grid-cols-[1fr_1fr_2fr] gap-0.5 border-b bg-muted/30 px-2 py-1">
        <div>
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
            {t('concept_mapping.col_category')}
          </p>
          <Input
            className="h-6 text-[10px] px-1.5"
            value={csFilterCategory}
            onChange={(e) => setCsFilterCategory(e.target.value)}
            placeholder="..."
          />
        </div>
        <div>
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
            {t('concept_mapping.col_subcategory')}
          </p>
          <Input
            className="h-6 text-[10px] px-1.5"
            value={csFilterSubcategory}
            onChange={(e) => setCsFilterSubcategory(e.target.value)}
            placeholder="..."
          />
        </div>
        <div>
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
            {t('concept_mapping.col_concept_set')}
          </p>
          <Input
            className="h-6 text-[10px] px-1.5"
            value={csFilterName}
            onChange={(e) => setCsFilterName(e.target.value)}
            placeholder="..."
          />
        </div>
      </div>

      {/* Table body */}
      <div className="flex-1 overflow-auto">
        {csPageItems.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-xs text-muted-foreground">{t('common.no_results')}</p>
          </div>
        ) : (
          csPageItems.map((cs) => (
            <button
              key={cs.id}
              className="grid w-full grid-cols-[1fr_1fr_2fr] gap-0.5 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/50 border-b border-border/40"
              onClick={() => handleSelectCs(cs)}
            >
              <span className="truncate text-muted-foreground">{cs.category ?? ''}</span>
              <span className="truncate text-muted-foreground">{cs.subcategory ?? ''}</span>
              <span className="truncate">{cs.name}</span>
            </button>
          ))
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <span className="text-[10px] text-muted-foreground">
          {filteredCs.length} concept sets
        </span>
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
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{selectedCs!.name}</p>
            <div className="flex gap-1 mt-0.5">
              {selectedCs!.category && (
                <Badge variant="outline" className="text-[9px]">{selectedCs!.category}</Badge>
              )}
              {selectedCs!.subcategory && (
                <Badge variant="outline" className="text-[9px]">{selectedCs!.subcategory}</Badge>
              )}
              <Badge variant="secondary" className="text-[9px]">
                {resolvedConcepts.length} {t('concept_mapping.cs_concepts')}
              </Badge>
            </div>
          </div>
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
  const [searchPage, setSearchPage] = useState(0)
  const SEARCH_PAGE_SIZE = 50

  const searchColumns = useMemo<ColumnDef<SearchResult>[]>(() => [
    {
      id: 'concept_id',
      header: 'ID',
      accessorFn: (row) => row.concept_id,
      cell: ({ row }) => <span className="font-mono">{row.original.concept_id}</span>,
      size: 70,
      minSize: 50,
      enableHiding: false,
    },
    {
      id: 'concept_name',
      header: () => t('concept_mapping.col_name'),
      accessorFn: (row) => row.concept_name,
      cell: ({ row }) => row.original.concept_name,
      size: 200,
      minSize: 100,
      enableHiding: false,
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
      id: '_add',
      header: '',
      cell: ({ row }) => (
        <button
          className="flex justify-center text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); setAddingTarget(row.original) }}
          title={t('concept_mapping.add_mapping')}
        >
          <Plus size={14} />
        </button>
      ),
      size: 32,
      minSize: 32,
      enableHiding: false,
      enableResizing: false,
    },
  ], [t])

  const searchPageItems = searchResults.slice(searchPage * SEARCH_PAGE_SIZE, (searchPage + 1) * SEARCH_PAGE_SIZE)
  const searchTotalPages = Math.max(1, Math.ceil(searchResults.length / SEARCH_PAGE_SIZE))

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
      {addingTarget ? (
        <div className="p-3">
          <Card className="p-3 space-y-3">
            <div>
              <p className="text-xs font-medium">{addingTarget.concept_name}</p>
              <div className="mt-1 flex gap-1">
                <Badge variant="outline" className="text-[10px]">ID: {addingTarget.concept_id}</Badge>
                <Badge variant="outline" className="text-[10px]">{addingTarget.vocabulary_id}</Badge>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="mb-1 text-[10px] text-muted-foreground">{t('concept_mapping.mapping_type')}</p>
                <Select value={mappingType} onValueChange={(v) => setMappingType(v as MappingType)}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="maps_to">Maps to</SelectItem>
                    <SelectItem value="maps_to_value">Maps to value</SelectItem>
                    <SelectItem value="maps_to_unit">Maps to unit</SelectItem>
                    <SelectItem value="maps_to_operator">Maps to operator</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="mb-1 text-[10px] text-muted-foreground">{t('concept_mapping.equivalence')}</p>
                <Select value={equivalence} onValueChange={(v) => setEquivalence(v as MappingEquivalence)}>
                  <SelectTrigger className="h-7 text-xs">
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
            </div>
            <Textarea
              className="text-xs"
              rows={2}
              placeholder={t('concept_mapping.comment_placeholder')}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAddMapping}>{t('concept_mapping.save_mapping')}</Button>
              <Button size="sm" variant="outline" onClick={() => setAddingTarget(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </Card>
        </div>
      ) : (
        <>
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs shrink-0">
                  <Settings2 size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[180px]">
                <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {searchTable.getAllColumns()
                  .filter((col) => col.getCanHide())
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

          {/* Results table */}
          <div className="min-h-0 flex-1 overflow-auto">
            {searchResults.length === 0 ? (
              <div className="flex h-32 items-center justify-center">
                <p className="text-xs text-muted-foreground">
                  {searching ? t('common.loading') : t('concept_mapping.search_hint')}
                </p>
              </div>
            ) : (
              <Table className="w-full" style={{ tableLayout: 'fixed' }}>
                <TableHeader>
                  <TableRow>
                    {searchTable.getHeaderGroups().map((hg) =>
                      hg.headers.map((header) => (
                        <TableHead
                          key={header.id}
                          className="relative select-none text-xs"
                          style={{ width: header.getSize() }}
                        >
                          <span className="truncate">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
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
                      ))
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {searchTable.getRowModel().rows.map((row) => (
                    <TableRow key={row.original.concept_id} className="cursor-pointer" onClick={() => setAddingTarget(row.original)}>
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
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          {/* Pagination */}
          {searchResults.length > 0 && (
            <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5">
              <span className="text-[10px] text-muted-foreground">
                {searchResults.length} {t('common.results').toLowerCase()}
              </span>
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
        </>
      )}
    </div>
  )

  // ─── When no source concept selected: browse view ───────────────────

  if (!sourceConcept) {
    return selectedCs ? renderResolvedConcepts() : renderConceptSetsBrowse()
  }

  // ─── With source concept selected ───────────────────────────────────

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Mode toggle + add mapping button */}
      <div className="flex items-center justify-between border-b px-3 py-1 gap-2">
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

        {/* Split add-mapping button */}
        <div className="flex items-center">
          <Button
            size="sm"
            className="h-6 rounded-r-none gap-1 px-2 text-[10px]"
            disabled={!selectedTarget}
            onClick={() => handleAddSelectedMapping('skos:exactMatch')}
          >
            <Plus size={10} />
            {t('concept_mapping.skos_exact_match_short')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="h-6 rounded-l-none border-l border-primary-foreground/20 px-1"
                disabled={!selectedTarget}
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
        </div>
      </div>

      {/* Mode content */}
      <div className="flex-1 overflow-hidden">
        {browseMode === 'concept_sets' ? (
          selectedCs ? renderResolvedConcepts() : renderConceptSetsBrowse()
        ) : (
          renderSearchMode()
        )}
      </div>
    </div>
  )
}
