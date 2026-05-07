import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  Check, Flag, X, MessageSquare, EyeOff, Eye,
  Pencil, Trash2, Square, CheckSquare,
  Settings2, ArrowUpDown, ArrowUp, ArrowDown, Users, Filter,
  Upload, Download, ArrowLeft, Loader2, ChevronLeft, ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
// Select imports removed — ColumnFilterSelect now uses DropdownMenu
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
import { Card } from '@/components/ui/card'
import { SectionRenderer, extractSections, extractTextFields } from './components/ConceptDetailView'
import { useRequireIdentity } from './components/IdentityRequiredDialog'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useAppStore } from '@/stores/app-store'
import { queryDataSource, fileSourceDataSourceId, isFileSourceMounted, mountFileSourceIntoDuckDB } from '@/lib/duckdb/engine'
import type { MappingProject, ConceptMapping, MappingComment, MappingReview, MappingStatus, EffectiveMappingStatus, DataSource } from '@/types'
import { useDataSourceStore } from '@/stores/data-source-store'
import { buildAllConceptCountsQuery } from '@/lib/concept-mapping/mapping-queries'
import { effectiveMappingStatus } from '@/lib/concept-mapping/mapping-status'
import { escSql } from '@/lib/format-helpers'
import { getStorage } from '@/lib/storage'

// Sentinel id prefix for synthetic rows that represent mappings made in another project.
const EXTERNAL_PREFIX = 'external::'

interface MappingsTabProps {
  project: MappingProject
  dataSource?: DataSource
}

const PAGE_SIZE = 50

// ─── Status badge styling ────────────────────────────────────────────

const STATUS_BADGE: Record<EffectiveMappingStatus, string> = {
  unchecked: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  flagged: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400',
  invalid: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400',
  ignored: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
  disputed: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
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

/** Column filter state for MappingsTab. Multi-select dropdowns use arrays — empty/undefined = no filter. */
interface MappingColumnFilters {
  sourceConceptName?: string
  sourceConceptCode?: string
  sourceVocabularyId?: string[]
  sourceCategoryId?: string[]
  targetConceptName?: string
  targetConceptId?: string
  targetVocabularyId?: string[]
  targetDomainId?: string[]
  equivalence?: string[]
  mappedBy?: string
}

type ApprovalRule = 'at_least_one' | 'majority' | 'no_rejections'
type OriginFilter = 'all' | 'local' | 'external'
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
  const { requireIdentity, dialog: identityDialog } = useRequireIdentity()
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
    if (!requireIdentity()) return
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
    <>
    {identityDialog}
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
                    <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{c.text}</p>
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
    </>
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
  const { requireIdentity, dialog: identityDialog } = useRequireIdentity()

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

  const isOwnMapping = mapping.mappedBy === currentUser

  const handleReview = (status: MappingStatus) => {
    if (!requireIdentity()) return
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
    <>
    {identityDialog}
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[540px] flex-col gap-0 p-0 sm:max-w-[540px]">
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
            {isOwnMapping && (
              <p className="text-xs text-muted-foreground italic">{t('concept_mapping.cannot_review_own')}</p>
            )}
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
                disabled={isOwnMapping}
              >
                <Check size={12} />
                {t('concept_mapping.approve')}
              </Button>
              <Button
                size="sm"
                className={`h-8 text-xs gap-1 ${myReview?.status === 'rejected' ? 'bg-red-600 hover:bg-red-700 text-white' : ''}`}
                variant={myReview?.status === 'rejected' ? 'default' : 'outline'}
                onClick={() => handleReview('rejected')}
                disabled={isOwnMapping}
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
    </>
  )
}

// ─── Mapping Detail View (split source / target) ─────────────────────

interface SourceCounts { record_count: number; patient_count: number }
/** undefined = still loading, null = no data available */
interface SourceDetail { counts: SourceCounts | null; infoJson: Record<string, unknown> | null | undefined }

