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
  Plus, BookOpen, Trash2, RefreshCw, Upload, Search, Loader2,
  Info, Check, CheckCheck, X, History, FolderOpen, CheckCircle2, ChevronLeft, ChevronRight, Pencil, SquareX,
  ArrowUpDown, ArrowUp, ArrowDown, Settings2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { escSql } from '@/lib/format-helpers'
import { ImportConceptSetDialog, extractMetadata, extractTranslations } from './ImportConceptSetDialog'
import { ConceptSetDetailSheet } from './ConceptSetDetailSheet'
import type { MappingProject, DataSource, ConceptSet, SchemaMapping, SchemaPresetId } from '@/types'
import { getConceptSetI18n } from '@/lib/concept-mapping/i18n'

// ---------------------------------------------------------------------------
// ATHENA vocabulary schema mapping
// ---------------------------------------------------------------------------

const ATHENA_KNOWN_TABLES = [
  'concept', 'concept_ancestor', 'concept_class', 'concept_relationship',
  'concept_synonym', 'domain', 'drug_strength', 'relationship', 'vocabulary',
]

const ATHENA_SCHEMA_MAPPING: SchemaMapping = {
  presetId: 'omop-cdm-5.4' as SchemaPresetId,
  presetLabel: 'ATHENA Vocabulary',
  conceptTables: [{
    key: 'concept',
    table: 'concept',
    idColumn: 'concept_id',
    nameColumn: 'concept_name',
    codeColumn: 'concept_code',
    vocabularyColumn: 'vocabulary_id',
    extraColumns: {
      domain_id: 'domain_id',
      concept_class_id: 'concept_class_id',
      standard_concept: 'standard_concept',
    },
  }],
  knownTables: ATHENA_KNOWN_TABLES,
}

/** Check if a file is an ATHENA vocabulary file (CSV, TSV, or Parquet). */
function isVocabFile(name: string): boolean {
  const lower = name.toLowerCase()
  const base = lower.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  return ATHENA_KNOWN_TABLES.includes(base)
}

/** Check if a file is the required CONCEPT table. */
function isConceptFile(name: string): boolean {
  const lower = name.toLowerCase()
  const base = lower.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  return base === 'concept'
}

const BROWSE_PAGE_SIZE = 25

const FILTER_INPUT_CLASS = 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

interface CsSorting {
  columnId: string
  desc: boolean
}

function SortIndicator({ columnId, sorting }: { columnId: string; sorting: CsSorting | null }) {
  if (!sorting || sorting.columnId !== columnId) {
    return <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
  }
  if (sorting.desc) {
    return <ArrowDown size={10} className="shrink-0 text-primary" />
  }
  return <ArrowUp size={10} className="shrink-0 text-primary" />
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
  raw: ConceptSet
}

interface ConceptSetsTabProps {
  project: MappingProject
  dataSource?: DataSource
}

