import { useState, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  Plus, BookOpen, Trash2,
  Info, Check, CheckCheck, X, CheckCircle2, ChevronLeft, ChevronRight, Pencil, SquareX,
  Settings2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNavigate } from 'react-router'
import { paths } from '@/lib/paths'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedHeader, headerLabel } from '@/components/ui/truncated-header'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
import { ColumnResizeHandle, FILTER_INPUT_CLASS, SortIndicator, columnLabel } from '@/components/ui/table-primitives'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useDataSourceStore } from '@/stores/data-source-store'
import { PickConceptSetsDialog } from './PickConceptSetsDialog'
import { ConceptSetDetailSheet } from './ConceptSetDetailSheet'
import { VocabularyBrowser } from './components/VocabularyBrowser'
import type { MappingProject, DataSource, ConceptSet, DatabaseConnectionConfig } from '@/types'
import { getConceptSetI18n } from '@/lib/concept-mapping/i18n'
import { localized } from '@/lib/localized'
import { vocabularyDataSourceIdFor } from '@/lib/vocabulary-library/resolve'


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
  const openVocabularyLibrary = () => navigate(paths.warehouseVocabularies(project.workspaceId, 'ohdsi', 'library'))

  return (
    <div className="h-full overflow-auto px-4 pb-4">
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
                    <Button size="sm" variant="outline" onClick={openVocabularyLibrary}>
                      <Settings2 size={14} />
                      {t('concept_mapping.vocab_library_manage')}
                    </Button>
                  </div>
                </Card>

                <VocabularyBrowser dataSourceId={vocabDs.id} />
              </>
            ) : (
              /* No vocabulary in the workspace: it is imported on the workspace Vocabularies page */
              <Card className="p-6">
                <div className="flex flex-col items-center">
                  <BookOpen size={32} className="text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">{t('concept_mapping.vocab_library_empty_title')}</p>
                  <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                    {t('concept_mapping.vocab_library_empty_hint')}
                  </p>
                  <Button size="sm" variant="outline" className="mt-4" onClick={openVocabularyLibrary}>
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