function MappingDetailView({ mapping, sourceDetail, onBack, onReview, currentUser, isExternal, externalProjectName, onOpenComments, onOpenReviews, position, onPrev, onNext }: {
  mapping: ConceptMapping
  sourceDetail: SourceDetail
  onBack: () => void
  onReview: (mappingId: string, target: MappingStatus) => void | Promise<void>
  currentUser: string
  isExternal: boolean
  externalProjectName?: string
  onOpenComments: (mappingId: string) => void
  onOpenReviews: (mappingId: string) => void
  /** 1-based index in the parent's filtered/sorted list, plus the total count. */
  position?: { index: number; total: number }
  onPrev?: () => void
  onNext?: () => void
}) {
  const { t } = useTranslation()
  const myReview = (mapping.reviews ?? []).find((r) => r.reviewerId === currentUser)?.status ?? 'unchecked'
  const isOwn = mapping.mappedBy === currentUser
  const commentsCount = (mapping.comments ?? []).length
  const reviewsCount = (mapping.reviews ?? []).length

  const formatDate = (iso?: string) => {
    if (!iso) return '—'
    const d = new Date(iso)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }

  const equivBadge = EQUIV_BADGE[mapping.equivalence]
  const effectiveStatus = effectiveMappingStatus(mapping)
  const statusBadge = STATUS_BADGE[effectiveStatus]

  const renderField = (label: string, value: string | number | undefined | null, mono?: boolean) => {
    if (value == null || value === '') return null
    return (
      <tr>
        <td className="whitespace-nowrap pr-4 py-1 text-muted-foreground align-top text-xs">{label}</td>
        <td className={`py-1 text-xs font-medium ${mono ? 'font-mono' : ''}`}>{value}</td>
      </tr>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft size={16} />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold" title={mapping.sourceConceptName}>
              {mapping.sourceConceptName}
            </span>
            <span className="text-xs text-muted-foreground">→</span>
            <span className="truncate text-sm font-semibold" title={mapping.targetConceptName}>
              {mapping.targetConceptName || t('concept_mapping.no_mapping_needed')}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {equivBadge && (
              <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] font-medium ${equivBadge.className}`}>
                {equivBadge.label}
              </Badge>
            )}
            <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] font-medium ${statusBadge}`}>
              {t(`concept_mapping.status_${effectiveStatus}`)}
            </Badge>
            {isExternal && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[9px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
                {t('concept_mapping.from_project')}{externalProjectName ? `: ${externalProjectName}` : ''}
              </Badge>
            )}
            {mapping.mappedBy && <span>· {mapping.mappedBy}</span>}
            {mapping.mappedOn && <span>· {formatDate(mapping.mappedOn)}</span>}
          </div>
        </div>

        {/* Prev / next nav across the parent list (filtered + sorted) */}
        {position && (
          <div className="flex items-center gap-1 mr-1">
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="size-7"
                  onClick={onPrev}
                  disabled={!onPrev || position.index <= 1}
                >
                  <ChevronLeft size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.detail_prev')}</TooltipContent>
            </Tooltip>
            <span className="text-[11px] tabular-nums text-muted-foreground min-w-[3.5rem] text-center">
              {position.index} / {position.total}
            </span>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="size-7"
                  onClick={onNext}
                  disabled={!onNext || position.index >= position.total}
                >
                  <ChevronRight size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.detail_next')}</TooltipContent>
            </Tooltip>
            <span className="mx-1 h-5 w-px bg-border" />
          </div>
        )}

        {/* Inline voting buttons */}
        <div className="flex items-center gap-1">
          {/* Comments + Reviews (disabled on external rows — comments/reviews live on the local copy) */}
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className={`relative size-7 ${commentsCount > 0 ? 'border-primary/50 text-primary' : ''}`}
                onClick={() => { if (!isExternal) onOpenComments(mapping.id) }}
                disabled={isExternal}
              >
                <MessageSquare size={14} />
                {commentsCount > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
                    {commentsCount}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{isExternal ? t('concept_mapping.external_action_disabled') : t('concept_mapping.comments')}</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className={`relative size-7 ${reviewsCount > 0 ? 'border-primary/50 text-primary' : ''}`}
                onClick={() => { if (!isExternal) onOpenReviews(mapping.id) }}
                disabled={isExternal}
              >
                <Users size={14} />
                {reviewsCount > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
                    {reviewsCount}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{isExternal ? t('concept_mapping.external_action_disabled') : t('concept_mapping.reviews_title')}</TooltipContent>
          </Tooltip>
          <span className="mx-1 h-5 w-px bg-border" />
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant={myReview === 'approved' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-7 ${myReview === 'approved' ? 'bg-green-600 text-white hover:bg-green-700' : 'hover:border-green-600 hover:text-green-600'}`}
                onClick={() => onReview(mapping.id, 'approved')}
                disabled={isOwn && !isExternal}
              >
                <Check size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{(isOwn && !isExternal) ? t('concept_mapping.cannot_review_own') : t('concept_mapping.approve')}</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant={myReview === 'rejected' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-7 ${myReview === 'rejected' ? 'bg-red-600 text-white hover:bg-red-700' : 'hover:border-red-600 hover:text-red-600'}`}
                onClick={() => onReview(mapping.id, 'rejected')}
                disabled={isOwn && !isExternal}
              >
                <X size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{(isOwn && !isExternal) ? t('concept_mapping.cannot_review_own') : t('concept_mapping.reject')}</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant={myReview === 'flagged' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-7 ${myReview === 'flagged' ? 'bg-orange-500 text-white hover:bg-orange-600' : 'hover:border-orange-500 hover:text-orange-500'}`}
                onClick={() => onReview(mapping.id, 'flagged')}
              >
                <Flag size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.flag')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Split view */}
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x overflow-hidden">
        {/* Left: Source concept */}
        <div className="overflow-auto p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('concept_mapping.detail_source')}
          </h3>
          <Card className="p-3">
            <table className="w-full text-xs">
              <tbody>
                {renderField(t('concept_mapping.col_source_vocabulary'), mapping.sourceVocabularyId)}
                {renderField(t('concept_mapping.col_category'), mapping.sourceCategoryId)}
                {renderField(t('concept_mapping.col_subcategory'), mapping.sourceSubcategoryId)}
                {renderField(t('concept_mapping.col_source_concept_name'), mapping.sourceConceptName)}
                {renderField(t('concept_mapping.col_source_concept_code'), mapping.sourceConceptCode, true)}
                {sourceDetail.counts && renderField(t('concept_mapping.col_patients'), sourceDetail.counts.patient_count.toLocaleString())}
                {sourceDetail.counts && renderField(t('concept_mapping.col_records'), sourceDetail.counts.record_count.toLocaleString())}
                {!sourceDetail.counts && mapping.sourceFrequency != null && renderField(t('concept_mapping.col_records'), mapping.sourceFrequency.toLocaleString())}
                {renderField(t('concept_mapping.col_domain_id'), mapping.sourceDomainId)}
                {renderField(t('concept_mapping.col_concept_class_id'), mapping.sourceConceptClassId)}
              </tbody>
            </table>
          </Card>

          {/* Source concept statistics (from info_json) */}
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('concept_mapping.detail_statistics')}
            </h4>
            {sourceDetail.infoJson === undefined ? (
              /* Still loading */
              <Card className="p-3">
                <div className="flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
                </div>
              </Card>
            ) : sourceDetail.infoJson ? (() => {
              const textFields = extractTextFields(sourceDetail.infoJson!)
              const sections = extractSections(sourceDetail.infoJson!, t)
              if (textFields.length === 0 && sections.length === 0) {
                return (
                  <Card className="p-3">
                    <p className="text-xs text-muted-foreground italic">{t('concept_mapping.detail_no_info')}</p>
                  </Card>
                )
              }
              return (
                <div className="space-y-3">
                  {textFields.length > 0 && (
                    <Card className="p-3">
                      <table className="w-full text-xs">
                        <tbody>
                          {textFields.map((item) => (
                            <tr key={item.label}>
                              <td className="whitespace-nowrap pr-4 py-0.5 text-muted-foreground align-top">{item.label}</td>
                              <td className="py-0.5 font-medium" title={item.value}>{item.value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Card>
                  )}
                  {sections.map((section, i) => (
                    <SectionRenderer key={i} section={section} />
                  ))}
                </div>
              )
            })() : (
              <Card className="p-3">
                <p className="text-xs text-muted-foreground italic">{t('concept_mapping.detail_no_info')}</p>
              </Card>
            )}
          </div>
        </div>

        {/* Right: Target concept */}
        <div className="overflow-auto p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('concept_mapping.detail_target')}
          </h3>
          <Card className="p-3">
            {mapping.status === 'ignored' || (mapping.targetConceptId === 0 && !mapping.targetConceptName) ? (
              <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                <EyeOff size={12} />
                <span className="italic">{t('concept_mapping.no_mapping_needed')}</span>
              </div>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {renderField(t('concept_mapping.col_target_vocabulary'), mapping.targetVocabularyId)}
                  {renderField(t('concept_mapping.col_target_concept_id'), mapping.targetConceptId, true)}
                  {renderField(t('concept_mapping.col_target_concept_name'), mapping.targetConceptName)}
                  {renderField(t('concept_mapping.col_source_concept_code'), mapping.targetConceptCode, true)}
                  {renderField(t('concept_mapping.col_domain_id'), mapping.targetDomainId)}
                  {renderField(t('concept_mapping.col_concept_class_id'), mapping.targetConceptClassId)}
                  {renderField(t('concept_mapping.col_std'), mapping.targetStandardConcept)}
                </tbody>
              </table>
            )}
          </Card>

          {/* Mapping metadata */}
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('concept_mapping.detail_metadata')}
            </h4>
            <Card className="p-3">
              <table className="w-full text-xs">
                <tbody>
                  <tr>
                    <td className="whitespace-nowrap pr-4 py-1 text-muted-foreground align-top text-xs">{t('concept_mapping.col_equivalence')}</td>
                    <td className="py-1 text-xs">
                      {equivBadge ? (
                        <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] font-medium ${equivBadge.className}`}>
                          {equivBadge.label}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">{mapping.equivalence}</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td className="whitespace-nowrap pr-4 py-1 text-muted-foreground align-top text-xs">Status</td>
                    <td className="py-1 text-xs">
                      <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] font-medium ${statusBadge}`}>
                        {t(`concept_mapping.status_${effectiveStatus}`)}
                      </Badge>
                    </td>
                  </tr>
                  {mapping.matchScore != null && renderField(t('concept_mapping.detail_match_score'), `${Math.round(mapping.matchScore * 100)}%`)}
                  {renderField(t('concept_mapping.col_mapped_by'), mapping.mappedBy)}
                  {renderField(t('concept_mapping.col_created_at'), formatDate(mapping.createdAt))}
                  {renderField(t('concept_mapping.detail_updated_at'), formatDate(mapping.updatedAt))}
                </tbody>
              </table>
            </Card>
          </div>

          {/* Comments */}
          {(mapping.comments ?? []).length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('concept_mapping.comments')} ({(mapping.comments ?? []).length})
              </h4>
              <div className="space-y-1.5">
                {(mapping.comments ?? []).map((c) => (
                  <div key={c.id} className="rounded-lg border bg-muted/30 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium">{c.authorId}</span>
                      <span className="text-[10px] text-muted-foreground">{formatDate(c.createdAt)}</span>
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{c.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reviews */}
          {(mapping.reviews ?? []).length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('concept_mapping.reviews_title')} ({(mapping.reviews ?? []).length})
              </h4>
              <div className="space-y-1.5">
                {(mapping.reviews ?? []).map((r) => (
                  <div key={r.id} className="rounded-lg border bg-muted/30 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium">{r.reviewerId}</span>
                      <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] font-medium ${STATUS_BADGE[r.status] ?? ''}`}>
                        {t(`concept_mapping.status_${r.status}`)}
                      </Badge>
                    </div>
                    {r.comment && <p className="mt-0.5 text-xs text-muted-foreground">{r.comment}</p>}
                    <p className="mt-0.5 text-[10px] text-muted-foreground">{formatDate(r.createdAt)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function MappingsTab({ project, dataSource }: MappingsTabProps) {
  const { t } = useTranslation()
  const { mappings, updateMapping, deleteMapping, createMappingsBatch, importExternalMapping, loadOtherProjectsDetails, loadProjectMappings } = useConceptMappingStore()
  const otherProjectsMappings = useConceptMappingStore((s) => s.otherProjectsMappings)
  const getUserDisplayName = useAppStore((s) => s.getUserDisplayName)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const currentUser = getUserDisplayName()
  const { requireIdentity, dialog: identityDialog } = useRequireIdentity()

  // Load cross-project mapping details (needed to render synthetic external rows in this tab).
  // Cached in the store so this is a no-op if Editor tab already triggered it.
  useEffect(() => {
    if (project.workspaceId) loadOtherProjectsDetails(project.id, project.workspaceId)
  }, [project.id, project.workspaceId, loadOtherProjectsDetails])

  // Source-concept-id registry: resolve `(vocabulary, code) → assigned id` via the project's badges.
  // First badge in the project's badge list wins on conflict.
  const [sourceConceptIdMap, setSourceConceptIdMap] = useState<Map<string, number>>(new Map())
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const wsId = project.workspaceId
      const badgeLabels = (project.badges ?? []).map((b) => b.label).filter(Boolean)
      if (!wsId || badgeLabels.length === 0) {
        if (!cancelled) setSourceConceptIdMap(new Map())
        return
      }
      const storage = getStorage()
      const map = new Map<string, number>()
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

  const [colFilters, setColFilters] = useState<MappingColumnFilters>({})
  const [sorting, setSorting] = useState<{ columnId: string; desc: boolean } | null>(null)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [editMode, setEditMode] = useState(false)
  const [detailMapping, setDetailMapping] = useState<ConceptMapping | null>(null)
  const [detailSource, setDetailSource] = useState<SourceDetail>({ counts: null, infoJson: undefined })
  const savedScrollTop = useRef(0)

  // Cache concept counts from DuckDB (computed once per data source)
  const countsCache = useRef<Map<number, SourceCounts>>(new Map())
  const countsCacheDs = useRef<string | null>(null)

  const isFileSource = project.sourceType === 'file'
  /** True when source is a file with no conceptIdColumn — `m.sourceConceptId` is then an
   *  artificial row-number index, not a real OMOP concept_id. The registry is authoritative. */
  const useRegistryForId = isFileSource && !project.fileSourceData?.columnMapping?.conceptIdColumn

  /** Parse a raw info_json value (string or object) into a Record. */
  const parseInfoJson = (raw: unknown): Record<string, unknown> | null => {
    if (raw && typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch { /* ignore parse errors */ }
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>
    }
    return null
  }

  /** Fetch source concept detail (counts + info_json) from DuckDB. */
  const fetchSourceDetail = useCallback(async (mapping: ConceptMapping): Promise<SourceDetail> => {
    const detail: SourceDetail = { counts: null, infoJson: null }

    try {
      if (isFileSource && project.fileSourceData) {
        const dsId = fileSourceDataSourceId(project.id)
        if (!isFileSourceMounted(project.id)) {
          await mountFileSourceIntoDuckDB(
            project.id,
            project.fileSourceData.rows,
            project.fileSourceData.columnMapping,
            project.fileSourceData.rawFileBuffer,
          )
        }
        // Look up by vocabulary + concept_code (the natural key — concept_id is just row_number())
        const clauses: string[] = []
        clauses.push(`concept_code = '${escSql(mapping.sourceConceptCode)}'`)
        if (mapping.sourceVocabularyId) clauses.push(`vocabulary_id = '${escSql(mapping.sourceVocabularyId)}'`)
        const rows = await queryDataSource(dsId, `SELECT * FROM source_concepts WHERE ${clauses.join(' AND ')} LIMIT 1`)
        if (rows.length > 0) {
          const r = rows[0] as Record<string, unknown>
          detail.counts = { record_count: Number(r.record_count ?? 0), patient_count: Number(r.patient_count ?? 0) }
          countsCache.current.set(mapping.sourceConceptId, detail.counts)
          if ('info_json' in r) {
            detail.infoJson = parseInfoJson(r.info_json)
          }
        }
      } else if (dataSource) {
        // Database source: build counts query if not already cached for this DS
        const dsId = dataSource.id
        if (countsCacheDs.current !== dsId) {
          await ensureMounted(dsId)
          const schemaMapping = dataSource.schemaMapping
          if (schemaMapping) {
            const countsSql = buildAllConceptCountsQuery(schemaMapping)
            if (countsSql) {
              const rows = await queryDataSource(dsId, countsSql)
              countsCache.current.clear()
              for (const r of rows as Record<string, unknown>[]) {
                countsCache.current.set(Number(r.concept_id), {
                  record_count: Number(r.record_count ?? 0),
                  patient_count: Number(r.patient_count ?? 0),
                })
              }
            }
          }
          countsCacheDs.current = dsId
        }
        detail.counts = countsCache.current.get(mapping.sourceConceptId) ?? null
      }
    } catch (err) {
      console.warn('Failed to fetch source detail:', err)
    }
    return detail
  }, [isFileSource, project, dataSource, ensureMounted])

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [reviewsMappingId, setReviewsMappingId] = useState<string | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [includedStatuses, setIncludedStatuses] = useState<Set<MappingStatus>>(new Set(FILTER_STATUSES))
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all')
  // Filter by current user's review on each mapping. 'all' = no filter.
  // 'unchecked' = the current user has NOT voted yet.
  const [myReviewFilter, setMyReviewFilter] = useState<'all' | 'approved' | 'rejected' | 'flagged' | 'unchecked'>('all')
  const [commentsMappingId, setCommentsMappingId] = useState<string | null>(null)
  const [approvalRule, setApprovalRule] = useState<ApprovalRule>('at_least_one')
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    createdAt: false,
    sourceCategoryId: false,
    sourceSubcategoryId: false,
    sourceConceptCode: false,
    sourceConceptId: false,
    targetConceptId: false,
  })
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})

  const projectMappings = mappings.filter((m) => m.projectId === project.id)

  // Build synthetic "external" rows for source concepts mapped only in other projects.
  // Each external mapping gets a sentinel id prefixed with EXTERNAL_PREFIX so we can detect it.
  const externalMappings = useMemo<ConceptMapping[]>(() => {
    if (!otherProjectsMappings || otherProjectsMappings.size === 0) return []
    // Skip external mappings whose (vocab, code, target) already exists locally to avoid duplicates
    const localKeys = new Set(
      projectMappings.map((m) => `${m.sourceVocabularyId}\0${m.sourceConceptCode}\0${m.targetConceptId}`),
    )
    const result: ConceptMapping[] = []
    for (const list of otherProjectsMappings.values()) {
      for (const info of list) {
        const key = `${info.mapping.sourceVocabularyId}\0${info.mapping.sourceConceptCode}\0${info.mapping.targetConceptId}`
        if (localKeys.has(key)) continue
        result.push({ ...info.mapping, id: `${EXTERNAL_PREFIX}${info.sourceProjectId}::${info.mapping.id}` })
      }
    }
    return result
  }, [otherProjectsMappings, projectMappings])

  // Combined list: local + external (used for display)
  const allDisplayMappings = useMemo(
    () => [...projectMappings, ...externalMappings],
    [projectMappings, externalMappings],
  )

  /** Resolve a display row id back to the underlying ExternalMappingInfo (or null for local rows). */
  const resolveExternal = useCallback((id: string) => {
    if (!id.startsWith(EXTERNAL_PREFIX)) return null
    const rest = id.slice(EXTERNAL_PREFIX.length)
    const sepIdx = rest.indexOf('::')
    if (sepIdx < 0) return null
    const sourceProjectId = rest.slice(0, sepIdx)
    const mappingId = rest.slice(sepIdx + 2)
    for (const list of otherProjectsMappings.values()) {
      const info = list.find((i) => i.sourceProjectId === sourceProjectId && i.mapping.id === mappingId)
      if (info) return info
    }
    return null
  }, [otherProjectsMappings])

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

  // Per-mapping derived view: computed once when `allDisplayMappings` changes, then
  // looked up O(1) in filters, sort, and column cells. This avoids re-walking each
  // mapping's `reviews` array on every render (5+ filters × thousands of rows).
  interface RowDerived {
    eff: MappingStatus
    approvedCount: number
    rejectedCount: number
    flaggedCount: number
    myReviewStatus: MappingStatus | undefined
  }
  const rowDerived = useMemo(() => {
    const map = new Map<string, RowDerived>()
    for (const m of allDisplayMappings) {
      const reviews = m.reviews
      let approvedCount = 0
      let rejectedCount = 0
      let flaggedCount = 0
      let myReviewStatus: MappingStatus | undefined
      if (reviews && reviews.length > 0) {
        for (const r of reviews) {
          if (r.status === 'approved') approvedCount++
          else if (r.status === 'rejected') rejectedCount++
          else if (r.status === 'flagged') flaggedCount++
          if (r.reviewerId === currentUser) myReviewStatus = r.status
        }
      }
      // Effective status: majority among decisive votes. With ties, approved wins,
      // then rejected, then flagged. Falls back to the stored `status` when no vote.
      let eff: MappingStatus = m.status
      if (approvedCount + rejectedCount + flaggedCount > 0) {
        const max = Math.max(approvedCount, rejectedCount, flaggedCount)
        if (approvedCount === max) eff = 'approved'
        else if (rejectedCount === max) eff = 'rejected'
        else eff = 'flagged'
      }
      map.set(m.id, { eff, approvedCount, rejectedCount, flaggedCount, myReviewStatus })
    }
    return map
  }, [allDisplayMappings, currentUser])

  // Backwards-compatible accessor used elsewhere in the component.
  const effectiveStatus = useCallback((m: ConceptMapping): MappingStatus => {
    return rowDerived.get(m.id)?.eff ?? m.status
  }, [rowDerived])

  // Apply column filters + status popover filter (client-side)
  const filtered = useMemo(() => allDisplayMappings.filter((m) => {
    const f = colFilters
    if (f.sourceConceptName && !textMatch(m.sourceConceptName, f.sourceConceptName)) return false
    if (f.sourceConceptCode && !(m.sourceConceptCode || String(m.sourceConceptId)).toLowerCase().includes(f.sourceConceptCode.toLowerCase())) return false
    if (f.sourceVocabularyId?.length && !f.sourceVocabularyId.includes(m.sourceVocabularyId)) return false
    if (f.sourceCategoryId?.length && !f.sourceCategoryId.includes(m.sourceCategoryId ?? '')) return false
    if (f.targetConceptName && !textMatch(m.targetConceptName, f.targetConceptName)) return false
    if (f.targetConceptId && !String(m.targetConceptId).includes(f.targetConceptId)) return false
    if (f.targetVocabularyId?.length && !f.targetVocabularyId.includes(m.targetVocabularyId)) return false
    if (f.targetDomainId?.length && !f.targetDomainId.includes(m.targetDomainId ?? '')) return false
    if (f.equivalence?.length && !f.equivalence.includes(m.equivalence)) return false
    if (f.mappedBy && !(m.mappedBy ?? '').toLowerCase().includes(f.mappedBy.toLowerCase())) return false
    // Origin filter (status dot quick filter)
    const isExternalRow = m.id.startsWith(EXTERNAL_PREFIX)
    if (originFilter === 'local' && isExternalRow) return false
    if (originFilter === 'external' && !isExternalRow) return false
    // Pre-computed derived view (eff status, vote counts, my review) — O(1) lookup.
    const d = rowDerived.get(m.id)
    // "My review" filter (under the Review column)
    if (myReviewFilter !== 'all') {
      const myStatus = d?.myReviewStatus
      if (myReviewFilter === 'unchecked') {
        if (myStatus) return false
      } else if (myStatus !== myReviewFilter) {
        return false
      }
    }
    // Status popover filter
    const eff = d?.eff ?? m.status
    if (!includedStatuses.has(eff)) return false
    // Approval rule sub-filter
    if (eff === 'approved' && includedStatuses.has('approved') && approvalRule !== 'at_least_one') {
      const approvedCount = d?.approvedCount ?? 0
      const rejectedCount = d?.rejectedCount ?? 0
      if (approvalRule === 'majority' && !(approvedCount > rejectedCount)) return false
      if (approvalRule === 'no_rejections' && rejectedCount > 0) return false
    }
    return true
  }), [allDisplayMappings, colFilters, originFilter, myReviewFilter, includedStatuses, approvalRule, rowDerived])

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

  const visibleItems = sorted.slice(0, visibleCount)
  const hasMore = visibleCount < sorted.length

  // Reset visible count when filters/sorting change
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [colFilters, sorting, includedStatuses, approvalRule, originFilter, myReviewFilter])

  // Infinite scroll
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const hasMoreRef = useRef(hasMore)
  hasMoreRef.current = hasMore

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const onScroll = () => {
      if (!hasMoreRef.current) return
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
        setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, sorted.length))
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [sorted.length])

  const handleSort = (columnId: string) => {
    if (sorting?.columnId === columnId) {
      if (sorting.desc) setSorting({ columnId, desc: false })
      else setSorting(null)
    } else {
      setSorting({ columnId, desc: true })
    }
  }

  const updateFilter = (key: keyof MappingColumnFilters, value: string | null) => {
    setColFilters((prev) => ({ ...prev, [key]: value ?? undefined }))
  }

  const updateMultiFilter = (key: keyof MappingColumnFilters, values: string[]) => {
    setColFilters((prev) => ({ ...prev, [key]: values.length ? values : undefined }))
  }

  /** Render inline column filter for a given column. */
  const renderColumnFilter = (columnId: string) => {
    if (columnId === '_status') {
      const triggerDot = originFilter === 'external'
        ? 'bg-blue-500'
        : originFilter === 'local'
          ? 'bg-green-500'
          : null
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={`flex h-6 w-full items-center justify-center rounded border border-dashed hover:bg-accent ${originFilter !== 'all' ? 'border-primary' : ''}`}>
              {triggerDot ? (
                <span className={`inline-block size-2 rounded-full ${triggerDot}`} />
              ) : (
                <span className="text-[10px] text-muted-foreground">●</span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48" onCloseAutoFocus={(e) => e.preventDefault()}>
            {(['all', 'local', 'external'] as OriginFilter[]).map((opt) => (
              <DropdownMenuCheckboxItem
                key={opt}
                checked={originFilter === opt}
                onCheckedChange={() => setOriginFilter(opt)}
                onSelect={(e) => e.preventDefault()}
                className="text-xs"
              >
                <span className="flex items-center gap-2">
                  {opt === 'external' && <span className="inline-block size-2 rounded-full bg-blue-500" />}
                  {opt === 'local' && <span className="inline-block size-2 rounded-full bg-green-500" />}
                  {t(`concept_mapping.filter_origin_${opt}`)}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }
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
    // Dropdowns (multi-select)
    if (columnId === 'sourceVocabularyId' && filterOptions.sourceVocabularyId.length > 0) {
      return <MultiSelectFilter value={colFilters.sourceVocabularyId ?? []} options={filterOptions.sourceVocabularyId} placeholder="Vocab" onChange={(v) => updateMultiFilter('sourceVocabularyId', v)} />
    }
    if (columnId === 'sourceCategoryId' && filterOptions.sourceCategoryId.length > 0) {
      return <MultiSelectFilter value={colFilters.sourceCategoryId ?? []} options={filterOptions.sourceCategoryId} placeholder="..." onChange={(v) => updateMultiFilter('sourceCategoryId', v)} />
    }
    if (columnId === 'targetVocabularyId' && filterOptions.targetVocabularyId.length > 0) {
      return <MultiSelectFilter value={colFilters.targetVocabularyId ?? []} options={filterOptions.targetVocabularyId} placeholder="Vocab" onChange={(v) => updateMultiFilter('targetVocabularyId', v)} />
    }
    if (columnId === 'targetDomainId' && filterOptions.targetDomainId.length > 0) {
      return <MultiSelectFilter value={colFilters.targetDomainId ?? []} options={filterOptions.targetDomainId} placeholder="Domain" onChange={(v) => updateMultiFilter('targetDomainId', v)} />
    }
    if (columnId === 'equivalence' && filterOptions.equivalence.length > 0) {
      const equivOptions = filterOptions.equivalence.map((e) => ({ value: e, label: EQUIV_BADGE[e]?.label ?? e }))
      return <MultiSelectFilter value={colFilters.equivalence ?? []} options={equivOptions} placeholder="Equiv" onChange={(v) => updateMultiFilter('equivalence', v)} />
    }
    if (columnId === '_review') {
      const opts: { value: typeof myReviewFilter; icon?: ReactNode }[] = [
        { value: 'all' },
        { value: 'approved', icon: <Check size={11} className="text-green-600" /> },
        { value: 'rejected', icon: <X size={11} className="text-red-600" /> },
        { value: 'flagged', icon: <Flag size={11} className="text-orange-500" /> },
        { value: 'unchecked' },
      ]
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={`flex h-6 w-full items-center justify-end gap-1 rounded border border-dashed px-1.5 hover:bg-accent ${myReviewFilter !== 'all' ? 'border-primary text-foreground' : 'text-muted-foreground'}`}>
              {myReviewFilter !== 'all' && opts.find((o) => o.value === myReviewFilter)?.icon}
              <span className="truncate text-[10px]">{t(`concept_mapping.my_review_filter_${myReviewFilter}`)}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t('concept_mapping.my_review_filter_label')}
            </DropdownMenuLabel>
            {opts.map((o) => (
              <DropdownMenuCheckboxItem
                key={o.value}
                checked={myReviewFilter === o.value}
                onCheckedChange={() => setMyReviewFilter(o.value)}
                onSelect={(e) => e.preventDefault()}
                className="text-xs"
              >
                <span className="flex items-center gap-2">
                  {o.icon}
                  {t(`concept_mapping.my_review_filter_${o.value}`)}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )
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
    const pageIds = visibleItems.map((m) => m.id)
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

  // ─── Import / Export mappings.json ──────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{
    imported: number
    merged: number
    reviewsAdded: number
    commentsAdded: number
    missingSource: number
    total: number
  } | null>(null)

  // ─── Bulk import from other projects ────────────────────────────────

  const [bulkImportOpen, setBulkImportOpen] = useState(false)
  const [bulkSelectedProjects, setBulkSelectedProjects] = useState<string[]>([])
  const [bulkImporting, setBulkImporting] = useState(false)
  const [bulkResult, setBulkResult] = useState<{ imported: number; skipped: number } | null>(null)

  // Distinct source projects across externalMappings (sorted by name).
  const bulkProjectOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const list of otherProjectsMappings.values()) {
      for (const info of list) {
        if (!seen.has(info.sourceProjectId)) seen.set(info.sourceProjectId, info.sourceProjectName)
      }
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [otherProjectsMappings])

  // Number of mappings that would be imported with the current project selection.
  const bulkImportPreviewCount = useMemo(() => {
    if (bulkProjectOptions.length === 0) return 0
    const selected = bulkSelectedProjects.length === 0
      ? new Set(bulkProjectOptions.map((o) => o.value)) // empty selection = all (matches MultiSelectFilter convention)
      : new Set(bulkSelectedProjects)
    let count = 0
    const localKeys = new Set(
      mappings
        .filter((m) => m.projectId === project.id)
        .map((m) => `${m.sourceVocabularyId}\0${m.sourceConceptCode}\0${m.targetConceptId}`),
    )
    for (const list of otherProjectsMappings.values()) {
      for (const info of list) {
        if (!selected.has(info.sourceProjectId)) continue
        const key = `${info.mapping.sourceVocabularyId}\0${info.mapping.sourceConceptCode}\0${info.mapping.targetConceptId}`
        if (localKeys.has(key)) continue
        count++
      }
    }
    return count
  }, [otherProjectsMappings, bulkProjectOptions, bulkSelectedProjects, mappings, project.id])

  const handleBulkImport = useCallback(async () => {
    if (bulkImporting) return
    setBulkImporting(true)
    try {
      const selected = bulkSelectedProjects.length === 0
        ? new Set(bulkProjectOptions.map((o) => o.value))
        : new Set(bulkSelectedProjects)
      const localKeys = new Set(
        mappings
          .filter((m) => m.projectId === project.id)
          .map((m) => `${m.sourceVocabularyId}\0${m.sourceConceptCode}\0${m.targetConceptId}`),
      )
      // Build the full batch in memory first — no await, no React updates per row.
      // Then hand it to createMappingsBatch which writes IDB in a single transaction
      // and triggers exactly one Zustand set() at the end. This avoids the N×re-render
      // pattern that made the Mappings table freeze for several seconds during bulk imports.
      const now = new Date().toISOString()
      const toImport: ConceptMapping[] = []
      let skipped = 0
      for (const list of otherProjectsMappings.values()) {
        for (const info of list) {
          if (!selected.has(info.sourceProjectId)) continue
          const key = `${info.mapping.sourceVocabularyId}\0${info.mapping.sourceConceptCode}\0${info.mapping.targetConceptId}`
          if (localKeys.has(key)) { skipped++; continue }
          // Mirror importExternalMapping shape: full preservation of status / reviews / comments,
          // only identity fields (id, projectId) and timestamps are rewritten.
          toImport.push({
            ...info.mapping,
            id: crypto.randomUUID(),
            projectId: project.id,
            createdAt: now,
            updatedAt: now,
          })
          localKeys.add(key)
        }
      }
      if (toImport.length > 0) {
        await createMappingsBatch(toImport)
      }
      setBulkResult({ imported: toImport.length, skipped })
      setBulkImportOpen(false)
      setBulkSelectedProjects([])
    } finally {
      setBulkImporting(false)
    }
  }, [bulkImporting, bulkSelectedProjects, bulkProjectOptions, mappings, project.id, otherProjectsMappings, createMappingsBatch])

  const handleImportMappings = async (file: File) => {
    if (importing) return
    setImporting(true)
    try {
      const text = await file.text()
      const incoming: ConceptMapping[] = JSON.parse(text)
      if (!Array.isArray(incoming)) return

      // Reload mappings from IDB to make sure we see the current state.
      // Necessary after a workspace re-import where the in-memory store may be stale.
      await loadProjectMappings(project.id, { force: true })
      const freshLocal = useConceptMappingStore.getState().mappings.filter((m) => m.projectId === project.id)

      // Build map: (sourceVocabularyId, sourceConceptCode, targetConceptId) → existing mapping
      const existingByKey = new Map<string, ConceptMapping>()
      for (const m of freshLocal) {
        existingByKey.set(`${m.sourceVocabularyId}\0${m.sourceConceptCode}\0${m.targetConceptId}`, m)
      }

      // Load valid source concept codes from the project's source data
      let validSourceKeys: Set<string> | null = null
      try {
        if (project.sourceType === 'file' && project.fileSourceData) {
          const dsId = fileSourceDataSourceId(project.id)
          if (!isFileSourceMounted(project.id)) {
            await mountFileSourceIntoDuckDB(
              project.id,
              project.fileSourceData.rows,
              project.fileSourceData.columnMapping,
              project.fileSourceData.rawFileBuffer,
            )
          }
          const rows = await queryDataSource(dsId, 'SELECT concept_code, vocabulary_id FROM source_concepts')
          validSourceKeys = new Set(
            rows.map((r: Record<string, unknown>) => `${r.vocabulary_id ?? ''}\0${r.concept_code ?? ''}`),
          )
        }
      } catch {
        // If source validation fails, skip it — still import with duplicates check only
      }

      const now = new Date().toISOString()
      const toImport: ConceptMapping[] = []
      let merged = 0
      let reviewsAdded = 0
      let commentsAdded = 0
      let missingSource = 0

      for (const m of incoming) {
        const key = `${m.sourceVocabularyId}\0${m.sourceConceptCode}\0${m.targetConceptId}`
        const existing = existingByKey.get(key)
        if (existing) {
          // Merge reviews and comments into the existing mapping (dedup by id).
          const existingReviewIds = new Set((existing.reviews ?? []).map((r) => r.id))
          const newReviews = (m.reviews ?? []).filter((r) => !existingReviewIds.has(r.id))

          const existingCommentIds = new Set((existing.comments ?? []).map((c) => c.id))
          // Migrate legacy `comment` string → ephemeral comment for merge
          const legacy = (m as unknown as Record<string, unknown>).comment
          const incomingComments = (!m.comments?.length && typeof legacy === 'string' && legacy.trim())
            ? [{ id: crypto.randomUUID(), authorId: m.mappedBy ?? 'unknown', text: legacy.trim(), createdAt: m.mappedOn ?? now }]
            : (m.comments ?? [])
          const newComments = incomingComments.filter((c) => !existingCommentIds.has(c.id))

          if (newReviews.length === 0 && newComments.length === 0) {
            // Nothing to merge — the existing mapping already contains everything from the file.
            merged++
            continue
          }

          const mergedReviews = [...(existing.reviews ?? []), ...newReviews]
          const mergedComments = [...(existing.comments ?? []), ...newComments]

          // Pick the most recent non-unchecked review across all reviewers as the headline.
          const latestReview = mergedReviews
            .filter((r) => r.status !== 'unchecked')
            .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]

          const changes: Partial<ConceptMapping> = {
            reviews: mergedReviews,
            comments: mergedComments,
          }
          if (latestReview) {
            changes.reviewedBy = latestReview.reviewerId
            changes.reviewedOn = latestReview.createdAt
            // If the existing mapping was still 'unchecked', lift it to the latest review's status.
            if (existing.status === 'unchecked') changes.status = latestReview.status
          }
          await updateMapping(existing.id, changes)
          merged++
          reviewsAdded += newReviews.length
          commentsAdded += newComments.length
          continue
        }
        if (validSourceKeys && !validSourceKeys.has(`${m.sourceVocabularyId}\0${m.sourceConceptCode}`)) {
          missingSource++
          continue
        }
        // Migrate legacy `comment` string → `comments[]` array
        const legacy = (m as unknown as Record<string, unknown>).comment
        const migratedComments = (!m.comments?.length && typeof legacy === 'string' && legacy.trim())
          ? [{ id: crypto.randomUUID(), authorId: m.mappedBy ?? 'unknown', text: legacy.trim(), createdAt: m.mappedOn ?? now }]
          : m.comments
        const newMapping: ConceptMapping = {
          ...m,
          comments: migratedComments,
          id: crypto.randomUUID(),
          projectId: project.id,
          updatedAt: now,
        }
        toImport.push(newMapping)
        // Track within batch to avoid double-imports of the same key
        existingByKey.set(key, newMapping)
      }

      if (toImport.length > 0) {
        await createMappingsBatch(toImport)
      }

      setImportResult({
        imported: toImport.length,
        merged,
        reviewsAdded,
        commentsAdded,
        missingSource,
        total: incoming.length,
      })
    } catch (err) {
      console.error('Failed to import mappings:', err)
    } finally {
      setImporting(false)
    }
  }

  /** Toggle review: clicking the same status resets to unchecked.
   *  For external (cross-project) rows, imports the mapping locally first, then applies the vote. */
  const handleReview = useCallback(async (mappingId: string, target: MappingStatus) => {
    if (!requireIdentity()) return
    const reviewer = getUserDisplayName()

    // External row: import as local copy first, then vote on the new local id.
    let localId = mappingId
    if (mappingId.startsWith(EXTERNAL_PREFIX)) {
      const info = resolveExternal(mappingId)
      if (!info) return
      const local = await importExternalMapping(info, project.id, { createdBy: reviewer })
      if (!local) return
      localId = local.id
    }

    const m = useConceptMappingStore.getState().mappings.find((x) => x.id === localId)
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
    updateMapping(localId, {
      reviews: newReviews,
      reviewedBy: newStatus !== 'unchecked' ? reviewer : undefined,
      reviewedOn: newStatus !== 'unchecked' ? new Date().toISOString() : undefined,
    })
  }, [updateMapping, getUserDisplayName, importExternalMapping, project.id, resolveExternal, requireIdentity])

  const pageAllSelected = visibleItems.length > 0 && visibleItems.every((m) => selected.has(m.id))

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

    // ── Origin dot column ──────────────────────────────────────────
    // Blue = mapping comes from another project, green = mapping created in this project.
    // Voting status (approve/reject/flagged) is shown via the dedicated count columns —
    // the dot only conveys the row's origin since multiple reviews can disagree.
    cols.push({
      id: '_status',
      header: '',
      cell: ({ row }) => {
        const m = row.original
        const isExternal = m.id.startsWith(EXTERNAL_PREFIX)
        const dotColor = isExternal ? 'bg-blue-500' : 'bg-green-500'

        let tooltip: ReactNode
        if (isExternal) {
          const info = resolveExternal(m.id)
          tooltip = (
            <div className="max-w-xs space-y-1">
              <p className="text-xs font-semibold">{t('concept_mapping.status_tip_mapped_elsewhere_one')}</p>
              {info && <p className="text-[10px] text-muted-foreground">{t('concept_mapping.from_project')}: {info.sourceProjectName}</p>}
              <p className="text-[10px] text-muted-foreground">{t('concept_mapping.external_vote_hint')}</p>
            </div>
          )
        } else {
          tooltip = <span className="text-xs">{t('concept_mapping.status_tip_mapped')}</span>
        }

        return (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <span className="flex justify-center">
                <span className={`inline-block size-2 rounded-full ${dotColor}`} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">{tooltip}</TooltipContent>
          </Tooltip>
        )
      },
      size: 28,
      minSize: 28,
      enableResizing: false,
    })

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
        cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.sourceConceptCode ?? ''}</span>,
        size: 100,
        minSize: 50,
      },
      {
        // Source concept ID resolution:
        // - File source without `conceptIdColumn` → registry-only (m.sourceConceptId is an
        //   artificial row-number index, ignore it).
        // - Otherwise (database, or file with conceptIdColumn) → native `m.sourceConceptId`,
        //   falling back to the registry if the native id is missing.
        id: 'sourceConceptId',
        header: () => t('concept_mapping.col_source_concept_id'),
        accessorFn: (row) => {
          const key = `${row.sourceVocabularyId}__${row.sourceConceptCode}`
          if (useRegistryForId) return sourceConceptIdMap.get(key) ?? null
          if (row.sourceConceptId && row.sourceConceptId !== 0) return row.sourceConceptId
          return sourceConceptIdMap.get(key) ?? null
        },
        cell: ({ row }) => {
          const m = row.original
          const key = `${m.sourceVocabularyId}__${m.sourceConceptCode}`
          let id: number | null
          if (useRegistryForId) {
            id = sourceConceptIdMap.get(key) ?? null
          } else if (m.sourceConceptId && m.sourceConceptId !== 0) {
            id = m.sourceConceptId
          } else {
            id = sourceConceptIdMap.get(key) ?? null
          }
          return <span className="font-mono text-muted-foreground">{id ?? <span className="text-muted-foreground/60">—</span>}</span>
        },
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
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] font-medium ${badge.className}`}>
                  {badge.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">{equiv}</TooltipContent>
            </Tooltip>
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
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={t('concept_mapping.no_mapping_needed')}>
                <EyeOff size={10} className="shrink-0" />
                <span className="block min-w-0 flex-1 truncate italic">{t('concept_mapping.no_mapping_needed')}</span>
              </span>
            )
          }
          return (
            <span className="block truncate" title={m.targetConceptName}>{m.targetConceptName}</span>
          )
        },
        size: 200,
        minSize: 100,
      },
      // Hidden by default: target OMOP-specific columns
      {
        id: 'targetDomainId',
        header: () => t('concept_mapping.col_domain_id'),
        accessorFn: (row) => row.targetDomainId,
        cell: ({ row }) => <span className="text-[10px] text-muted-foreground">{row.original.targetDomainId ?? ''}</span>,
        size: 90,
        minSize: 50,
      },
      {
        id: 'targetConceptClassId',
        header: () => t('concept_mapping.col_concept_class_id'),
        accessorFn: (row) => row.targetConceptClassId,
        cell: ({ row }) => <span className="text-[10px] text-muted-foreground">{row.original.targetConceptClassId ?? ''}</span>,
        size: 90,
        minSize: 60,
      },
      {
        id: 'targetStandardConcept',
        header: () => t('concept_mapping.col_std'),
        accessorFn: (row) => row.targetStandardConcept,
        cell: ({ row }) => {
          const sc = row.original.targetStandardConcept
          if (sc === 'S') return <Badge variant="default" className="bg-green-600 px-1 py-0 text-[8px]">S</Badge>
          if (sc === 'C') return <Badge variant="secondary" className="px-1 py-0 text-[8px]">C</Badge>
          return null
        },
        size: 40,
        minSize: 30,
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
      // Counts come from the pre-computed `rowDerived` map — the cell only does an O(1)
      // Map.get() instead of allocating a filtered array on every render.
      {
        id: '_votes_approved',
        header: () => <span className="text-green-600" title={t('concept_mapping.approve')}>✓</span>,
        cell: ({ row }) => {
          const count = rowDerived.get(row.original.id)?.approvedCount ?? 0
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
          const count = rowDerived.get(row.original.id)?.flaggedCount ?? 0
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
          const count = rowDerived.get(row.original.id)?.rejectedCount ?? 0
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
          const isExternal = m.id.startsWith(EXTERNAL_PREFIX)
          return (
            <span className="flex items-center justify-end gap-1">
              <Tooltip delayDuration={700}>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="size-6"
                    onClick={(e) => {
                      e.stopPropagation()
                      savedScrollTop.current = scrollContainerRef.current?.scrollTop ?? 0
                      setDetailMapping(m)
                      setDetailSource({ counts: null, infoJson: undefined })
                      fetchSourceDetail(m).then(setDetailSource)
                    }}
                  >
                    <Eye size={12} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">{t('concept_mapping.view_detail')}</TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={700}>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className={`relative size-6 ${(m.comments ?? []).length > 0 ? 'border-primary/50 text-primary' : ''}`}
                    onClick={(e) => { e.stopPropagation(); if (!isExternal) setCommentsMappingId(m.id) }}
                    disabled={isExternal}
                  >
                    <MessageSquare size={12} />
                    {(m.comments ?? []).length > 0 && (
                      <span className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
                        {(m.comments ?? []).length}
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">{isExternal ? t('concept_mapping.external_action_disabled') : t('concept_mapping.comments')}</TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={700}>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className={`relative size-6 ${(m.reviews ?? []).length > 0 ? 'border-primary/50 text-primary' : ''}`}
                    onClick={(e) => { e.stopPropagation(); if (!isExternal) setReviewsMappingId(m.id) }}
                    disabled={isExternal}
                  >
                    <Users size={12} />
                    {(m.reviews ?? []).length > 0 && (
                      <span className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
                        {(m.reviews ?? []).length}
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">{isExternal ? t('concept_mapping.external_action_disabled') : t('concept_mapping.reviews_title')}</TooltipContent>
              </Tooltip>
              {(() => {
                const myReview = rowDerived.get(m.id)?.myReviewStatus ?? 'unchecked'
                const isOwn = m.mappedBy === currentUser
                return (
                  <>
                    <Tooltip delayDuration={700}>
                      <TooltipTrigger asChild>
                        <Button
                          variant={myReview === 'approved' ? 'default' : 'outline'}
                          size="icon-sm"
                          className={`size-6 ${myReview === 'approved' ? 'bg-green-600 text-white hover:bg-green-700' : 'hover:border-green-600 hover:text-green-600'}`}
                          onClick={(e) => { e.stopPropagation(); handleReview(m.id, 'approved') }}
                          disabled={isOwn}
                        >
                          <Check size={13} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{isOwn ? t('concept_mapping.cannot_review_own') : t('concept_mapping.approve')}</TooltipContent>
                    </Tooltip>
                    <Tooltip delayDuration={700}>
                      <TooltipTrigger asChild>
                        <Button
                          variant={myReview === 'rejected' ? 'default' : 'outline'}
                          size="icon-sm"
                          className={`size-6 ${myReview === 'rejected' ? 'bg-red-600 text-white hover:bg-red-700' : 'hover:border-red-600 hover:text-red-600'}`}
                          onClick={(e) => { e.stopPropagation(); handleReview(m.id, 'rejected') }}
                          disabled={isOwn}
                        >
                          <X size={13} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{isOwn ? t('concept_mapping.cannot_review_own') : t('concept_mapping.reject')}</TooltipContent>
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
        size: 190,
        minSize: 190,
        enableResizing: false,
      })
    }

    return cols
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, editMode, selected, pageAllSelected, handleReview, toggleSelect, setReviewsMappingId, setCommentsMappingId, currentUser, rowDerived, resolveExternal, sourceConceptIdMap, useRegistryForId])

  const table = useReactTable({
    data: visibleItems,
    columns,
    state: { columnVisibility, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: 1,
  })

  // Show detail view when a mapping is selected
  if (detailMapping) {
    const isExternal = detailMapping.id.startsWith(EXTERNAL_PREFIX)
    const externalInfo = isExternal ? resolveExternal(detailMapping.id) : null

    // Try to find the live counterpart:
    // 1) For external rows that have been imported locally during this view, find the local copy
    //    (matched by vocabulary + concept code + target concept id since the import resets the id).
    // 2) Otherwise read directly from the live store by id.
    let liveMapping: ConceptMapping | undefined
    if (isExternal) {
      liveMapping = mappings.find((m) =>
        m.projectId === project.id &&
        m.sourceVocabularyId === detailMapping.sourceVocabularyId &&
        m.sourceConceptCode === detailMapping.sourceConceptCode &&
        m.targetConceptId === detailMapping.targetConceptId,
      )
    } else {
      liveMapping = mappings.find((m) => m.id === detailMapping.id)
    }
    const effectiveMapping = liveMapping ?? detailMapping
    const stillExternal = isExternal && !liveMapping

    // Index in the parent filtered+sorted list (1-based for display).
    // Match by id when possible; for an external row that just got imported, fall back to
    // (vocabularyId, conceptCode, targetConceptId) so the position stays correct.
    const navList = sorted
    let currentIdx = navList.findIndex((m) => m.id === detailMapping.id)
    if (currentIdx < 0) {
      currentIdx = navList.findIndex((m) =>
        m.sourceVocabularyId === detailMapping.sourceVocabularyId &&
        m.sourceConceptCode === detailMapping.sourceConceptCode &&
        m.targetConceptId === detailMapping.targetConceptId,
      )
    }
    const goTo = (i: number) => {
      const next = navList[i]
      if (!next) return
      setDetailMapping(next)
      setDetailSource({ counts: null, infoJson: undefined })
      fetchSourceDetail(next).then(setDetailSource)
    }

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
        <MappingDetailView
          mapping={effectiveMapping}
          sourceDetail={detailSource}
          currentUser={currentUser}
          isExternal={stillExternal}
          externalProjectName={externalInfo?.sourceProjectName}
          onOpenComments={(id) => setCommentsMappingId(id)}
          onOpenReviews={(id) => setReviewsMappingId(id)}
          position={currentIdx >= 0 ? { index: currentIdx + 1, total: navList.length } : undefined}
          onPrev={currentIdx > 0 ? () => goTo(currentIdx - 1) : undefined}
          onNext={currentIdx >= 0 && currentIdx < navList.length - 1 ? () => goTo(currentIdx + 1) : undefined}
          onReview={async (mid, target) => {
            await handleReview(mid, target)
            // After voting on an external row, swap to the freshly-created local mapping so subsequent votes update it
            if (mid.startsWith(EXTERNAL_PREFIX)) {
              const refreshed = useConceptMappingStore.getState().mappings.find((m) =>
                m.projectId === project.id &&
                m.sourceVocabularyId === detailMapping.sourceVocabularyId &&
                m.sourceConceptCode === detailMapping.sourceConceptCode &&
                m.targetConceptId === detailMapping.targetConceptId,
              )
              if (refreshed) setDetailMapping(refreshed)
            }
          }}
          onBack={() => {
            setDetailMapping(null)
            // Restore scroll position after React re-renders the table
            requestAnimationFrame(() => {
              scrollContainerRef.current?.scrollTo({ top: savedScrollTop.current })
            })
          }}
        />
      </>
    )
  }

  return (
    <>
    {identityDialog}
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
    {/* Import result dialog */}
    <AlertDialog open={!!importResult} onOpenChange={(open) => { if (!open) setImportResult(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('concept_mapping.import_mappings_result_title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1 text-sm">
              <p>{t('concept_mapping.import_mappings_imported', { count: importResult?.imported ?? 0 })}</p>
              {(importResult?.merged ?? 0) > 0 && (
                <p className="text-muted-foreground">
                  {t('concept_mapping.import_mappings_merged', {
                    count: importResult!.merged,
                    reviews: importResult!.reviewsAdded,
                    comments: importResult!.commentsAdded,
                  })}
                </p>
              )}
              {(importResult?.missingSource ?? 0) > 0 && (
                <p className="text-orange-600 dark:text-orange-400">{t('concept_mapping.import_mappings_missing_source', { count: importResult!.missingSource })}</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>{t('common.ok')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {/* Bulk import from other projects — dialog */}
    <AlertDialog open={bulkImportOpen} onOpenChange={(open) => { if (!open) { setBulkImportOpen(false); setBulkSelectedProjects([]) } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('concept_mapping.bulk_import_title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>{t('concept_mapping.bulk_import_description')}</p>
              <div className="space-y-1.5">
                <p className="text-xs font-medium">{t('concept_mapping.bulk_import_select_projects')}</p>
                <MultiSelectFilter
                  value={bulkSelectedProjects}
                  options={bulkProjectOptions}
                  placeholder={t('concept_mapping.bulk_import_all_projects')}
                  onChange={setBulkSelectedProjects}
                  popoverWidthClass="w-[var(--radix-popover-trigger-width)]"
                  triggerClass="h-8 w-full justify-start text-xs"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('concept_mapping.bulk_import_count', { count: bulkImportPreviewCount })}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={handleBulkImport} disabled={bulkImporting || bulkImportPreviewCount === 0}>
            {bulkImporting ? <Loader2 size={12} className="mr-1 animate-spin" /> : null}
            {t('concept_mapping.bulk_import_button')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {/* Bulk import — result dialog */}
    <AlertDialog open={!!bulkResult} onOpenChange={(open) => { if (!open) setBulkResult(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('concept_mapping.bulk_import_done_title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1 text-sm">
              <p>{t('concept_mapping.bulk_import_done_imported', { count: bulkResult?.imported ?? 0 })}</p>
              {(bulkResult?.skipped ?? 0) > 0 && (
                <p className="text-muted-foreground">
                  {t('concept_mapping.bulk_import_done_skipped', { count: bulkResult!.skipped })}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>{t('common.ok')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {/* Hidden file input for import */}
    <input
      ref={fileInputRef}
      type="file"
      accept=".json"
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) handleImportMappings(file)
        e.target.value = ''
      }}
    />
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <div className="ml-auto flex items-center gap-1">
          {/* Import / Export */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className="h-7 w-7"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
              >
                {importing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.import_mappings')}</TooltipContent>
          </Tooltip>
          {/* Bulk import from other projects (only visible when there are external mappings) */}
          {bulkProjectOptions.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="h-7 w-7"
                  onClick={() => setBulkImportOpen(true)}
                  disabled={bulkImporting}
                >
                  {bulkImporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.bulk_import_external')}</TooltipContent>
            </Tooltip>
          )}
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
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto" style={{ paddingRight: 'calc(var(--spacing) * 2.5)' }}>
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
            {visibleItems.length === 0 ? (
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
        {/* Loading indicator when fetching next page */}
        {hasMore && (
          <div className="flex h-8 items-center justify-center">
            <Loader2 size={12} className="animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Footer: count + column visibility */}
      <div className="flex shrink-0 items-center border-t px-4 py-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            {visibleItems.length.toLocaleString()}{hasMore ? '+' : ''} / {sorted.length.toLocaleString()} {t('concept_mapping.existing_mappings').toLowerCase()}
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
              className="bg-destructive text-white hover:bg-destructive/90"
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
