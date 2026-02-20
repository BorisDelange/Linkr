import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  Check, Flag, X, MessageSquare,
  ChevronLeft, ChevronRight, Pencil, Trash2, Square, CheckSquare,
  Settings2, ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import type { MappingProject, ConceptMapping, MappingComment, MappingStatus } from '@/types'

interface MappingsTabProps {
  project: MappingProject
}

const PAGE_SIZE = 50

// ─── Status badge styling ────────────────────────────────────────────

const STATUS_BADGE: Record<MappingStatus, string> = {
  unchecked: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  flagged: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400',
  invalid: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400',
  ignored: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
}

// ─── Equivalence badge styling ────────────────────────────────────────

const EQUIV_BADGE: Record<string, { label: string; className: string }> = {
  'skos:exactMatch':   { label: 'Exact',    className: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400' },
  'skos:closeMatch':   { label: 'Close',    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
  'skos:broadMatch':   { label: 'Broad',    className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400' },
  'skos:narrowMatch':  { label: 'Narrow',   className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400' },
  'skos:relatedMatch': { label: 'Related',  className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
  // Legacy aliases
  equal: { label: 'Exact', className: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400' },
  equivalent: { label: 'Close', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
  wider: { label: 'Broad', className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400' },
  narrower: { label: 'Narrow', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400' },
  inexact: { label: 'Related', className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
}

/** Get human-readable label for a TanStack column def. */
function getColLabel(colDefs: ColumnDef<ConceptMapping>[], id: string): string {
  const def = colDefs.find((c) => 'id' in c && c.id === id)
  if (def) {
    if (typeof def.header === 'function') {
      const result = (def.header as () => unknown)()
      if (typeof result === 'string') return result
    }
    if (typeof def.header === 'string') return def.header
  }
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ─── Inline column filter helpers ──────────────────────────────────

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

/** Column filter state for MappingsTab. */
interface MappingColumnFilters {
  sourceConceptName?: string
  sourceConceptId?: string
  sourceVocabularyId?: string | null
  sourceDomainId?: string | null
  targetConceptName?: string
  targetConceptId?: string
  targetVocabularyId?: string | null
  targetDomainId?: string | null
  status?: string | null
  equivalence?: string | null
  mappedBy?: string
}

const FILTER_INPUT_CLASS = 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

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

/** Self-contained comment popover — manages its own draft state so the parent
 *  table never re-renders on keystrokes. */
function CommentPopover({ mapping }: { mapping: ConceptMapping }) {
  const { t } = useTranslation()
  const { mappings, updateMapping } = useConceptMappingStore()
  const [draft, setDraft] = useState('')
  const commentCount = (mapping.comments ?? []).length

  const handleAdd = () => {
    const text = draft.trim()
    if (!text) return
    const latest = mappings.find((m) => m.id === mapping.id)
    if (!latest) return
    const comment: MappingComment = {
      id: crypto.randomUUID(),
      authorId: 'current-user',
      text,
      createdAt: new Date().toISOString(),
    }
    updateMapping(mapping.id, { comments: [...(latest.comments ?? []), comment] })
    setDraft('')
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          className="relative size-6"
          title={t('concept_mapping.comments')}
          onClick={(e) => e.stopPropagation()}
        >
          <MessageSquare size={13} />
          {commentCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
              {commentCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3" onClick={(e) => e.stopPropagation()}>
        <p className="mb-2 text-xs font-medium">{t('concept_mapping.comments')}</p>
        {commentCount > 0 && (
          <div className="mb-2 max-h-40 space-y-1.5 overflow-auto">
            {(mapping.comments ?? []).map((c) => (
              <div key={c.id} className="rounded-md bg-muted/50 px-2 py-1.5">
                <p className="text-xs">{c.text}</p>
                <p className="mt-0.5 text-[9px] text-muted-foreground">
                  {c.authorId} — {formatDate(c.createdAt)}
                </p>
              </div>
            ))}
          </div>
        )}
        <Textarea
          className="text-xs"
          rows={2}
          placeholder={t('concept_mapping.comment_placeholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleAdd()
            }
          }}
        />
        <Button
          size="sm"
          className="mt-1.5 h-7 w-full text-xs"
          disabled={!draft.trim()}
          onClick={handleAdd}
        >
          {t('concept_mapping.add_comment')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function MappingsTab({ project }: MappingsTabProps) {
  const { t } = useTranslation()
  const { mappings, updateMapping, deleteMapping } = useConceptMappingStore()

  const [colFilters, setColFilters] = useState<MappingColumnFilters>({})
  const [sorting, setSorting] = useState<{ columnId: string; desc: boolean } | null>(null)
  const [page, setPage] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    createdAt: false,
    mappedBy: false,
    sourceConceptClassId: false,
    sourceDomainId: false,
    sourceCategoryId: false,
    sourceSubcategoryId: false,
    targetConceptClassId: false,
    targetDomainId: false,
  })
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})

  const projectMappings = mappings.filter((m) => m.projectId === project.id)

  // Compute distinct values for dropdown filters
  const filterOptions = useMemo(() => {
    const unique = (fn: (m: ConceptMapping) => string | undefined) =>
      [...new Set(projectMappings.map(fn))].filter((v): v is string => Boolean(v)).sort()
    return {
      sourceVocabularyId: unique((m) => m.sourceVocabularyId),
      sourceDomainId: unique((m) => m.sourceDomainId),
      targetVocabularyId: unique((m) => m.targetVocabularyId),
      targetDomainId: unique((m) => m.targetDomainId),
      status: unique((m) => m.status),
      equivalence: unique((m) => m.equivalence),
    }
  }, [projectMappings])

  // Apply column filters (client-side)
  const filtered = projectMappings.filter((m) => {
    const f = colFilters
    if (f.sourceConceptName && !textMatch(m.sourceConceptName, f.sourceConceptName)) return false
    if (f.sourceConceptId && !String(m.sourceConceptId).includes(f.sourceConceptId)) return false
    if (f.sourceVocabularyId && m.sourceVocabularyId !== f.sourceVocabularyId) return false
    if (f.sourceDomainId && m.sourceDomainId !== f.sourceDomainId) return false
    if (f.targetConceptName && !textMatch(m.targetConceptName, f.targetConceptName)) return false
    if (f.targetConceptId && !String(m.targetConceptId).includes(f.targetConceptId)) return false
    if (f.targetVocabularyId && m.targetVocabularyId !== f.targetVocabularyId) return false
    if (f.targetDomainId && m.targetDomainId !== f.targetDomainId) return false
    if (f.status && m.status !== f.status) return false
    if (f.equivalence && m.equivalence !== f.equivalence) return false
    if (f.mappedBy && !(m.mappedBy ?? '').toLowerCase().includes(f.mappedBy.toLowerCase())) return false
    return true
  })

  // Apply sorting
  const sorted = useMemo(() => {
    if (!sorting) return filtered
    const { columnId, desc } = sorting
    const dir = desc ? -1 : 1
    return [...filtered].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[columnId]
      const bv = (b as unknown as Record<string, unknown>)[columnId]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv)
      return dir * String(av).localeCompare(String(bv))
    })
  }, [filtered, sorting])

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const pageItems = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const handleSort = (columnId: string) => {
    if (sorting?.columnId === columnId) {
      if (sorting.desc) setSorting({ columnId, desc: false })
      else setSorting(null)
    } else {
      setSorting({ columnId, desc: true })
    }
    setPage(0)
  }

  const updateFilter = (key: keyof MappingColumnFilters, value: string | null) => {
    setColFilters((prev) => ({ ...prev, [key]: value ?? undefined }))
    setPage(0)
  }

  /** Render inline column filter for a given column. */
  const renderColumnFilter = (columnId: string) => {
    // Text inputs
    if (columnId === 'sourceConceptName') {
      return <input className={FILTER_INPUT_CLASS} placeholder="..." value={colFilters.sourceConceptName ?? ''} onChange={(e) => updateFilter('sourceConceptName', e.target.value || null)} />
    }
    if (columnId === 'sourceConceptId') {
      return <input className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="ID..." value={colFilters.sourceConceptId ?? ''} onChange={(e) => updateFilter('sourceConceptId', e.target.value || null)} />
    }
    if (columnId === 'targetConceptName') {
      return <input className={FILTER_INPUT_CLASS} placeholder="..." value={colFilters.targetConceptName ?? ''} onChange={(e) => updateFilter('targetConceptName', e.target.value || null)} />
    }
    if (columnId === 'targetConceptId') {
      return <input className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="ID..." value={colFilters.targetConceptId ?? ''} onChange={(e) => updateFilter('targetConceptId', e.target.value || null)} />
    }
    if (columnId === 'mappedBy') {
      return <input className={FILTER_INPUT_CLASS} placeholder="..." value={colFilters.mappedBy ?? ''} onChange={(e) => updateFilter('mappedBy', e.target.value || null)} />
    }
    // Dropdowns
    if (columnId === 'sourceVocabularyId' && filterOptions.sourceVocabularyId.length > 0) {
      return <ColumnFilterSelect value={colFilters.sourceVocabularyId ?? null} options={filterOptions.sourceVocabularyId} placeholder="Vocab" onChange={(v) => updateFilter('sourceVocabularyId', v)} />
    }
    if (columnId === 'sourceDomainId' && filterOptions.sourceDomainId.length > 0) {
      return <ColumnFilterSelect value={colFilters.sourceDomainId ?? null} options={filterOptions.sourceDomainId} placeholder="Domain" onChange={(v) => updateFilter('sourceDomainId', v)} />
    }
    if (columnId === 'targetVocabularyId' && filterOptions.targetVocabularyId.length > 0) {
      return <ColumnFilterSelect value={colFilters.targetVocabularyId ?? null} options={filterOptions.targetVocabularyId} placeholder="Vocab" onChange={(v) => updateFilter('targetVocabularyId', v)} />
    }
    if (columnId === 'targetDomainId' && filterOptions.targetDomainId.length > 0) {
      return <ColumnFilterSelect value={colFilters.targetDomainId ?? null} options={filterOptions.targetDomainId} placeholder="Domain" onChange={(v) => updateFilter('targetDomainId', v)} />
    }
    if (columnId === 'status' && filterOptions.status.length > 0) {
      return <ColumnFilterSelect value={colFilters.status ?? null} options={filterOptions.status} placeholder="Status" onChange={(v) => updateFilter('status', v)} />
    }
    if (columnId === 'equivalence' && filterOptions.equivalence.length > 0) {
      return <ColumnFilterSelect value={colFilters.equivalence ?? null} options={filterOptions.equivalence} placeholder="Equiv" onChange={(v) => updateFilter('equivalence', v)} />
    }
    return null
  }

  const toggleEditMode = () => {
    setEditMode(!editMode)
    setSelected(new Set())
  }

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = () => {
    const pageIds = pageItems.map((m) => m.id)
    const allSelected = pageIds.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        for (const id of pageIds) next.delete(id)
      } else {
        for (const id of pageIds) next.add(id)
      }
      return next
    })
  }

  const handleDeleteSelected = () => {
    for (const id of selected) deleteMapping(id)
    setSelected(new Set())
  }

  /** Toggle review: clicking the same status resets to unchecked. */
  const handleReview = useCallback((mappingId: string, current: MappingStatus, target: MappingStatus) => {
    updateMapping(mappingId, { status: current === target ? 'unchecked' : target })
  }, [updateMapping])

  const pageAllSelected = pageItems.length > 0 && pageItems.every((m) => selected.has(m.id))

  // Build TanStack columns
  const columns = useMemo<ColumnDef<ConceptMapping>[]>(() => {
    const cols: ColumnDef<ConceptMapping>[] = []

    // Edit mode checkbox column
    if (editMode) {
      cols.push({
        id: '_select',
        header: () => (
          <button onClick={toggleSelectAll} className="flex justify-center">
            {pageAllSelected
              ? <CheckSquare size={14} className="text-foreground" />
              : <Square size={14} />}
          </button>
        ),
        cell: ({ row }) => (
          <button
            onClick={(e) => { e.stopPropagation(); toggleSelect(row.original.id) }}
            className="flex justify-center"
          >
            {selected.has(row.original.id)
              ? <CheckSquare size={14} className="text-foreground" />
              : <Square size={14} className="text-muted-foreground" />}
          </button>
        ),
        size: 32,
        minSize: 32,
        enableHiding: false,
        enableResizing: false,
      })
    }

    cols.push(
      {
        id: 'sourceConceptName',
        header: () => t('concept_mapping.col_source'),
        accessorFn: (row) => row.sourceConceptName,
        cell: ({ row }) => row.original.sourceConceptName,
        size: 200,
        minSize: 100,
        enableHiding: false,
      },
      {
        id: 'sourceConceptId',
        header: 'Source ID',
        accessorFn: (row) => row.sourceConceptId,
        cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.sourceConceptId}</span>,
        size: 70,
        minSize: 50,
      },
      {
        id: 'sourceVocabularyId',
        header: () => t('concept_mapping.col_terminology'),
        accessorFn: (row) => row.sourceVocabularyId,
        cell: ({ row }) => row.original.sourceVocabularyId,
        size: 90,
        minSize: 50,
      },
      // Hidden by default: source OMOP-specific columns
      {
        id: 'sourceConceptClassId',
        header: () => t('concept_mapping.col_concept_class_id'),
        accessorFn: (row) => row.sourceConceptClassId,
        cell: ({ row }) => <span className="text-[10px] text-muted-foreground">{row.original.sourceConceptClassId ?? ''}</span>,
        size: 90,
        minSize: 60,
      },
      {
        id: 'sourceDomainId',
        header: () => t('concept_mapping.col_domain_id'),
        accessorFn: (row) => row.sourceDomainId,
        cell: ({ row }) => <span className="text-[10px] text-muted-foreground">{row.original.sourceDomainId ?? ''}</span>,
        size: 90,
        minSize: 50,
      },
      {
        id: 'sourceCategoryId',
        header: () => t('concept_mapping.col_category'),
        accessorFn: (row) => row.sourceCategoryId,
        cell: ({ row }) => <span className="text-[10px] text-muted-foreground">{row.original.sourceCategoryId ?? ''}</span>,
        size: 90,
        minSize: 60,
      },
      {
        id: 'sourceSubcategoryId',
        header: () => t('concept_mapping.col_subcategory'),
        accessorFn: (row) => row.sourceSubcategoryId,
        cell: ({ row }) => <span className="text-[10px] text-muted-foreground">{row.original.sourceSubcategoryId ?? ''}</span>,
        size: 90,
        minSize: 60,
      },
      {
        id: 'targetConceptName',
        header: () => t('concept_mapping.col_target'),
        accessorFn: (row) => row.targetConceptName,
        cell: ({ row }) => {
          const m = row.original
          return (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{m.targetConceptName}</span>
              {m.comment && <span title={m.comment}><MessageSquare size={10} className="shrink-0 text-muted-foreground" /></span>}
            </span>
          )
        },
        size: 200,
        minSize: 100,
        enableHiding: false,
      },
      {
        id: 'targetConceptId',
        header: 'Target ID',
        accessorFn: (row) => row.targetConceptId,
        cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.targetConceptId}</span>,
        size: 70,
        minSize: 50,
      },
      {
        id: 'targetVocabularyId',
        header: () => t('concept_mapping.col_terminology'),
        accessorFn: (row) => row.targetVocabularyId,
        cell: ({ row }) => row.original.targetVocabularyId,
        size: 90,
        minSize: 50,
      },
      // Hidden by default: target OMOP-specific columns
      {
        id: 'targetConceptClassId',
        header: () => t('concept_mapping.col_concept_class_id'),
        accessorFn: (row) => row.targetConceptClassId,
        cell: ({ row }) => <span className="text-[10px] text-muted-foreground">{row.original.targetConceptClassId ?? ''}</span>,
        size: 90,
        minSize: 60,
      },
      {
        id: 'targetDomainId',
        header: () => t('concept_mapping.col_domain_id'),
        accessorFn: (row) => row.targetDomainId,
        cell: ({ row }) => <span className="text-[10px] text-muted-foreground">{row.original.targetDomainId ?? ''}</span>,
        size: 90,
        minSize: 50,
      },
      {
        id: 'equivalence',
        header: () => t('concept_mapping.col_equiv'),
        accessorFn: (row) => row.equivalence,
        cell: ({ row }) => {
          const equiv = row.original.equivalence
          const badge = EQUIV_BADGE[equiv]
          if (!badge) return <span className="text-[10px] text-muted-foreground">{equiv}</span>
          return (
            <Badge
              variant="secondary"
              className={`px-1.5 py-0 text-[9px] font-medium ${badge.className}`}
            >
              {badge.label}
            </Badge>
          )
        },
        size: 70,
        minSize: 50,
      },
      {
        id: 'status',
        header: () => t('concept_mapping.col_status'),
        accessorFn: (row) => row.status,
        cell: ({ row }) => (
          <Badge
            variant="secondary"
            className={`px-1.5 py-0 text-[9px] font-medium ${STATUS_BADGE[row.original.status] ?? ''}`}
          >
            {t(`concept_mapping.status_${row.original.status}`)}
          </Badge>
        ),
        size: 80,
        minSize: 60,
        enableHiding: false,
      },
      {
        id: 'createdAt',
        header: () => t('concept_mapping.col_created_at'),
        accessorFn: (row) => row.createdAt,
        cell: ({ row }) => {
          const d = row.original.createdAt
          if (!d) return null
          const date = new Date(d)
          return (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )
        },
        size: 130,
        minSize: 90,
      },
      {
        id: 'mappedBy',
        header: () => t('concept_mapping.col_mapped_by'),
        accessorFn: (row) => row.mappedBy,
        cell: ({ row }) => (
          <span className="text-[10px] text-muted-foreground">
            {row.original.mappedBy ?? ''}
          </span>
        ),
        size: 100,
        minSize: 60,
      },
    )

    // Review action buttons (only in review mode)
    if (!editMode) {
      cols.push({
        id: '_review',
        header: () => <span className="text-right w-full block">{t('concept_mapping.col_review')}</span>,
        cell: ({ row }) => {
          const m = row.original
          return (
            <span className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
              <CommentPopover mapping={m} />
              <Button
                variant={m.status === 'approved' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-6 ${m.status === 'approved' ? 'bg-green-600 text-white hover:bg-green-700' : 'hover:border-green-600 hover:text-green-600'}`}
                title={t('concept_mapping.approve')}
                onClick={(e) => { e.stopPropagation(); handleReview(m.id, m.status, 'approved') }}
              >
                <Check size={13} />
              </Button>
              <Button
                variant={m.status === 'rejected' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-6 ${m.status === 'rejected' ? 'bg-red-600 text-white hover:bg-red-700' : 'hover:border-red-600 hover:text-red-600'}`}
                title={t('concept_mapping.reject')}
                onClick={(e) => { e.stopPropagation(); handleReview(m.id, m.status, 'rejected') }}
              >
                <X size={13} />
              </Button>
              <Button
                variant={m.status === 'flagged' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-6 ${m.status === 'flagged' ? 'bg-orange-500 text-white hover:bg-orange-600' : 'hover:border-orange-500 hover:text-orange-500'}`}
                title={t('concept_mapping.flag')}
                onClick={(e) => { e.stopPropagation(); handleReview(m.id, m.status, 'flagged') }}
              >
                <Flag size={13} />
              </Button>
            </span>
          )
        },
        size: 130,
        minSize: 130,
        enableHiding: false,
        enableResizing: false,
      })
    }

    return cols
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, editMode, selected, pageAllSelected, handleReview, toggleSelect])

  const table = useReactTable({
    data: pageItems,
    columns,
    state: { columnVisibility, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: totalPages,
  })

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <span className="text-xs text-muted-foreground">
          {filtered.length} / {projectMappings.length} {t('concept_mapping.existing_mappings').toLowerCase()}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {editMode && selected.size > 0 && (
            <Button variant="destructive" size="sm" className="h-7 gap-1 text-xs" onClick={() => setShowDeleteConfirm(true)}>
              <Trash2 size={12} />
              {t('concept_mapping.delete_selected', { count: selected.size })}
            </Button>
          )}
          <Button
            variant={editMode ? 'default' : 'outline'}
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={toggleEditMode}
          >
            <Pencil size={12} />
            {editMode ? t('concept_mapping.done_editing') : t('concept_mapping.edit_mode')}
          </Button>
          {/* Column visibility toggle */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                <Settings2 size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[180px]">
              <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table.getAllColumns()
                .filter((col) => col.getCanHide())
                .map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={col.getIsVisible()}
                    onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                    onSelect={(e) => e.preventDefault()}
                    className="text-xs"
                  >
                    {getColLabel(columns, col.id)}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="w-full" style={{ tableLayout: 'fixed' }}>
          <TableHeader>
            {/* Column titles */}
            <TableRow>
              {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => {
                  const colId = header.column.id
                  const isSortable = colId !== '_select' && colId !== '_review'
                  const sortIcon = !sorting || sorting.columnId !== colId
                    ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                    : sorting.desc
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
                          onClick={() => handleSort(colId)}
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
              {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => (
                  <TableHead
                    key={`filter-${header.id}`}
                    className="px-1 py-1"
                    style={{ width: header.getSize() }}
                  >
                    {renderColumnFilter(header.column.id)}
                  </TableHead>
                ))
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center text-sm text-muted-foreground">
                  {projectMappings.length === 0
                    ? t('concept_mapping.prog_empty')
                    : t('common.no_results')}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.original.id}
                  className="group"
                  data-state={selected.has(row.original.id) ? 'selected' : undefined}
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

      {/* Pagination */}
      <div className="flex shrink-0 items-center justify-end border-t px-4 py-1.5">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.delete_confirm_desc', { count: selected.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteSelected}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
