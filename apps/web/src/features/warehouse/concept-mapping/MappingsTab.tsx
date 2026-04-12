import { useState, useMemo, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  Check, Flag, X, MessageSquare, EyeOff,
  ChevronLeft, ChevronRight, Pencil, Trash2, Square, CheckSquare,
  Settings2, ArrowUpDown, ArrowUp, ArrowDown, Users, Filter,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useAppStore } from '@/stores/app-store'
import type { MappingProject, ConceptMapping, MappingComment, MappingReview, MappingStatus } from '@/types'

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
  options: string[] | { value: string; label: string }[]
  placeholder: string
  onChange: (v: string | null) => void
}) {
  const { t } = useTranslation()
  const normalized = options.map((o) =>
    typeof o === 'string' ? { value: o, label: o } : o,
  )
  const selectedLabel = normalized.find((o) => o.value === value)?.label ?? value
  return (
    <Select
      value={value ?? '__all__'}
      onValueChange={(v) => onChange(v === '__all__' ? null : v)}
    >
      <SelectTrigger className="h-6 w-full border-dashed text-[10px] font-normal">
        <SelectValue placeholder={placeholder}>
          {value ? selectedLabel : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">{t('concepts.filter_all')}</SelectItem>
        {normalized.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Column filter state for MappingsTab. */
interface MappingColumnFilters {
  sourceConceptName?: string
  sourceConceptCode?: string
  sourceVocabularyId?: string | null
  sourceCategoryId?: string | null
  targetConceptName?: string
  targetConceptId?: string
  targetVocabularyId?: string | null
  targetDomainId?: string | null
  equivalence?: string | null
  mappedBy?: string
}

type ApprovalRule = 'at_least_one' | 'majority' | 'no_rejections'
const FILTER_STATUSES: MappingStatus[] = ['approved', 'rejected', 'flagged', 'unchecked', 'ignored']

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

/** Sheet showing all comments for a single mapping, with add/edit/delete. */
function CommentsSheet({ mappingId, open, onOpenChange }: {
  mappingId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { mappings, updateMapping } = useConceptMappingStore()
  const getUserDisplayName = useAppStore((s) => s.getUserDisplayName)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const currentUser = getUserDisplayName()
  const mapping = mappingId ? (mappings.find((m) => m.id === mappingId) ?? null) : null
  const comments = mapping?.comments ?? []

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }

  const handleAdd = () => {
    const text = draft.trim()
    if (!text || !mapping) return
    const comment: MappingComment = {
      id: crypto.randomUUID(),
      authorId: currentUser,
      text,
      createdAt: new Date().toISOString(),
    }
    updateMapping(mapping.id, { comments: [...comments, comment] })
    setDraft('')
  }

  const handleDelete = (commentId: string) => {
    if (!mapping) return
    updateMapping(mapping.id, { comments: comments.filter((c) => c.id !== commentId) })
  }

  const handleEditSave = (commentId: string) => {
    const text = editText.trim()
    if (!text || !mapping) return
    updateMapping(mapping.id, {
      comments: comments.map((c) => c.id === commentId ? { ...c, text } : c),
    })
    setEditingId(null)
    setEditText('')
  }

  if (!mapping) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[480px] flex-col gap-0 p-0 sm:max-w-[480px]">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="text-sm">{t('concept_mapping.comments')}</SheetTitle>
          <p className="text-xs text-muted-foreground truncate">{mapping.sourceConceptName} → {mapping.targetConceptName}</p>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
          {comments.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('concept_mapping.no_comments_yet')}</p>
          ) : (
            <div className="space-y-2">
              {comments.map((c) => (
                <div key={c.id} className="rounded-lg border bg-muted/30 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{c.authorId}</span>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-muted-foreground">{formatDate(c.createdAt)}</span>
                      {c.authorId === currentUser && editingId !== c.id && (
                        <>
                          <button
                            className="ml-1 text-muted-foreground hover:text-foreground"
                            title={t('common.edit')}
                            onClick={() => { setEditingId(c.id); setEditText(c.text) }}
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            className="text-muted-foreground hover:text-destructive"
                            title={t('common.delete')}
                            onClick={() => handleDelete(c.id)}
                          >
                            <Trash2 size={11} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {editingId === c.id ? (
                    <div className="mt-1.5 space-y-1.5">
                      <Textarea
                        className="text-xs"
                        rows={2}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave(c.id) }
                          if (e.key === 'Escape') { setEditingId(null); setEditText('') }
                        }}
                        autoFocus
                      />
                      <div className="flex gap-1.5">
                        <Button size="sm" className="h-6 text-xs" onClick={() => handleEditSave(c.id)} disabled={!editText.trim()}>{t('common.save')}</Button>
                        <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => { setEditingId(null); setEditText('') }}>{t('common.cancel')}</Button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">{c.text}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="rounded-lg border bg-card p-3 space-y-2">
            <p className="text-xs font-medium">{t('concept_mapping.add_comment')}</p>
            <Textarea
              className="text-xs"
              rows={3}
              placeholder={t('concept_mapping.comment_placeholder')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAdd() }
              }}
            />
            <Button size="sm" className="h-7 w-full text-xs" disabled={!draft.trim()} onClick={handleAdd}>
              {t('concept_mapping.add_comment')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Sheet showing all reviewer opinions for a single mapping. */
function ReviewsSheet({ mappingId, open, onOpenChange }: {
  mappingId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { mappings, updateMapping } = useConceptMappingStore()
  const getUserDisplayName = useAppStore((s) => s.getUserDisplayName)

  // Always read from live store so reviews appear immediately after save
  const mapping = mappingId ? (mappings.find((m) => m.id === mappingId) ?? null) : null

  const currentUser = getUserDisplayName()
  const reviews = mapping?.reviews ?? []
  const myReview = reviews.find((r) => r.reviewerId === currentUser)

  // Préremplir le commentaire avec la valeur existante de mon review
  const [comment, setComment] = useState(myReview?.comment ?? '')
  useEffect(() => {
    setComment(myReview?.comment ?? '')
  }, [myReview?.comment, mappingId])

  if (!mapping) return null

  const handleReview = (status: MappingStatus) => {
    const newStatus = myReview?.status === status ? 'unchecked' : status
    const newReviews: MappingReview[] = [
      ...reviews.filter((r) => r.reviewerId !== currentUser),
      ...(newStatus !== 'unchecked' ? [{
        id: myReview?.id ?? crypto.randomUUID(),
        reviewerId: currentUser,
        status: newStatus,
        comment: comment.trim() || undefined,
        createdAt: new Date().toISOString(),
      }] : []),
    ]
    updateMapping(mapping.id, {
      reviews: newReviews,
      reviewedBy: newStatus !== 'unchecked' ? currentUser : undefined,
      reviewedOn: newStatus !== 'unchecked' ? new Date().toISOString() : undefined,
    })
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[480px] flex-col gap-0 p-0 sm:max-w-[480px]">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="text-sm">{t('concept_mapping.reviews_title')}</SheetTitle>
          <p className="text-xs text-muted-foreground truncate">{mapping.sourceConceptName} → {mapping.targetConceptName}</p>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
          {/* Existing reviews */}
          {reviews.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('concept_mapping.no_reviews_yet')}</p>
          ) : (
            <div className="space-y-2">
              {reviews.map((r) => (
                <div key={r.id} className="rounded-lg border bg-muted/30 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{r.reviewerId}</span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_BADGE[r.status] ?? ''}`}>
                      {t(`concept_mapping.status_${r.status}`)}
                    </span>
                  </div>
                  {r.comment && <p className="mt-1 text-xs text-muted-foreground">{r.comment}</p>}
                  <p className="mt-1 text-[10px] text-muted-foreground">{formatDate(r.createdAt)}</p>
                </div>
              ))}
            </div>
          )}

          {/* My review form */}
          <div className="rounded-lg border bg-card p-3 space-y-2">
            <p className="text-xs font-medium">{t('concept_mapping.my_review')} <span className="font-normal text-muted-foreground">({currentUser})</span></p>
            <Textarea
              className="text-xs"
              rows={2}
              placeholder={t('concept_mapping.review_comment_placeholder')}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="grid grid-cols-3 gap-1.5">
              <Button
                size="sm"
                className={`h-8 text-xs gap-1 ${myReview?.status === 'approved' ? 'bg-green-600 hover:bg-green-700 text-white' : ''}`}
                variant={myReview?.status === 'approved' ? 'default' : 'outline'}
                onClick={() => handleReview('approved')}
              >
                <Check size={12} />
                {t('concept_mapping.approve')}
              </Button>
              <Button
                size="sm"
                className={`h-8 text-xs gap-1 ${myReview?.status === 'rejected' ? 'bg-red-600 hover:bg-red-700 text-white' : ''}`}
                variant={myReview?.status === 'rejected' ? 'default' : 'outline'}
                onClick={() => handleReview('rejected')}
              >
                <X size={12} />
                {t('concept_mapping.reject')}
              </Button>
              <Button
                size="sm"
                className={`h-8 text-xs gap-1 ${myReview?.status === 'flagged' ? 'bg-orange-500 hover:bg-orange-600 text-white' : ''}`}
                variant={myReview?.status === 'flagged' ? 'default' : 'outline'}
                onClick={() => handleReview('flagged')}
              >
                <Flag size={12} />
                {t('concept_mapping.flag')}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function MappingsTab({ project }: MappingsTabProps) {
  const { t } = useTranslation()
  const { mappings, updateMapping, deleteMapping } = useConceptMappingStore()
  const getUserDisplayName = useAppStore((s) => s.getUserDisplayName)
  const currentUser = getUserDisplayName()

  const [colFilters, setColFilters] = useState<MappingColumnFilters>({})
  const [sorting, setSorting] = useState<{ columnId: string; desc: boolean } | null>(null)
  const [page, setPage] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [reviewsMappingId, setReviewsMappingId] = useState<string | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [includedStatuses, setIncludedStatuses] = useState<Set<MappingStatus>>(new Set(FILTER_STATUSES))
  const [commentsMappingId, setCommentsMappingId] = useState<string | null>(null)
  const [approvalRule, setApprovalRule] = useState<ApprovalRule>('at_least_one')
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    createdAt: false,
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
      sourceCategoryId: unique((m) => m.sourceCategoryId),
      targetVocabularyId: unique((m) => m.targetVocabularyId),
      targetDomainId: unique((m) => m.targetDomainId),
      equivalence: unique((m) => m.equivalence),
    }
  }, [projectMappings])

  // Status counts for filter popover
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const m of projectMappings) counts[m.status] = (counts[m.status] ?? 0) + 1
    return counts
  }, [projectMappings])

  // Compute effective status per mapping (based on reviews majority vote)
  const effectiveStatus = useCallback((m: ConceptMapping): MappingStatus => {
    const reviews = m.reviews ?? []
    if (reviews.length === 0) return m.status
    const counts = { approved: 0, rejected: 0, flagged: 0, ignored: 0, unchecked: 0, invalid: 0 }
    for (const r of reviews) counts[r.status] = (counts[r.status] ?? 0) + 1
    const max = Math.max(...Object.values(counts))
    if (counts.approved === max) return 'approved'
    if (counts.rejected === max) return 'rejected'
    if (counts.flagged === max) return 'flagged'
    return m.status
  }, [])

  // Apply column filters + status popover filter (client-side)
  const filtered = useMemo(() => projectMappings.filter((m) => {
    const f = colFilters
    if (f.sourceConceptName && !textMatch(m.sourceConceptName, f.sourceConceptName)) return false
    if (f.sourceConceptCode && !(m.sourceConceptCode || String(m.sourceConceptId)).toLowerCase().includes(f.sourceConceptCode.toLowerCase())) return false
    if (f.sourceVocabularyId && m.sourceVocabularyId !== f.sourceVocabularyId) return false
    if (f.sourceCategoryId && m.sourceCategoryId !== f.sourceCategoryId) return false
    if (f.targetConceptName && !textMatch(m.targetConceptName, f.targetConceptName)) return false
    if (f.targetConceptId && !String(m.targetConceptId).includes(f.targetConceptId)) return false
    if (f.targetVocabularyId && m.targetVocabularyId !== f.targetVocabularyId) return false
    if (f.targetDomainId && m.targetDomainId !== f.targetDomainId) return false
    if (f.equivalence && m.equivalence !== f.equivalence) return false
    if (f.mappedBy && !(m.mappedBy ?? '').toLowerCase().includes(f.mappedBy.toLowerCase())) return false
    // Status popover filter
    const eff = effectiveStatus(m)
    if (!includedStatuses.has(eff)) return false
    // Approval rule sub-filter
    if (eff === 'approved' && includedStatuses.has('approved') && approvalRule !== 'at_least_one') {
      const reviews = m.reviews ?? []
      const approvedCount = reviews.filter((r) => r.status === 'approved').length
      const rejectedCount = reviews.filter((r) => r.status === 'rejected').length
      if (approvalRule === 'majority' && !(approvedCount > rejectedCount)) return false
      if (approvalRule === 'no_rejections' && rejectedCount > 0) return false
    }
    return true
  }), [projectMappings, colFilters, includedStatuses, approvalRule, effectiveStatus])

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
    if (columnId === 'sourceConceptCode') {
      return <input className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="Code..." value={colFilters.sourceConceptCode ?? ''} onChange={(e) => updateFilter('sourceConceptCode', e.target.value || null)} />
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
    if (columnId === 'sourceCategoryId' && filterOptions.sourceCategoryId.length > 0) {
      return <ColumnFilterSelect value={colFilters.sourceCategoryId ?? null} options={filterOptions.sourceCategoryId} placeholder="..." onChange={(v) => updateFilter('sourceCategoryId', v)} />
    }
    if (columnId === 'targetVocabularyId' && filterOptions.targetVocabularyId.length > 0) {
      return <ColumnFilterSelect value={colFilters.targetVocabularyId ?? null} options={filterOptions.targetVocabularyId} placeholder="Vocab" onChange={(v) => updateFilter('targetVocabularyId', v)} />
    }
    if (columnId === 'targetDomainId' && filterOptions.targetDomainId.length > 0) {
      return <ColumnFilterSelect value={colFilters.targetDomainId ?? null} options={filterOptions.targetDomainId} placeholder="Domain" onChange={(v) => updateFilter('targetDomainId', v)} />
    }
    if (columnId === 'equivalence' && filterOptions.equivalence.length > 0) {
      const equivOptions = filterOptions.equivalence.map((e) => ({ value: e, label: EQUIV_BADGE[e]?.label ?? e }))
      return <ColumnFilterSelect value={colFilters.equivalence ?? null} options={equivOptions} placeholder="Equiv" onChange={(v) => updateFilter('equivalence', v)} />
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
  const handleReview = useCallback((mappingId: string, target: MappingStatus) => {
    const reviewer = getUserDisplayName()
    const m = mappings.find((x) => x.id === mappingId)
    const prevReviews = m?.reviews ?? []
    const currentReviewerStatus = prevReviews.find((r) => r.reviewerId === reviewer)?.status ?? 'unchecked'
    const newStatus = currentReviewerStatus === target ? 'unchecked' : target
    const newReviews = [
      ...prevReviews.filter((r) => r.reviewerId !== reviewer),
      ...(newStatus !== 'unchecked' ? [{
        id: prevReviews.find((r) => r.reviewerId === reviewer)?.id ?? crypto.randomUUID(),
        reviewerId: reviewer,
        status: newStatus,
        createdAt: new Date().toISOString(),
      }] : []),
    ]
    updateMapping(mappingId, {
      reviews: newReviews,
      reviewedBy: newStatus !== 'unchecked' ? reviewer : undefined,
      reviewedOn: newStatus !== 'unchecked' ? new Date().toISOString() : undefined,
    })
  }, [updateMapping, getUserDisplayName, mappings])

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
        enableResizing: false,
      })
    }

    cols.push(
      // ── Source ──────────────────────────────────────────────────────
      {
        id: 'sourceVocabularyId',
        header: () => t('concept_mapping.col_source_vocabulary'),
        accessorFn: (row) => row.sourceVocabularyId,
        cell: ({ row }) => row.original.sourceVocabularyId || '',
        size: 100,
        minSize: 50,
      },
      {
        id: 'sourceConceptCode',
        header: () => t('concept_mapping.col_source_concept_code'),
        accessorFn: (row) => row.sourceConceptCode,
        cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.sourceConceptCode || row.original.sourceConceptId || ''}</span>,
        size: 100,
        minSize: 50,
      },
      {
        id: 'sourceConceptName',
        header: () => t('concept_mapping.col_source_concept_name'),
        accessorFn: (row) => row.sourceConceptName,
        cell: ({ row }) => (
          <span className="block truncate" title={row.original.sourceConceptName}>
            {row.original.sourceConceptName}
          </span>
        ),
        size: 200,
        minSize: 100,
      },
      // Hidden by default: source optional columns
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
      // ── Equivalence ─────────────────────────────────────────────────
      {
        id: 'equivalence',
        header: () => t('concept_mapping.col_equivalence'),
        accessorFn: (row) => row.equivalence,
        cell: ({ row }) => {
          const equiv = row.original.equivalence
          const badge = EQUIV_BADGE[equiv]
          if (!badge) return <span className="text-[10px] text-muted-foreground">{equiv}</span>
          return (
            <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] font-medium ${badge.className}`}>
              {badge.label}
            </Badge>
          )
        },
        size: 70,
        minSize: 50,
      },
      // ── Target ──────────────────────────────────────────────────────
      {
        id: 'targetVocabularyId',
        header: () => t('concept_mapping.col_target_vocabulary'),
        accessorFn: (row) => row.targetVocabularyId,
        cell: ({ row }) => <span className="truncate text-muted-foreground">{row.original.targetVocabularyId}</span>,
        size: 100,
        minSize: 50,
      },
      {
        id: 'targetConceptId',
        header: () => t('concept_mapping.col_target_concept_id'),
        accessorFn: (row) => row.targetConceptId,
        cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.targetConceptId}</span>,
        size: 80,
        minSize: 50,
      },
      {
        id: 'targetConceptName',
        header: () => t('concept_mapping.col_target_concept_name'),
        accessorFn: (row) => row.targetConceptName,
        cell: ({ row }) => {
          const m = row.original
          if (m.status === 'ignored' || (m.targetConceptId === 0 && !m.targetConceptName)) {
            return (
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <EyeOff size={10} className="shrink-0" />
                <span className="truncate italic text-[10px]">{t('concept_mapping.no_mapping_needed')}</span>
              </span>
            )
          }
          return (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate" title={m.targetConceptName}>{m.targetConceptName}</span>
              {m.comment && <span title={m.comment}><MessageSquare size={10} className="shrink-0 text-muted-foreground" /></span>}
            </span>
          )
        },
        size: 200,
        minSize: 100,
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
      // ── Provenance ──────────────────────────────────────────────────
      {
        id: 'mappedBy',
        header: () => t('concept_mapping.col_mapped_by'),
        accessorFn: (row) => row.mappedBy,
        cell: ({ row }) => <span className="text-[10px] text-muted-foreground">{row.original.mappedBy ?? ''}</span>,
        size: 100,
        minSize: 60,
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
      // ── Votes ───────────────────────────────────────────────────────
      {
        id: '_votes_approved',
        header: () => <span className="text-green-600" title={t('concept_mapping.approve')}>✓</span>,
        cell: ({ row }) => {
          const count = (row.original.reviews ?? []).filter((r) => r.status === 'approved').length
          return count > 0 ? <span className="text-xs font-medium text-green-600">{count}</span> : <span className="text-xs text-muted-foreground/40">—</span>
        },
        size: 36,
        minSize: 36,
        enableResizing: false,
      },
      {
        id: '_votes_flagged',
        header: () => <span className="text-orange-500" title={t('concept_mapping.flag')}>⚑</span>,
        cell: ({ row }) => {
          const count = (row.original.reviews ?? []).filter((r) => r.status === 'flagged').length
          return count > 0 ? <span className="text-xs font-medium text-orange-500">{count}</span> : <span className="text-xs text-muted-foreground/40">—</span>
        },
        size: 36,
        minSize: 36,
        enableResizing: false,
      },
      {
        id: '_votes_rejected',
        header: () => <span className="text-red-500" title={t('concept_mapping.reject')}>✗</span>,
        cell: ({ row }) => {
          const count = (row.original.reviews ?? []).filter((r) => r.status === 'rejected').length
          return count > 0 ? <span className="text-xs font-medium text-red-500">{count}</span> : <span className="text-xs text-muted-foreground/40">—</span>
        },
        size: 36,
        minSize: 36,
        enableResizing: false,
      },
    )

    // Review action buttons (only in review mode)
    if (!editMode) {
      cols.push({
        id: '_review',
        header: () => t('concept_mapping.col_review'),
        cell: ({ row }) => {
          const m = row.original
          return (
            <span className="flex items-center justify-end gap-1">
              <Tooltip delayDuration={700}>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className={`relative size-6 ${(m.comments ?? []).length > 0 ? 'border-primary/50 text-primary' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setCommentsMappingId(m.id) }}
                  >
                    <MessageSquare size={12} />
                    {(m.comments ?? []).length > 0 && (
                      <span className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
                        {(m.comments ?? []).length}
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">{t('concept_mapping.comments')}</TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={700}>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className={`relative size-6 ${(m.reviews ?? []).length > 0 ? 'border-primary/50 text-primary' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setReviewsMappingId(m.id) }}
                  >
                    <Users size={12} />
                    {(m.reviews ?? []).length > 0 && (
                      <span className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
                        {(m.reviews ?? []).length}
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">{t('concept_mapping.reviews_title')}</TooltipContent>
              </Tooltip>
              {(() => {
                const myReview = (m.reviews ?? []).find((r) => r.reviewerId === currentUser)?.status ?? 'unchecked'
                return (
                  <>
                    <Tooltip delayDuration={700}>
                      <TooltipTrigger asChild>
                        <Button
                          variant={myReview === 'approved' ? 'default' : 'outline'}
                          size="icon-sm"
                          className={`size-6 ${myReview === 'approved' ? 'bg-green-600 text-white hover:bg-green-700' : 'hover:border-green-600 hover:text-green-600'}`}
                          onClick={(e) => { e.stopPropagation(); handleReview(m.id, 'approved') }}
                        >
                          <Check size={13} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{t('concept_mapping.approve')}</TooltipContent>
                    </Tooltip>
                    <Tooltip delayDuration={700}>
                      <TooltipTrigger asChild>
                        <Button
                          variant={myReview === 'rejected' ? 'default' : 'outline'}
                          size="icon-sm"
                          className={`size-6 ${myReview === 'rejected' ? 'bg-red-600 text-white hover:bg-red-700' : 'hover:border-red-600 hover:text-red-600'}`}
                          onClick={(e) => { e.stopPropagation(); handleReview(m.id, 'rejected') }}
                        >
                          <X size={13} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{t('concept_mapping.reject')}</TooltipContent>
                    </Tooltip>
                    <Tooltip delayDuration={700}>
                      <TooltipTrigger asChild>
                        <Button
                          variant={myReview === 'flagged' ? 'default' : 'outline'}
                          size="icon-sm"
                          className={`size-6 ${myReview === 'flagged' ? 'bg-orange-500 text-white hover:bg-orange-600' : 'hover:border-orange-500 hover:text-orange-500'}`}
                          onClick={(e) => { e.stopPropagation(); handleReview(m.id, 'flagged') }}
                        >
                          <Flag size={13} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{t('concept_mapping.flag')}</TooltipContent>
                    </Tooltip>
                  </>
                )
              })()}
            </span>
          )
        },
        size: 160,
        minSize: 160,
        enableResizing: false,
      })
    }

    return cols
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, editMode, selected, pageAllSelected, handleReview, toggleSelect, setReviewsMappingId, setCommentsMappingId, currentUser, pageItems])

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
    <>
    <ReviewsSheet
      mappingId={reviewsMappingId}
      open={!!reviewsMappingId}
      onOpenChange={(open) => { if (!open) setReviewsMappingId(null) }}
    />
    <CommentsSheet
      mappingId={commentsMappingId}
      open={!!commentsMappingId}
      onOpenChange={(open) => { if (!open) setCommentsMappingId(null) }}
    />
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
          {/* Filter popover */}
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant={includedStatuses.size < FILTER_STATUSES.length ? 'default' : 'outline'}
                    size="icon-sm"
                    className="h-7 w-7"
                  >
                    <Filter size={12} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.table_filter_title')}</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" className="w-64 p-3" onClick={(e) => e.stopPropagation()}>
              <p className="mb-2 text-xs font-medium">{t('concept_mapping.table_filter_title')}</p>
              <div className="space-y-2">
                {FILTER_STATUSES.map((status) => {
                  const count = statusCounts[status] ?? 0
                  const checked = includedStatuses.has(status)
                  return (
                    <div key={status}>
                      <label className="flex cursor-pointer items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setIncludedStatuses((prev) => {
                            const next = new Set(prev)
                            if (next.has(status)) next.delete(status); else next.add(status)
                            return next
                          })}
                          className="size-3.5 rounded border-gray-300 accent-primary"
                        />
                        <span className="text-xs">{t(`concept_mapping.status_${status}`)}</span>
                        <Badge variant="secondary" className="text-[10px] ml-auto">{count}</Badge>
                      </label>
                      {status === 'approved' && checked && (
                        <div className="ml-6 mt-1.5 space-y-1">
                          {(['at_least_one', 'majority', 'no_rejections'] as ApprovalRule[]).map((rule) => (
                            <label key={rule} className="flex cursor-pointer items-center gap-2">
                              <input
                                type="radio"
                                name="mapping-approval-rule"
                                checked={approvalRule === rule}
                                onChange={() => setApprovalRule(rule)}
                                className="size-3 accent-primary"
                              />
                              <span className="text-[11px] text-muted-foreground">
                                {t(`concept_mapping.export_rule_${rule}`)}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant={editMode ? 'default' : 'outline'}
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={toggleEditMode}
          >
            <Pencil size={12} />
            {editMode ? t('concept_mapping.done_editing') : t('concept_mapping.edit_mode')}
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto" style={{ paddingRight: 'calc(var(--spacing) * 2.5)' }}>
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
                      className="relative select-none overflow-hidden text-xs"
                      style={{ width: header.getSize(), maxWidth: header.getSize() }}
                    >
                      {isSortable ? (
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-1 hover:text-foreground"
                          onClick={() => handleSort(colId)}
                        >
                          {(() => {
                            const hDef = header.column.columnDef.header
                            const label = typeof hDef === 'function'
                              ? hDef(header.getContext())
                              : hDef
                            const titleText = typeof label === 'string' ? label : undefined
                            return (
                              <span className="truncate" title={titleText}>
                                {flexRender(hDef, header.getContext())}
                              </span>
                            )
                          })()}
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

      {/* Pagination + column visibility */}
      <div className="flex shrink-0 items-center justify-between border-t px-4 py-1.5">
        <div className="flex items-center gap-2">
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
              {table.getAllColumns()
                .filter((col) => !col.id.startsWith('_'))
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
    </>
  )
}