export function ConceptSetsTab({ project }: ConceptSetsTabProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { conceptSets, deleteConceptSetsBatch, updateMappingProject, updateConceptSet } = useConceptMappingStore()

  const [importOpen, setImportOpen] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  // Detail sheet
  const [detailConceptSet, setDetailConceptSet] = useState<ConceptSet | null>(null)

  // Bulk selection (edit mode)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  // Batch delete
  const [batchToDelete, setBatchToDelete] = useState<string | null>(null)

  // Import history
  const [historyOpen, setHistoryOpen] = useState(false)

  // Update all state
  const [updateAllRunning, setUpdateAllRunning] = useState(false)
  const [updateAllResult, setUpdateAllResult] = useState<{ updated: number; total: number } | null>(null)

  // Vocabulary reference import
  const vocabInputRef = useRef<HTMLInputElement>(null)
  const [vocabFiles, setVocabFiles] = useState<File[]>([])
  const [vocabImporting, setVocabImporting] = useState(false)
  const [vocabError, setVocabError] = useState<string | null>(null)
  const [vocabRemoveOpen, setVocabRemoveOpen] = useState(false)
  const addDataSource = useDataSourceStore((s) => s.addDataSource)
  const removeDataSource = useDataSourceStore((s) => s.removeDataSource)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  // Browse vocabulary state
  const [browseSearch, setBrowseSearch] = useState('')
  const [browseVocab, setBrowseVocab] = useState<string>('__all__')
  const [browseDomain, setBrowseDomain] = useState<string>('__all__')
  const [browseStandardOnly, setBrowseStandardOnly] = useState(false)
  const [browseResults, setBrowseResults] = useState<Record<string, unknown>[]>([])
  const [browseTotal, setBrowseTotal] = useState(0)
  const [browsePage, setBrowsePage] = useState(0)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseVocabOptions, setBrowseVocabOptions] = useState<string[]>([])
  const [browseDomainOptions, setBrowseDomainOptions] = useState<string[]>([])

  // Inline column filters
  const [filterCategory, setFilterCategory] = useState('')
  const [filterSubcategory, setFilterSubcategory] = useState('')
  const [filterName, setFilterName] = useState('')
  const [filterVersion, setFilterVersion] = useState('')
  const [filterProvenance, setFilterProvenance] = useState('')

  // TanStack table state
  const [csSorting, setCsSorting] = useState<CsSorting | null>(null)
  const [csColVisibility, setCsColVisibility] = useState<VisibilityState>({})
  const [csColSizing, setCsColSizing] = useState<Record<string, number>>({})

  // Pagination
  const CS_PAGE_SIZE = 25
  const [csPage, setCsPage] = useState(0)

  const linkedSets = conceptSets.filter((cs) => project.conceptSetIds.includes(cs.id))

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

  // Build translated rows for the table
  const csRows = useMemo<CsRow[]>(() => {
    return linkedSets.map((cs) => {
      const tr = getConceptSetI18n(cs, lang)
      return {
        id: cs.id,
        category: tr.category ?? '',
        subcategory: tr.subcategory ?? '',
        name: tr.name,
        description: tr.description ?? '',
        items: cs.expression.items.length,
        version: cs.version ?? '',
        provenance: cs.provenance ?? '',
        raw: cs,
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedSets, lang])

  // Apply inline column filters
  const filteredRows = useMemo(() => {
    return csRows.filter((r) => {
      if (filterCategory && r.category !== filterCategory) return false
      if (filterSubcategory && r.subcategory !== filterSubcategory) return false
      if (filterName && !textMatch(r.name.toLowerCase(), filterName.toLowerCase())) return false
      if (filterVersion && !r.version.toLowerCase().includes(filterVersion.toLowerCase())) return false
      if (filterProvenance && r.provenance !== filterProvenance) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csRows, filterCategory, filterSubcategory, filterName, filterVersion, filterProvenance])

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
  const prevFiltersRef = useRef({ filterCategory, filterSubcategory, filterName, filterVersion, filterProvenance })
  if (
    prevFiltersRef.current.filterCategory !== filterCategory ||
    prevFiltersRef.current.filterSubcategory !== filterSubcategory ||
    prevFiltersRef.current.filterName !== filterName ||
    prevFiltersRef.current.filterVersion !== filterVersion ||
    prevFiltersRef.current.filterProvenance !== filterProvenance
  ) {
    prevFiltersRef.current = { filterCategory, filterSubcategory, filterName, filterVersion, filterProvenance }
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
          <div>
            <div className="truncate font-medium">{row.original.name}</div>
            {row.original.description && (
              <div className="truncate text-[10px] text-muted-foreground mt-0.5">{row.original.description}</div>
            )}
          </div>
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
            <Badge variant="secondary" className="text-[10px]">{row.original.items}</Badge>
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

  /** Get human-readable label for a column def. */
  const getCsColLabel = (id: string): string => {
    const def = csColumns.find((c) => 'id' in c && c.id === id)
    if (def && typeof def.header === 'function') {
      const result = (def.header as () => unknown)()
      if (typeof result === 'string') return result
    }
    return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }

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
    const ids = [...selectedIds]
    await updateMappingProject(project.id, {
      conceptSetIds: project.conceptSetIds.filter((id) => !selectedIds.has(id)),
    })
    await deleteConceptSetsBatch(ids)
    setSelectedIds(new Set())
    setSelectionMode(false)
    setBulkDeleteOpen(false)
  }

  const handleDeleteBatch = async () => {
    if (!batchToDelete) return
    const batchCsIds = linkedSets.filter((cs) => cs.importBatchId === batchToDelete).map((cs) => cs.id)
    if (batchCsIds.length > 0) {
      const batchIdSet = new Set(batchCsIds)
      await updateMappingProject(project.id, {
        conceptSetIds: project.conceptSetIds.filter((id) => !batchIdSet.has(id)),
        importBatches: (project.importBatches ?? []).filter((b) => b.id !== batchToDelete),
      })
      await deleteConceptSetsBatch(batchCsIds)
    } else {
      // No concept sets left but batch record exists — just remove the batch record
      await updateMappingProject(project.id, {
        importBatches: (project.importBatches ?? []).filter((b) => b.id !== batchToDelete),
      })
    }
    setBatchToDelete(null)
  }

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }

  /** Update a concept set from its remote source URL. */
  const handleUpdateFromRemote = async (cs: ConceptSet) => {
    if (!cs.sourceUrl) return
    setUpdatingId(cs.id)
    try {
      const resp = await fetch(cs.sourceUrl)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()

      const obj = json as Record<string, unknown>
      if (!obj.expression || typeof obj.expression !== 'object') return
      const expr = obj.expression as Record<string, unknown>
      if (!Array.isArray(expr.items)) return

      const curLang = lang.substring(0, 2)
      const meta = obj.metadata as Record<string, unknown> | undefined
      const rawTranslations = meta?.translations as Record<string, Record<string, string>> | undefined
      const tr = rawTranslations?.[curLang] ?? rawTranslations?.en
      const md = extractMetadata(obj, curLang)
      const translations = extractTranslations(obj)

      await updateConceptSet(cs.id, {
        name: tr?.name ?? String(obj.name ?? cs.name),
        description: tr?.description ?? (obj.description ? String(obj.description) : cs.description),
        expression: { items: expr.items as ConceptSet['expression']['items'] },
        category: md.category ?? cs.category,
        subcategory: md.subcategory ?? cs.subcategory,
        provenance: md.provenance ?? cs.provenance,
        version: md.version ?? cs.version,
        translations,
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      console.error('Failed to update concept set from remote:', err)
    } finally {
      setUpdatingId(null)
    }
  }

  /** Update all concept sets that have a sourceUrl. */
  const handleUpdateAll = async () => {
    const updatable = linkedSets.filter((cs) => cs.sourceUrl)
    if (updatable.length === 0) return
    setUpdateAllRunning(true)
    let updated = 0
    for (const cs of updatable) {
      try {
        await handleUpdateFromRemote(cs)
        updated++
      } catch { /* skip failed */ }
    }
    setUpdateAllRunning(false)
    setUpdateAllResult({ updated, total: updatable.length })
  }

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    } catch {
      return iso
    }
  }

  // --- Vocabulary import ---

  const handleVocabFilesSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    const vocabOnly = files.filter((f) => isVocabFile(f.name))
    setVocabFiles(vocabOnly)
    setVocabError(null)
  }

  const handleVocabImport = async () => {
    if (vocabFiles.length === 0) return
    if (!vocabFiles.some((f) => isConceptFile(f.name))) {
      setVocabError(t('concept_mapping.vocab_import_missing_concept'))
      return
    }
    setVocabImporting(true)
    setVocabError(null)
    try {
      const dsId = await addDataSource({
        name: `ATHENA Vocabulary — ${project.name}`,
        description: 'OHDSI ATHENA vocabulary reference for concept mapping.',
        sourceType: 'database',
        connectionConfig: { engine: 'duckdb' as const },
        schemaMapping: ATHENA_SCHEMA_MAPPING,
        files: vocabFiles,
        isVocabularyReference: true,
      })
      await updateMappingProject(project.id, { vocabularyDataSourceId: dsId })
      setVocabFiles([])
      if (vocabInputRef.current) vocabInputRef.current.value = ''
    } catch (err) {
      console.error('Failed to import vocabulary:', err)
      setVocabError(err instanceof Error ? err.message : String(err))
    } finally {
      setVocabImporting(false)
    }
  }

  const handleVocabRemove = async () => {
    if (!project.vocabularyDataSourceId) return
    try {
      await removeDataSource(project.vocabularyDataSourceId)
    } catch { /* might already be deleted */ }
    await updateMappingProject(project.id, { vocabularyDataSourceId: undefined })
    setVocabRemoveOpen(false)
    setBrowseResults([])
    setBrowseVocabOptions([])
    setBrowseDomainOptions([])
  }

  const vocabDs = project.vocabularyDataSourceId
    ? dataSources.find((ds) => ds.id === project.vocabularyDataSourceId)
    : null

  // --- Browse vocabulary queries ---

  // Load filter options when vocabulary is connected
  useEffect(() => {
    if (!project.vocabularyDataSourceId) return
    const load = async () => {
      try {
        await ensureMounted(project.vocabularyDataSourceId!)
        const vocabs = await queryDataSource(
          project.vocabularyDataSourceId!,
          `SELECT DISTINCT vocabulary_id AS val FROM concept ORDER BY vocabulary_id`,
        )
        setBrowseVocabOptions(vocabs.map((r) => String(r.val ?? '')).filter(Boolean))
        const domains = await queryDataSource(
          project.vocabularyDataSourceId!,
          `SELECT DISTINCT domain_id AS val FROM concept ORDER BY domain_id`,
        )
        setBrowseDomainOptions(domains.map((r) => String(r.val ?? '')).filter(Boolean))
      } catch (err) {
        console.error('Failed to load vocabulary filter options:', err)
      }
    }
    load()
  }, [project.vocabularyDataSourceId, ensureMounted])

  const loadBrowseResults = useCallback(async () => {
    if (!project.vocabularyDataSourceId) return
    setBrowseLoading(true)
    try {
      await ensureMounted(project.vocabularyDataSourceId)

      const conditions: string[] = []
      if (browseSearch.trim()) {
        const escaped = escSql(browseSearch.trim())
        conditions.push(`(concept_name ILIKE '%${escaped}%' OR concept_code ILIKE '%${escaped}%' OR CAST(concept_id AS VARCHAR) = '${escaped}')`)
      }
      if (browseVocab !== '__all__') {
        conditions.push(`vocabulary_id = '${escSql(browseVocab)}'`)
      }
      if (browseDomain !== '__all__') {
        conditions.push(`domain_id = '${escSql(browseDomain)}'`)
      }
      if (browseStandardOnly) {
        conditions.push(`standard_concept = 'S'`)
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      const [countResult] = await queryDataSource(
        project.vocabularyDataSourceId,
        `SELECT COUNT(*) AS total FROM concept ${where}`,
      )
      setBrowseTotal(Number(countResult?.total ?? 0))

      const rows = await queryDataSource(
        project.vocabularyDataSourceId,
        `SELECT concept_id, concept_name, concept_code, vocabulary_id, domain_id, concept_class_id, standard_concept
         FROM concept ${where}
         ORDER BY concept_name
         LIMIT ${BROWSE_PAGE_SIZE} OFFSET ${browsePage * BROWSE_PAGE_SIZE}`,
      )
      setBrowseResults(rows)
    } catch (err) {
      console.error('Browse vocabulary query failed:', err)
      setBrowseResults([])
    } finally {
      setBrowseLoading(false)
    }
  }, [project.vocabularyDataSourceId, browseSearch, browseVocab, browseDomain, browseStandardOnly, browsePage, ensureMounted])

  useEffect(() => {
    if (project.vocabularyDataSourceId) loadBrowseResults()
  }, [loadBrowseResults, project.vocabularyDataSourceId])

  // Reset page when browse filters change
  useEffect(() => {
    setBrowsePage(0)
  }, [browseSearch, browseVocab, browseDomain, browseStandardOnly])

  const browseTotalPages = Math.max(1, Math.ceil(browseTotal / BROWSE_PAGE_SIZE))

  const importBatches = project.importBatches ?? []

  return (
    <div className="h-full overflow-auto p-4">
      <Tabs defaultValue="concept-sets">
        <div className="flex justify-center">
          <TabsList className="w-fit">
            <TabsTrigger value="concept-sets">{t('concept_mapping.cs_project_sets')}</TabsTrigger>
            <TabsTrigger value="vocabulary">{t('concept_mapping.cs_vocabulary_ref')}</TabsTrigger>
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
                    {linkedSets.some((cs) => cs.sourceUrl) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleUpdateAll}
                        disabled={updateAllRunning}
                      >
                        {updateAllRunning ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                        {t('concept_mapping.cs_update_all')}
                      </Button>
                    )}
                    {selectionMode ? (
                      <Button size="sm" variant="outline" onClick={exitSelectionMode}>
                        <X size={14} />
                        {t('concept_mapping.cs_exit_selection')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setSelectionMode(true)}>
                        <Pencil size={14} />
                        {t('concept_mapping.cs_edit')}
                      </Button>
                    )}
                  </>
                )}
                <Button size="sm" onClick={() => setImportOpen(true)}>
                  <Plus size={14} />
                  {t('concept_mapping.cs_add')}
                </Button>
              </div>
            </div>

            {/* Import History */}
            {importBatches.length > 0 && (
              <Collapsible open={historyOpen} onOpenChange={setHistoryOpen} className="mb-3">
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground">
                    <History size={12} />
                    {t('concept_mapping.cs_import_history')} ({importBatches.length})
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 space-y-2">
                  {importBatches.map((batch) => (
                    <div key={batch.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{batch.sourceName}</span>
                          <Badge variant="secondary" className="text-[10px]">
                            {batch.count} {t('concept_mapping.cs_concepts')}
                          </Badge>
                        </div>
                        <p className="text-[10px] text-muted-foreground">{formatDate(batch.importedAt)}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive"
                        title={t('concept_mapping.cs_delete_batch')}
                        onClick={() => setBatchToDelete(batch.id)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}

            {/* Edit mode toolbar */}
            {selectionMode && filteredSets.length > 0 && (
              <div className="mb-3 flex items-center gap-3">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => {
                  if (selectedIds.size === filteredSets.length) setSelectedIds(new Set())
                  else setSelectedIds(new Set(filteredSets.map((cs) => cs.id)))
                }}>
                  <CheckCheck size={12} />
                  {t('concept_mapping.cs_select_all')}
                </Button>
                {selectedIds.size > 0 && (
                  <>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setSelectedIds(new Set())}>
                      <SquareX size={12} />
                      {t('concept_mapping.cs_deselect_all')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setBulkDeleteOpen(true)}
                    >
                      <Trash2 size={12} />
                      {t('concept_mapping.cs_delete_selected', { count: selectedIds.size })}
                    </Button>
                  </>
                )}
              </div>
            )}

            {/* DataTable content */}
            {linkedSets.length === 0 ? (
              <Card>
                <div className="flex flex-col items-center py-10">
                  <BookOpen size={32} className="text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {t('concept_mapping.cs_empty')}
                  </p>
                </div>
              </Card>
            ) : filteredSets.length === 0 ? (
              <Card>
                <div className="flex flex-col items-center py-10">
                  <Search size={32} className="text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {t('common.no_results')}
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
                                className="relative select-none text-xs"
                                style={{ width: header.getSize() }}
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
                                    className="flex min-w-0 items-center gap-1 hover:text-foreground"
                                    onClick={() => handleCsSort(colId)}
                                  >
                                    <span className="truncate">
                                      {flexRender(header.column.columnDef.header, header.getContext())}
                                    </span>
                                    <SortIndicator columnId={colId} sorting={csSorting} />
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
                      {csPageItems.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={csTable.getVisibleLeafColumns().length} className="h-24 text-center text-sm text-muted-foreground">
                            {t('common.no_results')}
                          </TableCell>
                        </TableRow>
                      ) : (
                        csTable.getRowModel().rows.map((row) => {
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
                        })
                      )}
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
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{t('concept_mapping.vocab_import_success')}</span>
                        <span className="text-xs text-muted-foreground">{vocabDs.name}</span>
                        {vocabDs.stats?.tableCount != null && (
                          <Badge variant="secondary" className="text-[10px]">
                            {t('concept_mapping.vocab_import_tables_found', { count: vocabDs.stats.tableCount })}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t('concept_mapping.vocab_import_remove')}
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          setVocabFiles([])
                          setVocabError(null)
                          setVocabRemoveOpen(true)
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                </Card>

                {/* Browse vocabulary */}
                <div className="space-y-3">
                  {/* Search + filters */}
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[200px] flex-1">
                      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        className="h-8 pl-8 text-xs"
                        placeholder={t('concept_mapping.vocab_browse_search')}
                        value={browseSearch}
                        onChange={(e) => setBrowseSearch(e.target.value)}
                      />
                    </div>
                    {browseVocabOptions.length > 0 && (
                      <Select value={browseVocab} onValueChange={setBrowseVocab}>
                        <SelectTrigger className="h-8 w-[160px] text-xs">
                          <SelectValue placeholder={t('concept_mapping.vocab_browse_filter_vocab')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__all__">{t('concept_mapping.vocab_browse_all_vocabs')}</SelectItem>
                          {browseVocabOptions.map((v) => (
                            <SelectItem key={v} value={v}>{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {browseDomainOptions.length > 0 && (
                      <Select value={browseDomain} onValueChange={setBrowseDomain}>
                        <SelectTrigger className="h-8 w-[140px] text-xs">
                          <SelectValue placeholder={t('concept_mapping.vocab_browse_filter_domain')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__all__">{t('concept_mapping.vocab_browse_all_domains')}</SelectItem>
                          {browseDomainOptions.map((d) => (
                            <SelectItem key={d} value={d}>{d}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Button
                      variant={browseStandardOnly ? 'default' : 'outline'}
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => setBrowseStandardOnly(!browseStandardOnly)}
                    >
                      {t('concept_mapping.vocab_browse_standard_only')}
                    </Button>
                  </div>

                  {/* Results table */}
                  <Card className="overflow-hidden">
                    {/* Header */}
                    <div className="grid grid-cols-[60px_1fr_100px_100px_100px_80px] items-center gap-1 border-b bg-muted/30 px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      <span>ID</span>
                      <span>{t('concept_mapping.col_name')}</span>
                      <span>Code</span>
                      <span>{t('concept_mapping.col_vocab')}</span>
                      <span>{t('concept_mapping.col_domain')}</span>
                      <span>{t('concept_mapping.col_concept_class')}</span>
                    </div>

                    {/* Body */}
                    <div>
                      {browseLoading ? (
                        <div className="flex h-32 items-center justify-center">
                          <Loader2 size={16} className="animate-spin text-muted-foreground" />
                        </div>
                      ) : browseResults.length === 0 ? (
                        <div className="flex h-32 items-center justify-center">
                          <p className="text-xs text-muted-foreground">{t('common.no_results')}</p>
                        </div>
                      ) : (
                        browseResults.map((row) => (
                          <div
                            key={String(row.concept_id)}
                            className="grid grid-cols-[60px_1fr_100px_100px_100px_80px] items-center gap-1 border-b border-border/40 px-3 py-1.5 text-xs hover:bg-accent/30"
                          >
                            <span className="text-muted-foreground">{String(row.concept_id)}</span>
                            <span className="truncate" title={String(row.concept_name)}>{String(row.concept_name)}</span>
                            <span className="truncate text-muted-foreground">{String(row.concept_code ?? '')}</span>
                            <span className="truncate text-muted-foreground">{String(row.vocabulary_id ?? '')}</span>
                            <span className="truncate text-muted-foreground">{String(row.domain_id ?? '')}</span>
                            <span className="truncate text-muted-foreground">{String(row.concept_class_id ?? '')}</span>
                          </div>
                        ))
                      )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between border-t px-3 py-1.5">
                      <span className="text-[10px] text-muted-foreground">
                        {browseTotal.toLocaleString()} {t('concept_mapping.total_concepts')}
                      </span>
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
                  </Card>
                </div>
              </>
            ) : (
              /* No vocabulary — show import UI */
              <Card className="p-6">
                <div className="flex flex-col items-center">
                  <Upload size={32} className="text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">{t('concept_mapping.vocab_ref_title')}</p>
                  <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                    {t('concept_mapping.vocab_import_hint')}
                  </p>

                  {/* File list preview */}
                  {vocabFiles.length > 0 && (
                    <div className="mt-4 w-full max-w-sm rounded-md border p-3">
                      <p className="mb-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        {t('concept_mapping.vocab_import_tables_found', { count: vocabFiles.length })}
                      </p>
                      <div className="space-y-1">
                        {vocabFiles.map((f) => {
                          const base = f.name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase()
                          return (
                            <div key={f.name} className="flex items-center gap-2 text-xs">
                              <span className="truncate flex-1">{f.name}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {(f.size / 1024 / 1024).toFixed(1)} MB
                              </span>
                              {base === 'concept' && (
                                <Badge variant="secondary" className="text-[9px]">
                                  {t('concept_mapping.vocab_import_required')}
                                </Badge>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {vocabError && (
                    <p className="mt-3 text-xs text-destructive">{vocabError}</p>
                  )}

                  <div className="mt-4 flex gap-2">
                    <input
                      ref={vocabInputRef}
                      type="file"
                      className="hidden"
                      multiple
                      accept=".csv,.tsv,.parquet"
                      onChange={handleVocabFilesSelect}
                      /* @ts-expect-error webkitdirectory is non-standard */
                      webkitdirectory=""
                    />
                    <Button
                      variant="outline"
                      onClick={() => vocabInputRef.current?.click()}
                      disabled={vocabImporting}
                    >
                      <FolderOpen size={14} />
                      {t('concept_mapping.vocab_import_select_folder')}
                    </Button>
                    <Button
                      onClick={handleVocabImport}
                      disabled={vocabFiles.length === 0 || vocabImporting}
                    >
                      {vocabImporting ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Upload size={14} />
                      )}
                      {vocabImporting
                        ? t('concept_mapping.vocab_import_importing')
                        : t('concept_mapping.vocab_import_athena')}
                    </Button>
                  </div>
                </div>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <ImportConceptSetDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        project={project}
      />

      <ConceptSetDetailSheet
        conceptSet={detailConceptSet}
        open={!!detailConceptSet}
        onOpenChange={(open) => { if (!open) setDetailConceptSet(null) }}
      />

      {/* Update all result dialog */}
      <AlertDialog open={!!updateAllResult} onOpenChange={(open) => { if (!open) setUpdateAllResult(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.cs_update_all_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.cs_update_all_result', { updated: updateAllResult?.updated ?? 0, total: updateAllResult?.total ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setUpdateAllResult(null)}>{t('common.ok')}</AlertDialogAction>
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
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleBulkDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Vocabulary remove dialog */}
      <AlertDialog open={vocabRemoveOpen} onOpenChange={setVocabRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.vocab_remove_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.vocab_remove_desc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleVocabRemove}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Batch delete dialog */}
      <AlertDialog open={!!batchToDelete} onOpenChange={(open) => { if (!open) setBatchToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.cs_batch_delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.cs_batch_delete_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleDeleteBatch}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
