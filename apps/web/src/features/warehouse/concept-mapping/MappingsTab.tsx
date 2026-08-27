import { useState, useMemo, useCallback, useEffect, useRef, memo, type ReactNode } from 'react'
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
  Pencil, Trash2, Square, CheckSquare,
  Settings2, Users, Filter,
  Upload, ArrowLeft, Loader2, ChevronLeft, ChevronRight, ChevronDown,
  FileJson, FolderInput, Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedHeader, headerLabel } from '@/components/ui/truncated-header'
import { TruncatedText } from '@/components/ui/truncated-text'
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
import { clampPage, pageCountOf } from '@/components/ui/concept-data-table'
import { ColumnResizeHandle, FILTER_INPUT_CLASS, SortIndicator, columnLabel } from '@/components/ui/table-primitives'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { SectionLabel } from '@/components/ui/section-label'
import { SectionRenderer, extractSections, extractTextFields } from './components/ConceptDetailView'
import { useRequireIdentity } from './components/IdentityRequiredDialog'
import { useConceptMappingStore, type ExternalMappingInfo } from '@/stores/concept-mapping-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useAppStore } from '@/stores/app-store'
import { queryDataSource, fileSourceDataSourceId, isFileSourceMounted, mountFileSourceIntoDuckDB } from '@/lib/duckdb/engine'
import type { MappingProject, ConceptMapping, MappingComment, MappingReview, MappingStatus, MappingEquivalence, EffectiveMappingStatus, DataSource } from '@/types'
import { useDataSourceStore } from '@/stores/data-source-store'
import { buildAllConceptCountsQuery } from '@/lib/concept-mapping/mapping-queries'
import { effectiveMappingStatus, isMappingLocked } from '@/lib/concept-mapping/mapping-status'
import { EQUIV_BADGE } from '@/lib/concept-mapping/equivalence-badge'
import { EquivalenceMenuItems } from './components/EquivalenceMenuItems'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'
import { fuzzyTextMatch } from '@/lib/fuzzy-search'
import { escSql } from '@/lib/format-helpers'
import { getStorage } from '@/lib/storage'
import { localized } from '@/lib/localized'

interface MappingsTabProps {
  project: MappingProject
  dataSource?: DataSource
}

const PAGE_SIZE = 50

// ─── Status badge styling ────────────────────────────────────────────

const STATUS_BADGE: Record<EffectiveMappingStatus, string> = {
  unchecked: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  suggested: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  flagged: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400',
  invalid: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400',
  ignored: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
  disputed: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
}

// ─── Equivalence badge styling ────────────────────────────────────────
// (defined in @/lib/concept-mapping/equivalence-badge, imported above)

/** Column filter state for MappingsTab. Multi-select dropdowns use arrays — empty/undefined = no filter. */
interface MappingColumnFilters {
  sourceConceptId?: string
  sourceConceptName?: string
  sourceConceptCode?: string
  sourceVocabularyId?: string[]
  sourceCategoryId?: string[]
  targetConceptName?: string
  targetConceptId?: string
  targetVocabularyId?: string[]
  targetDomainId?: string[]
  targetConceptClassId?: string[]
  targetStandardConcept?: string[]
  equivalence?: string[]
  mappedBy?: string[]
}

type ApprovalRule = 'at_least_one' | 'majority' | 'no_rejections'
const FILTER_STATUSES: MappingStatus[] = ['approved', 'rejected', 'flagged', 'unchecked', 'ignored']

/** Sheet showing all comments for a single mapping, with add/edit/delete. */
function CommentsSheet({ mappingId, open, onOpenChange }: {
  mappingId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('concept-mapping:write')
  const { mappings, updateMapping } = useConceptMappingStore()
  const getUserDisplayName = useAppStore((s) => s.getUserDisplayName)
  const getAuthorDetails = useAppStore((s) => s.getAuthorDetails)
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
      authorDetails: getAuthorDetails(),
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
          <SheetTitle>{t('concept_mapping.comments')}</SheetTitle>
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
                      {c.authorId === currentUser && editingId !== c.id && canWrite && (
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
            <Button size="sm-tight" className="w-full" disabled={!draft.trim() || !canWrite} onClick={handleAdd}>
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
  const canWrite = useMyWorkspaceRole().can('concept-mapping:write')
  const { mappings, updateMapping } = useConceptMappingStore()
  const getUserDisplayName = useAppStore((s) => s.getUserDisplayName)
  const getAuthorDetails = useAppStore((s) => s.getAuthorDetails)
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
        reviewerDetails: getAuthorDetails(),
        status: newStatus,
        comment: comment.trim() || undefined,
        createdAt: new Date().toISOString(),
      }] : []),
    ]
    updateMapping(mapping.id, {
      reviews: newReviews,
      reviewedBy: newStatus !== 'unchecked' ? currentUser : undefined,
      reviewedByDetails: newStatus !== 'unchecked' ? getAuthorDetails() : undefined,
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
          <SheetTitle>{t('concept_mapping.reviews_title')}</SheetTitle>
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
                disabled={isOwnMapping || !canWrite}
              >
                <Check size={12} />
                {t(myReview?.status === 'approved' ? 'concept_mapping.status_approved' : 'concept_mapping.approve')}
              </Button>
              <Button
                size="sm"
                className={`h-8 text-xs gap-1 ${myReview?.status === 'rejected' ? 'bg-red-600 hover:bg-red-700 text-white' : ''}`}
                variant={myReview?.status === 'rejected' ? 'default' : 'outline'}
                onClick={() => handleReview('rejected')}
                disabled={isOwnMapping || !canWrite}
              >
                <X size={12} />
                {t(myReview?.status === 'rejected' ? 'concept_mapping.status_rejected' : 'concept_mapping.reject')}
              </Button>
              <Button
                size="sm"
                className={`h-8 text-xs gap-1 ${myReview?.status === 'flagged' ? 'bg-orange-500 hover:bg-orange-600 text-white' : ''}`}
                variant={myReview?.status === 'flagged' ? 'default' : 'outline'}
                onClick={() => handleReview('flagged')}
                disabled={!canWrite}
              >
                <Flag size={12} />
                {t(myReview?.status === 'flagged' ? 'concept_mapping.status_flagged' : 'concept_mapping.flag')}
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

function MappingDetailView({ mapping, sourceDetail, onBack, onReview, currentUser, onOpenComments, onOpenReviews, position, onPrev, onNext }: {
  mapping: ConceptMapping
  sourceDetail: SourceDetail
  onBack: () => void
  onReview: (mappingId: string, target: MappingStatus) => void | Promise<void>
  currentUser: string
  onOpenComments: (mappingId: string) => void
  onOpenReviews: (mappingId: string) => void
  /** 1-based index in the parent's filtered/sorted list, plus the total count. */
  position?: { index: number; total: number }
  onPrev?: () => void
  onNext?: () => void
}) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('concept-mapping:write')
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
                onClick={() => onOpenComments(mapping.id)}
              >
                <MessageSquare size={14} />
                {commentsCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
                    {commentsCount}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.comments')}</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className={`relative size-7 ${reviewsCount > 0 ? 'border-primary/50 text-primary' : ''}`}
                onClick={() => onOpenReviews(mapping.id)}
              >
                <Users size={14} />
                {reviewsCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
                    {reviewsCount}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.reviews_title')}</TooltipContent>
          </Tooltip>
          <span className="mx-1 h-5 w-px bg-border" />
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant={myReview === 'approved' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-7 ${myReview === 'approved' ? 'bg-green-600 text-white hover:bg-green-700' : 'hover:border-green-600 hover:text-green-600'}`}
                onClick={() => onReview(mapping.id, 'approved')}
                disabled={isOwn || !canWrite}
              >
                <Check size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{isOwn ? t('concept_mapping.cannot_review_own') : t('concept_mapping.approve')}</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant={myReview === 'rejected' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-7 ${myReview === 'rejected' ? 'bg-red-600 text-white hover:bg-red-700' : 'hover:border-red-600 hover:text-red-600'}`}
                onClick={() => onReview(mapping.id, 'rejected')}
                disabled={isOwn || !canWrite}
              >
                <X size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{isOwn ? t('concept_mapping.cannot_review_own') : t('concept_mapping.reject')}</TooltipContent>
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
          <SectionLabel as="h3" className="mb-3 text-xs font-semibold tracking-wide">
            {t('concept_mapping.detail_source')}
          </SectionLabel>
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
            <SectionLabel as="h4" className="mb-2 text-xs font-semibold tracking-wide">
              {t('concept_mapping.detail_statistics')}
            </SectionLabel>
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
          <SectionLabel as="h3" className="mb-3 text-xs font-semibold tracking-wide">
            {t('concept_mapping.detail_target')}
          </SectionLabel>
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
                  <tr>
                    <td className="whitespace-nowrap pr-4 py-1 text-muted-foreground align-top text-xs">{t('concept_mapping.col_std')}</td>
                    <td className="py-1 text-xs"><StandardConceptBadge value={mapping.targetStandardConcept ?? null} /></td>
                  </tr>
                </tbody>
              </table>
            )}
          </Card>

          {/* Mapping metadata */}
          <div className="mt-4">
            <SectionLabel as="h4" className="mb-2 text-xs font-semibold tracking-wide">
              {t('concept_mapping.detail_metadata')}
            </SectionLabel>
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
                  {renderField(t('concept_mapping.col_mapped_on'), formatDate(mapping.mappedOn ?? mapping.createdAt))}
                  {renderField(t('concept_mapping.detail_updated_at'), formatDate(mapping.updatedAt))}
                </tbody>
              </table>
            </Card>
          </div>

          {/* Comments */}
          {(mapping.comments ?? []).length > 0 && (
            <div className="mt-4">
              <SectionLabel as="h4" className="mb-2 text-xs font-semibold tracking-wide">
                {t('concept_mapping.comments')} ({(mapping.comments ?? []).length})
              </SectionLabel>
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
              <SectionLabel as="h4" className="mb-2 text-xs font-semibold tracking-wide">
                {t('concept_mapping.reviews_title')} ({(mapping.reviews ?? []).length})
              </SectionLabel>
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

// React.memo'd row of action buttons. Flat primitive props let the default
// shallow comparison short-circuit so a vote on one row doesn't re-render the
// other 49 visible rows. Native title="" tooltips instead of Radix <Tooltip>
// because per-row portals were the dominant paint cost on vote.
interface ReviewActionsCellProps {
  mappingId: string
  isOwn: boolean
  canWrite: boolean
  myReview: MappingStatus | 'unchecked'
  commentsCount: number
  reviewsCount: number
  onOpenComments: (mappingId: string) => void
  onOpenReviews: (mappingId: string) => void
  onReview: (mappingId: string, status: MappingStatus) => void
  t: ReturnType<typeof useTranslation>['t']
}
interface EquivalenceEditCellProps {
  equivalence: MappingEquivalence
  /** Reviewed or commented → frozen, since changing it would invalidate that assessment. */
  locked: boolean
  onChange: (predicate: MappingEquivalence) => void
  t: ReturnType<typeof useTranslation>['t']
}

/** Equivalence badge that becomes a picker in edit mode. */
const EquivalenceEditCell = memo(function EquivalenceEditCell({
  equivalence, locked, onChange, t,
}: EquivalenceEditCellProps) {
  const badge = EQUIV_BADGE[equivalence]
  const trigger = (
    <button
      type="button"
      disabled={locked}
      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0 text-[9px] font-medium ${badge?.className ?? ''} ${locked ? 'cursor-not-allowed opacity-60' : 'hover:brightness-95'}`}
      onClick={(e) => e.stopPropagation()}
    >
      {badge?.label ?? equivalence}
      {!locked && <ChevronDown className="size-2.5 text-current" />}
    </button>
  )
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        {/* Wrapper span so the tooltip still fires while the trigger is disabled. */}
        <span className="inline-flex">
          {locked ? trigger : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-0">
                <EquivalenceMenuItems onPick={onChange} stopPropagation />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {locked ? t('concept_mapping.mapping_locked_hint') : t('concept_mapping.change_equivalence_hint')}
      </TooltipContent>
    </Tooltip>
  )
})

const ReviewActionsCell = memo(function ReviewActionsCell({
  mappingId, isOwn, canWrite, myReview, commentsCount, reviewsCount,
  onOpenComments, onOpenReviews, onReview, t,
}: ReviewActionsCellProps) {
  return (
    <span className="flex items-center justify-end gap-1">
      <Button
        variant="outline"
        size="icon-sm"
        className={`relative size-5 ${commentsCount > 0 ? 'border-primary/50 text-primary' : ''}`}
        title={t('concept_mapping.comments')}
        onClick={(e) => { e.stopPropagation(); onOpenComments(mappingId) }}
      >
        <MessageSquare size={11} />
        {commentsCount > 0 && (
          <span className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
            {commentsCount}
          </span>
        )}
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        className={`relative size-5 ${reviewsCount > 0 ? 'border-primary/50 text-primary' : ''}`}
        title={t('concept_mapping.reviews_title')}
        onClick={(e) => { e.stopPropagation(); onOpenReviews(mappingId) }}
      >
        <Users size={11} />
        {reviewsCount > 0 && (
          <span className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
            {reviewsCount}
          </span>
        )}
      </Button>
      <Button
        variant={myReview === 'approved' ? 'default' : 'outline'}
        size="icon-sm"
        className={`size-5 ${myReview === 'approved' ? 'bg-green-600 text-white hover:bg-green-700' : 'hover:border-green-600 hover:text-green-600'}`}
        title={isOwn ? t('concept_mapping.cannot_review_own') : t('concept_mapping.approve')}
        onClick={(e) => { e.stopPropagation(); onReview(mappingId, 'approved') }}
        disabled={isOwn || !canWrite}
      >
        <Check size={12} />
      </Button>
      <Button
        variant={myReview === 'rejected' ? 'default' : 'outline'}
        size="icon-sm"
        className={`size-5 ${myReview === 'rejected' ? 'bg-red-600 text-white hover:bg-red-700' : 'hover:border-red-600 hover:text-red-600'}`}
        title={isOwn ? t('concept_mapping.cannot_review_own') : t('concept_mapping.reject')}
        onClick={(e) => { e.stopPropagation(); onReview(mappingId, 'rejected') }}
        disabled={isOwn || !canWrite}
      >
        <X size={12} />
      </Button>
      <Button
        variant={myReview === 'flagged' ? 'default' : 'outline'}
        size="icon-sm"
        className={`size-5 ${myReview === 'flagged' ? 'bg-orange-500 text-white hover:bg-orange-600' : 'hover:border-orange-500 hover:text-orange-500'}`}
        title={t('concept_mapping.flag')}
        onClick={(e) => { e.stopPropagation(); onReview(mappingId, 'flagged') }}
        disabled={!canWrite}
      >
        <Flag size={12} />
      </Button>
    </span>
  )
})

export function MappingsTab({ project, dataSource }: MappingsTabProps) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('concept-mapping:write')
  // Memos depend on `mappingsStructureVersion` (set membership / aggregations)
  // or `mappingsVersion` (per-row content) instead of the `mappings` array
  // itself, so a vote on a single row doesn't invalidate filter / sort memos.
  const updateMapping = useConceptMappingStore((s) => s.updateMapping)
  const deleteMapping = useConceptMappingStore((s) => s.deleteMapping)
  const createMappingsBatch = useConceptMappingStore((s) => s.createMappingsBatch)
  const loadOtherProjectsDetails = useConceptMappingStore((s) => s.loadOtherProjectsDetails)
  const loadProjectMappings = useConceptMappingStore((s) => s.loadProjectMappings)
  const mappingsVersion = useConceptMappingStore((s) => s.mappingsVersion)
  const mappingsStructureVersion = useConceptMappingStore((s) => s.mappingsStructureVersion)
  // Read via getState() rather than a hook subscription so cell-level updates
  // (votes, comments) don't re-render the whole component. The version-counter
  // subscriptions above ensure this snapshot stays fresh whenever a structural
  // change happens.
  const mappings = useConceptMappingStore.getState().mappings
  const otherProjectsMappings = useConceptMappingStore((s) => s.otherProjectsMappings)
  const getUserDisplayName = useAppStore((s) => s.getUserDisplayName)
  const getAuthorDetails = useAppStore((s) => s.getAuthorDetails)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const currentUser = getUserDisplayName()
  const { requireIdentity, dialog: identityDialog } = useRequireIdentity()

  // Load cross-project mapping details for the bulk-import modal. Cached in the
  // store so the Editor tab and this tab share the same fetch.
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
      const badgeLabels = (project.badges ?? []).map((b) => localized(b.label, 'en')).filter(Boolean)
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
  const [sorting, setSorting] = useState<{ columnId: string; desc: boolean } | null>({ columnId: 'mappedOn', desc: true })
  const [page, setPage] = useState(0)
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

  /** The source concept id as displayed: registry-assigned, or the row's own. */
  const resolveSourceConceptId = useCallback((m: ConceptMapping): number | null => {
    const fromRegistry = sourceConceptIdMap.get(`${m.sourceVocabularyId}__${m.sourceConceptCode}`) ?? null
    if (useRegistryForId) return fromRegistry
    if (m.sourceConceptId && m.sourceConceptId !== 0) return m.sourceConceptId
    return fromRegistry
  }, [sourceConceptIdMap, useRegistryForId])

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
  // Filter by current user's review on each mapping. 'all' = no filter.
  // 'unchecked' = the current user has NOT voted yet.
  const [myReviewFilter, setMyReviewFilter] = useState<'all' | 'approved' | 'rejected' | 'flagged' | 'unchecked'>('all')
  const [commentsMappingId, setCommentsMappingId] = useState<string | null>(null)
  const [approvalRule, setApprovalRule] = useState<ApprovalRule>('at_least_one')
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    sourceCategoryId: false,
    sourceSubcategoryId: false,
    sourceConceptCode: false,
    sourceConceptId: false,
    targetConceptId: false,
  })
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})

  // Set-level memo: only re-derives when the *structure* of mappings changes
  // (create / delete / batch import / reload). A vote that just updates a single row
  // does NOT bump structureVersion, so this memo keeps its cached array reference.

  const projectMappings = useMemo(
    () => mappings.filter((m) => m.projectId === project.id),
    [mappingsStructureVersion, project.id],
  )

  // The evaluation table only displays project-local mappings. Cross-project
  // alignments are imported via the bulk-import modal and surfaced inline in
  // MappingEditor's blue-dot popover.
  const allDisplayMappings = projectMappings

  // Compute distinct values for dropdown filters
  const filterOptions = useMemo(() => {
    const unique = (fn: (m: ConceptMapping) => string | undefined) =>
      [...new Set(projectMappings.map(fn))].filter((v): v is string => Boolean(v)).sort()
    return {
      sourceVocabularyId: unique((m) => m.sourceVocabularyId),
      sourceCategoryId: unique((m) => m.sourceCategoryId),
      targetVocabularyId: unique((m) => m.targetVocabularyId),
      targetDomainId: unique((m) => m.targetDomainId),
      targetConceptClassId: unique((m) => m.targetConceptClassId),
      targetStandardConcept: unique((m) => m.targetStandardConcept),
      equivalence: unique((m) => m.equivalence),
      mappedBy: unique((m) => m.mappedBy),
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
  // rowDerived is rebuilt on every per-row mutation (mappingsVersion bump). We look up
  // each row by id in the store's `mappingsById` index — that index sees the latest
  // content even when the `allDisplayMappings` array reference is stable for memos
  // depending on `mappingsStructureVersion`.
  const rowDerived = useMemo(() => {
    const map = new Map<string, RowDerived>()
    const byId = useConceptMappingStore.getState().mappingsById
    for (const stale of allDisplayMappings) {
      // Local rows have a fresh entry in `byId`. External rows (synthetic, prefixed)
      // are not in the index — fall back to the row from the iteration since they
      // never get mutated by votes in this view.
      const m = byId.get(stale.id) ?? stale
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDisplayMappings, currentUser, mappingsVersion])

  // Apply column filters + status popover filter (client-side)
  const filtered = useMemo(() => allDisplayMappings.filter((m) => {
    const f = colFilters
    // Matched against the id actually shown: for a registry-backed project the
    // stored sourceConceptId is a row-number index nobody sees, so filtering on
    // it would reject the very value the user copied off the column.
    if (f.sourceConceptId && !String(resolveSourceConceptId(m) ?? '').includes(f.sourceConceptId)) return false
    if (f.sourceConceptName && !m.sourceConceptName.toLowerCase().includes(f.sourceConceptName.toLowerCase())) return false
    if (f.sourceConceptCode && !(m.sourceConceptCode || String(m.sourceConceptId)).toLowerCase().includes(f.sourceConceptCode.toLowerCase())) return false
    if (f.sourceVocabularyId?.length && !f.sourceVocabularyId.includes(m.sourceVocabularyId)) return false
    if (f.sourceCategoryId?.length && !f.sourceCategoryId.includes(m.sourceCategoryId ?? '')) return false
    if (f.targetConceptName && !m.targetConceptName.toLowerCase().includes(f.targetConceptName.toLowerCase())) return false
    if (f.targetConceptId && !String(m.targetConceptId).includes(f.targetConceptId)) return false
    if (f.targetVocabularyId?.length && !f.targetVocabularyId.includes(m.targetVocabularyId)) return false
    if (f.targetDomainId?.length && !f.targetDomainId.includes(m.targetDomainId ?? '')) return false
    if (f.targetConceptClassId?.length && !f.targetConceptClassId.includes(m.targetConceptClassId ?? '')) return false
    if (f.targetStandardConcept?.length && !f.targetStandardConcept.includes(m.targetStandardConcept ?? '')) return false
    if (f.equivalence?.length && !f.equivalence.includes(m.equivalence)) return false
    if (f.mappedBy?.length && !f.mappedBy.includes(m.mappedBy ?? '')) return false
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
  }), [allDisplayMappings, colFilters, myReviewFilter, includedStatuses, approvalRule, rowDerived, resolveSourceConceptId])

  /** Frozen row order: captured the first time a filter/sort combination is applied
   *  and reused as long as those settings stay the same, so a vote that changes a
   *  row's effective status doesn't make the row jump position. Keyed on
   *  (sourceVocab, sourceCode, targetConceptId) so the entry survives mapping-id
   *  changes (e.g. on import). */
  const stableOrderRef = useRef<{ key: string; rowKeys: string[] } | null>(null)
  const rowKey = useCallback((m: ConceptMapping) => `${m.sourceVocabularyId}\0${m.sourceConceptCode}\0${m.targetConceptId}`, [])

  const sorted = useMemo(() => {
    const orderKey = JSON.stringify({
      sorting,
      colFilters,
      myReviewFilter,
      includedStatuses: [...includedStatuses].sort(),
      approvalRule,
    })

    let baseOrder: ConceptMapping[]
    if (!sorting) {
      baseOrder = filtered
    } else {
      const { columnId, desc } = sorting
      const dir = desc ? -1 : 1
      // Synthetic columns (vote counts) aren't on the mapping object — resolve via rowDerived.
      const accessor = (m: ConceptMapping): unknown => {
        switch (columnId) {
          case '_votes_approved': return rowDerived.get(m.id)?.approvedCount ?? 0
          case '_votes_flagged': return rowDerived.get(m.id)?.flaggedCount ?? 0
          case '_votes_rejected': return rowDerived.get(m.id)?.rejectedCount ?? 0
          default: return (m as unknown as Record<string, unknown>)[columnId]
        }
      }
      baseOrder = [...filtered].sort((a, b) => {
        const av = accessor(a)
        const bv = accessor(b)
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv)
        return dir * String(av).localeCompare(String(bv))
      })
    }

    // If the user changed a filter/sort, reset the freeze and capture the new order.
    if (!stableOrderRef.current || stableOrderRef.current.key !== orderKey) {
      stableOrderRef.current = { key: orderKey, rowKeys: baseOrder.map(rowKey) }
      return baseOrder
    }

    // Same settings as last render: reuse the captured row-key order. New rows
    // are appended at the end in baseOrder's natural order.
    const knownKeys = new Set(stableOrderRef.current.rowKeys)
    const filteredByKey = new Map<string, ConceptMapping>()
    for (const m of filtered) {
      const k = rowKey(m)
      if (!filteredByKey.has(k)) filteredByKey.set(k, m)
    }
    const out: ConceptMapping[] = []
    const seenKeys = new Set<string>()
    for (const k of stableOrderRef.current.rowKeys) {
      const m = filteredByKey.get(k)
      if (m && !seenKeys.has(k)) {
        out.push(m)
        seenKeys.add(k)
      }
    }
    for (const m of baseOrder) {
      const k = rowKey(m)
      if (!knownKeys.has(k) && !seenKeys.has(k)) {
        out.push(m)
        seenKeys.add(k)
      }
    }
    return out
  }, [filtered, sorting, rowDerived, colFilters, myReviewFilter, includedStatuses, approvalRule, rowKey])

  const pageCount = pageCountOf(sorted.length, PAGE_SIZE)
  // Clamped rather than reset: narrowing a filter should not throw away the
  // user's position when the page they are on still exists.
  const safePage = clampPage(page, pageCount)
  const visibleItems = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  // Back to the top of the list on a page change: the rows all changed, and
  // landing mid-table would read as not having moved.
  useEffect(() => { scrollContainerRef.current?.scrollTo({ top: 0 }) }, [safePage])

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
    if (columnId === '_status') return null
    // Text inputs
    if (columnId === 'sourceConceptName') {
      return <input className={FILTER_INPUT_CLASS} placeholder="..." value={colFilters.sourceConceptName ?? ''} onChange={(e) => updateFilter('sourceConceptName', e.target.value || null)} />
    }
    if (columnId === 'sourceConceptId') {
      return <input className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="ID..." value={colFilters.sourceConceptId ?? ''} onChange={(e) => updateFilter('sourceConceptId', e.target.value || null)} />
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
    if (columnId === 'targetConceptClassId' && filterOptions.targetConceptClassId.length > 0) {
      return <MultiSelectFilter value={colFilters.targetConceptClassId ?? []} options={filterOptions.targetConceptClassId} placeholder="Class" onChange={(v) => updateMultiFilter('targetConceptClassId', v)} />
    }
    if (columnId === 'targetStandardConcept' && filterOptions.targetStandardConcept.length > 0) {
      const stdOptions = filterOptions.targetStandardConcept.map((s) => ({
        value: s,
        label: s === 'S' ? t('concept_mapping.std_standard') : s === 'C' ? t('concept_mapping.std_classification') : s,
      }))
      return <MultiSelectFilter value={colFilters.targetStandardConcept ?? []} options={stdOptions} placeholder="Std" onChange={(v) => updateMultiFilter('targetStandardConcept', v)} />
    }
    if (columnId === 'mappedBy' && filterOptions.mappedBy.length > 0) {
      return <MultiSelectFilter value={colFilters.mappedBy ?? []} options={filterOptions.mappedBy} placeholder="..." onChange={(v) => updateMultiFilter('mappedBy', v)} />
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

  // Top-level "where do you want to import from?" picker. Opened by the unified
  // Import button in the toolbar; the user then selects a file or another project.
  const [importSourceOpen, setImportSourceOpen] = useState(false)
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
  const [bulkImporting, setBulkImporting] = useState(false)
  const [bulkResult, setBulkResult] = useState<{ imported: number; skipped: number } | null>(null)
  // Selection set keyed by mapping.id (the original id from the source project).
  // Uses Set semantics: present = selected. Initial state is empty (no rows pre-checked).
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set())
  // Search input is decoupled from the applied filter: typing only updates
  // `bulkPendingSearch`, the actual filter `bulkFilters.globalSearch` only
  // changes when the user clicks Search or hits Enter.
  const [bulkPendingSearch, setBulkPendingSearch] = useState('')
  // Per-column filters for the bulk-import datatable.
  const [bulkFilters, setBulkFilters] = useState<{
    globalSearch: string
    sourceProjectIds: string[]
    sourceVocabIds: string[]
    sourceCode: string
    sourceName: string
    targetVocabIds: string[]
    targetId: string
    targetName: string
    statuses: MappingStatus[]
    equivalences: string[]
  }>({
    globalSearch: '',
    sourceProjectIds: [],
    sourceVocabIds: [],
    sourceCode: '',
    sourceName: '',
    targetVocabIds: [],
    targetId: '',
    targetName: '',
    statuses: [],
    equivalences: [],
  })

  // Candidate rows for the bulk-import datatable. Shape is intentionally aligned
  // with the columns shown in the MappingsTab table so the bulk-import view feels
  // like the same table — same column order, same visibility defaults — plus the
  // sourceProjectName which is the bulk-specific contextual info.
  interface BulkCandidateRow {
    info: ExternalMappingInfo
    /** Selection key (uses the original mapping.id from the source project). */
    key: string
    sourceProjectId: string
    sourceProjectName: string
    sourceVocabularyId: string
    sourceConceptCode: string
    sourceConceptId: number
    sourceConceptName: string
    sourceCategoryId: string
    targetVocabularyId: string
    targetConceptId: number
    targetConceptName: string
    equivalence: string
    status: MappingStatus
    mappedBy: string
    votesApproved: number
    votesFlagged: number
    votesRejected: number
  }
  const bulkCandidates = useMemo<BulkCandidateRow[]>(() => {
    const localKeys = new Set(
      mappings
        .filter((m) => m.projectId === project.id)
        .map((m) => `${m.sourceVocabularyId}\0${m.sourceConceptCode}\0${m.targetConceptId}`),
    )
    const out: BulkCandidateRow[] = []
    for (const list of otherProjectsMappings.values()) {
      for (const info of list) {
        const dedupKey = `${info.mapping.sourceVocabularyId}\0${info.mapping.sourceConceptCode}\0${info.mapping.targetConceptId}`
        if (localKeys.has(dedupKey)) continue
        const reviews = info.mapping.reviews ?? []
        let va = 0, vf = 0, vr = 0
        for (const r of reviews) {
          if (r.status === 'approved') va++
          else if (r.status === 'flagged') vf++
          else if (r.status === 'rejected') vr++
        }
        out.push({
          info,
          key: info.mapping.id,
          sourceProjectId: info.sourceProjectId,
          sourceProjectName: info.sourceProjectName,
          sourceVocabularyId: info.mapping.sourceVocabularyId ?? '',
          sourceConceptCode: info.mapping.sourceConceptCode ?? String(info.mapping.sourceConceptId ?? ''),
          sourceConceptId: info.mapping.sourceConceptId ?? 0,
          sourceConceptName: info.mapping.sourceConceptName ?? '',
          sourceCategoryId: info.mapping.sourceCategoryId ?? '',
          targetVocabularyId: info.mapping.targetVocabularyId ?? '',
          targetConceptId: info.mapping.targetConceptId ?? 0,
          targetConceptName: info.mapping.targetConceptName ?? '',
          equivalence: info.mapping.equivalence ?? '',
          status: info.mapping.status,
          mappedBy: info.mapping.mappedBy ?? '',
          votesApproved: va,
          votesFlagged: vf,
          votesRejected: vr,
        })
      }
    }
    return out
  }, [otherProjectsMappings, mappings, project.id])

  // Distinct values for filter dropdowns, computed from candidates.
  const bulkFilterOptions = useMemo(() => {
    const projects = new Map<string, string>()
    const sourceVocabs = new Set<string>()
    const targetVocabs = new Set<string>()
    const equivs = new Set<string>()
    const statuses = new Set<MappingStatus>()
    for (const r of bulkCandidates) {
      if (!projects.has(r.sourceProjectId)) projects.set(r.sourceProjectId, r.sourceProjectName)
      if (r.sourceVocabularyId) sourceVocabs.add(r.sourceVocabularyId)
      if (r.targetVocabularyId) targetVocabs.add(r.targetVocabularyId)
      if (r.equivalence) equivs.add(r.equivalence)
      if (r.status) statuses.add(r.status)
    }
    return {
      projects: [...projects.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
      sourceVocabs: [...sourceVocabs].sort(),
      targetVocabs: [...targetVocabs].sort(),
      equivalences: [...equivs].sort(),
      statuses: [...statuses].sort(),
    }
  }, [bulkCandidates])

  // Filtered candidate rows.
  const bulkFilteredCandidates = useMemo<BulkCandidateRow[]>(() => {
    const f = bulkFilters
    const g = f.globalSearch.trim()
    return bulkCandidates.filter((r) => {
      if (g) {
        // Fuzzy match on source name OR target name (canonical rules — see lib/fuzzy-search).
        if (!fuzzyTextMatch(r.sourceConceptName, g) && !fuzzyTextMatch(r.targetConceptName, g)) return false
      }
      if (f.sourceProjectIds.length > 0 && !f.sourceProjectIds.includes(r.sourceProjectId)) return false
      if (f.sourceVocabIds.length > 0 && !f.sourceVocabIds.includes(r.sourceVocabularyId)) return false
      if (f.sourceCode && !r.sourceConceptCode.toLowerCase().includes(f.sourceCode.toLowerCase())) return false
      if (f.sourceName && !r.sourceConceptName.toLowerCase().includes(f.sourceName.toLowerCase())) return false
      if (f.targetVocabIds.length > 0 && !f.targetVocabIds.includes(r.targetVocabularyId)) return false
      if (f.targetId && !String(r.targetConceptId).includes(f.targetId)) return false
      if (f.targetName && !r.targetConceptName.toLowerCase().includes(f.targetName.toLowerCase())) return false
      if (f.statuses.length > 0 && !f.statuses.includes(r.status)) return false
      if (f.equivalences.length > 0 && !f.equivalences.includes(r.equivalence)) return false
      return true
    })
  }, [bulkCandidates, bulkFilters])

  // Column visibility for the bulk-import datatable. Defaults mirror MappingsTab:
  // verbose source/target id/code columns are hidden, the user-displayed essentials
  // (name, vocab, equivalence, status) are shown. Toggleable from the modal header.
  const [bulkColumnVisibility, setBulkColumnVisibility] = useState<VisibilityState>({
    sourceConceptCode: false,
    sourceConceptId: false,
    sourceCategoryId: false,
    targetConceptId: false,
    mappedBy: false,
    _votes_approved: false,
    _votes_flagged: false,
    _votes_rejected: false,
  })

  // Chunked rendering: render `bulkChunkSize` rows at a time, grow on near-bottom scroll.
  // Avoids paying the full N-row paint cost on open or when toggling a checkbox.
  const BULK_CHUNK = 100
  const [bulkChunkSize, setBulkChunkSize] = useState(BULK_CHUNK)
  // Reset to first chunk when filters change or modal reopens.
  useEffect(() => { setBulkChunkSize(BULK_CHUNK) }, [bulkFilters, bulkImportOpen])

  const bulkSelectAllFiltered = useCallback(() => {
    setBulkSelectedIds(new Set(bulkFilteredCandidates.map((r) => r.key)))
  }, [bulkFilteredCandidates])
  const bulkClearSelection = useCallback(() => setBulkSelectedIds(new Set()), [])
  const bulkToggleOne = useCallback((key: string) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }, [])

  const handleBulkImport = useCallback(async () => {
    if (bulkImporting) return
    setBulkImporting(true)
    try {
      // Build the full batch in memory first — single createMappingsBatch call,
      // single Zustand set() at the end, no per-row React render storm.
      const now = new Date().toISOString()
      const toImport: ConceptMapping[] = []
      // Re-check local keys at submit time in case the user voted in the background
      // since the modal opened and a row is now local.
      const localKeys = new Set(
        mappings
          .filter((m) => m.projectId === project.id)
          .map((m) => `${m.sourceVocabularyId}\0${m.sourceConceptCode}\0${m.targetConceptId}`),
      )
      // Re-anchor each imported row to the local source concept_id so the row
      // dot turns green immediately. For OMOP sources the concept_id is canonical
      // across projects, but file sources use artificial ids.
      const localIdByKey = new Map<string, number>()
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
          const rows = await queryDataSource(dsId, 'SELECT concept_id, concept_code, vocabulary_id FROM source_concepts')
          for (const r of rows as Record<string, unknown>[]) {
            const k = `${r.vocabulary_id ?? ''}\0${r.concept_code ?? ''}`
            const cid = Number(r.concept_id)
            if (Number.isFinite(cid)) localIdByKey.set(k, cid)
          }
        }
      } catch {
        // Ignore — fall through and use the foreign sourceConceptId as before.
      }
      let skipped = 0
      for (const r of bulkCandidates) {
        if (!bulkSelectedIds.has(r.key)) continue
        const dk = `${r.sourceVocabularyId}\0${r.sourceConceptCode}\0${r.targetConceptId}`
        if (localKeys.has(dk)) { skipped++; continue }
        const sourceKey = `${r.sourceVocabularyId}\0${r.sourceConceptCode}`
        const localId = localIdByKey.get(sourceKey)
        // Full preservation: status / reviews / comments / mappedBy; rewrite identity
        // fields (id, projectId) and timestamps.
        toImport.push({
          ...r.info.mapping,
          id: crypto.randomUUID(),
          projectId: project.id,
          sourceConceptId: localId ?? r.info.mapping.sourceConceptId,
          createdAt: now,
          updatedAt: now,
        })
        localKeys.add(dk)
      }
      if (toImport.length > 0) {
        await createMappingsBatch(toImport)
      }
      setBulkResult({ imported: toImport.length, skipped })
      setBulkImportOpen(false)
      setBulkSelectedIds(new Set())
    } finally {
      setBulkImporting(false)
    }
  }, [bulkImporting, bulkCandidates, bulkSelectedIds, mappings, project.id, project.sourceType, project.fileSourceData, createMappingsBatch])

  // Ref-mirror of the selection set so the _select cell can read latest selection
  // without making `bulkColumns` depend on `bulkSelectedIds` — that would invalidate
  // every TanStack memo on every checkbox click.
  const bulkSelectedIdsRef = useRef(bulkSelectedIds)
  bulkSelectedIdsRef.current = bulkSelectedIds

  /** Columns for the bulk-import datatable. Order and visibility defaults mirror
   *  MappingsTab so the bulk view feels like the same data, with the source-project
   *  context surfaced as the first column. */
  const bulkColumns = useMemo<ColumnDef<BulkCandidateRow>[]>(() => [
    {
      id: '_select',
      header: () => null,
      // Read selection from the ref so columns stay stable across clicks.
      cell: ({ row }) => {
        const k = row.original.key
        const selected = bulkSelectedIdsRef.current.has(k)
        return (
          <button
            onClick={(e) => { e.stopPropagation(); bulkToggleOne(k) }}
            className="flex w-full justify-center"
          >
            {selected
              ? <CheckSquare size={14} className="text-primary" />
              : <Square size={14} className="text-muted-foreground" />}
          </button>
        )
      },
      size: 32,
      minSize: 32,
      enableHiding: false,
    },
    {
      id: 'sourceProjectName',
      header: () => t('concept_mapping.col_source_project'),
      accessorFn: (r) => r.sourceProjectName,
      cell: ({ row }) => <TruncatedText text={row.original.sourceProjectName} />,
      size: 120,
      minSize: 80,
    },
    {
      id: 'sourceVocabularyId',
      header: () => t('concept_mapping.col_source_vocabulary'),
      accessorFn: (r) => r.sourceVocabularyId,
      cell: ({ row }) => <span className="truncate text-muted-foreground">{row.original.sourceVocabularyId}</span>,
      size: 90,
      minSize: 50,
    },
    {
      id: 'sourceConceptCode',
      header: () => t('concept_mapping.col_source_concept_code'),
      accessorFn: (r) => r.sourceConceptCode,
      cell: ({ row }) => <span className="truncate font-mono text-[10px] text-muted-foreground">{row.original.sourceConceptCode}</span>,
      size: 90,
      minSize: 50,
    },
    {
      id: 'sourceConceptId',
      header: () => t('concept_mapping.col_source_concept_id'),
      accessorFn: (r) => r.sourceConceptId,
      cell: ({ row }) => <span className="truncate font-mono text-[10px] text-muted-foreground">{row.original.sourceConceptId}</span>,
      size: 90,
      minSize: 50,
    },
    {
      id: 'sourceConceptName',
      header: () => t('concept_mapping.col_source_concept_name'),
      accessorFn: (r) => r.sourceConceptName,
      cell: ({ row }) => <TruncatedText text={row.original.sourceConceptName} />,
      size: 200,
      minSize: 100,
    },
    {
      id: 'sourceCategoryId',
      header: () => t('concept_mapping.col_source_category'),
      accessorFn: (r) => r.sourceCategoryId,
      cell: ({ row }) => <span className="truncate text-muted-foreground">{row.original.sourceCategoryId}</span>,
      size: 90,
      minSize: 50,
    },
    {
      id: 'equivalence',
      header: () => t('concept_mapping.col_equivalence'),
      accessorFn: (r) => r.equivalence,
      cell: ({ row }) => {
        const equiv = row.original.equivalence
        const badge = EQUIV_BADGE[equiv]
        if (!badge) return <span className="text-[10px] text-muted-foreground">{equiv}</span>
        return (
          <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] font-medium ${badge.className}`} title={equiv}>
            {badge.label}
          </Badge>
        )
      },
      size: 70,
      minSize: 50,
    },
    {
      id: 'targetVocabularyId',
      header: () => t('concept_mapping.col_target_vocabulary'),
      accessorFn: (r) => r.targetVocabularyId,
      cell: ({ row }) => <span className="truncate text-muted-foreground">{row.original.targetVocabularyId}</span>,
      size: 90,
      minSize: 50,
    },
    {
      id: 'targetConceptId',
      header: () => t('concept_mapping.col_target_concept_id'),
      accessorFn: (r) => r.targetConceptId,
      cell: ({ row }) => <span className="truncate font-mono text-[10px] text-muted-foreground">{row.original.targetConceptId}</span>,
      size: 80,
      minSize: 50,
    },
    {
      id: 'targetConceptName',
      header: () => t('concept_mapping.col_target_concept_name'),
      accessorFn: (r) => r.targetConceptName,
      cell: ({ row }) => <TruncatedText text={row.original.targetConceptName} />,
      size: 200,
      minSize: 100,
    },
    {
      id: 'status',
      header: () => t('concept_mapping.col_status'),
      accessorFn: (r) => r.status,
      cell: ({ row }) => (
        <span className={`rounded-full px-1.5 py-0.5 text-[9px] ${STATUS_BADGE[row.original.status] ?? ''}`}>
          {t(`concept_mapping.status_${row.original.status}`)}
        </span>
      ),
      size: 80,
      minSize: 60,
    },
    {
      id: 'mappedBy',
      header: () => t('concept_mapping.col_mapped_by'),
      accessorFn: (r) => r.mappedBy,
      cell: ({ row }) => <span className="truncate text-muted-foreground">{row.original.mappedBy}</span>,
      size: 100,
      minSize: 60,
    },
    {
      id: '_votes_approved',
      header: () => <span className="text-green-600" title={t('concept_mapping.approve')}>✓</span>,
      accessorFn: (r) => r.votesApproved,
      cell: ({ row }) => row.original.votesApproved > 0
        ? <span className="text-xs font-medium text-green-600">{row.original.votesApproved}</span>
        : <span className="text-xs text-muted-foreground/40">—</span>,
      size: 36,
      minSize: 36,
    },
    {
      id: '_votes_flagged',
      header: () => <span className="text-orange-500" title={t('concept_mapping.flag')}>⚑</span>,
      accessorFn: (r) => r.votesFlagged,
      cell: ({ row }) => row.original.votesFlagged > 0
        ? <span className="text-xs font-medium text-orange-500">{row.original.votesFlagged}</span>
        : <span className="text-xs text-muted-foreground/40">—</span>,
      size: 36,
      minSize: 36,
    },
    {
      id: '_votes_rejected',
      header: () => <span className="text-red-500" title={t('concept_mapping.reject')}>✗</span>,
      accessorFn: (r) => r.votesRejected,
      cell: ({ row }) => row.original.votesRejected > 0
        ? <span className="text-xs font-medium text-red-500">{row.original.votesRejected}</span>
        : <span className="text-xs text-muted-foreground/40">—</span>,
      size: 36,
      minSize: 36,
    },
    // bulkSelectedIds is read via the ref above to keep columns referentially stable.

  ], [t, bulkToggleOne])

  const bulkTable = useReactTable({
    data: bulkFilteredCandidates,
    columns: bulkColumns,
    state: { columnVisibility: bulkColumnVisibility },
    onColumnVisibilityChange: setBulkColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
  })

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

      // Load valid source concept codes from the project's source data, plus a
      // (vocab, code) → local concept_id resolver. The local id is what the
      // mapping must point to so the row's status badge turns green — using the
      // foreign id from `mappings.json` would leave the dot grey.
      let validSourceKeys: Set<string> | null = null
      const localIdByKey = new Map<string, number>()
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
          const rows = await queryDataSource(dsId, 'SELECT concept_id, concept_code, vocabulary_id FROM source_concepts')
          validSourceKeys = new Set()
          for (const r of rows as Record<string, unknown>[]) {
            const k = `${r.vocabulary_id ?? ''}\0${r.concept_code ?? ''}`
            validSourceKeys.add(k)
            const cid = Number(r.concept_id)
            if (Number.isFinite(cid)) localIdByKey.set(k, cid)
          }
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
        // Re-anchor sourceConceptId to the local project's row id (file sources
        // use artificial ids; OMOP sources share canonical ids so this is a no-op
        // when localIdByKey is empty).
        const sourceKey = `${m.sourceVocabularyId}\0${m.sourceConceptCode}`
        const localId = localIdByKey.get(sourceKey)
        const newMapping: ConceptMapping = {
          ...m,
          comments: migratedComments,
          id: crypto.randomUUID(),
          projectId: project.id,
          sourceConceptId: localId ?? m.sourceConceptId,
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

  /** Toggle review: clicking the same status resets to unchecked. */
  const handleReview = useCallback(async (mappingId: string, target: MappingStatus) => {
    if (!requireIdentity()) return
    const reviewer = getUserDisplayName()
    const m = useConceptMappingStore.getState().mappings.find((x) => x.id === mappingId)
    const prevReviews = m?.reviews ?? []
    const currentReviewerStatus = prevReviews.find((r) => r.reviewerId === reviewer)?.status ?? 'unchecked'
    const newStatus = currentReviewerStatus === target ? 'unchecked' : target
    const newReviews = [
      ...prevReviews.filter((r) => r.reviewerId !== reviewer),
      ...(newStatus !== 'unchecked' ? [{
        id: prevReviews.find((r) => r.reviewerId === reviewer)?.id ?? crypto.randomUUID(),
        reviewerId: reviewer,
        reviewerDetails: getAuthorDetails(),
        status: newStatus,
        createdAt: new Date().toISOString(),
      }] : []),
    ]
    updateMapping(mappingId, {
      reviews: newReviews,
      reviewedBy: newStatus !== 'unchecked' ? reviewer : undefined,
      reviewedByDetails: newStatus !== 'unchecked' ? getAuthorDetails() : undefined,
      reviewedOn: newStatus !== 'unchecked' ? new Date().toISOString() : undefined,
    })
  }, [updateMapping, getUserDisplayName, getAuthorDetails, requireIdentity])

  /** Change a mapping's equivalence from the table's edit mode. */
  const handleChangeEquivalence = useCallback(async (mappingId: string, predicate: MappingEquivalence) => {
    if (!requireIdentity()) return
    updateMapping(mappingId, { equivalence: predicate, updatedAt: new Date().toISOString() })
      .catch((err) => console.error('Failed to update mapping equivalence', err))
  }, [updateMapping, requireIdentity])

  /** Stable handlers for the memoized ReviewActionsCell. They take a mapping id and
   *  resolve the full mapping via the store's id index — this lets the cell pass only
   *  primitive props through React.memo for shallow-compare to short-circuit. */
  const onOpenDetail = useCallback((mappingId: string) => {
    const m = useConceptMappingStore.getState().mappingsById.get(mappingId)
      ?? useConceptMappingStore.getState().mappings.find((x) => x.id === mappingId)
    if (!m) return
    savedScrollTop.current = scrollContainerRef.current?.scrollTop ?? 0
    setDetailMapping(m)
    setDetailSource({ counts: null, infoJson: undefined })
    fetchSourceDetail(m).then(setDetailSource)
  }, [fetchSourceDetail])

  const onOpenComments = useCallback((mappingId: string) => {
    setCommentsMappingId(mappingId)
  }, [])

  const onOpenReviews = useCallback((mappingId: string) => {
    setReviewsMappingId(mappingId)
  }, [])

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

    // ── Status dot column ──────────────────────────────────────────
    // Always green (the evaluation table only displays project-local mappings).
    // Native title="" instead of Radix Tooltip to avoid per-row portal overhead.
    cols.push({
      id: '_status',
      header: '',
      cell: () => (
        <span className="flex justify-center" title={t('concept_mapping.status_tip_mapped')}>
          <span className="inline-block size-2 rounded-full bg-green-500" />
        </span>
      ),
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
        accessorFn: (row) => resolveSourceConceptId(row),
        cell: ({ row }) => {
          const id = resolveSourceConceptId(row.original)
          return <span className="font-mono text-muted-foreground">{id ?? <span className="text-muted-foreground/60">—</span>}</span>
        },
        size: 100,
        minSize: 50,
      },
      {
        id: 'sourceConceptName',
        header: () => t('concept_mapping.col_source_concept_name'),
        accessorFn: (row) => row.sourceConceptName,
        cell: ({ row }) => <TruncatedText text={row.original.sourceConceptName} />,
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
          const m = row.original
          const equiv = m.equivalence
          const badge = EQUIV_BADGE[equiv]
          if (editMode) {
            return (
              <EquivalenceEditCell
                equivalence={equiv}
                locked={isMappingLocked(m)}
                onChange={(pred) => handleChangeEquivalence(m.id, pred)}
                t={t}
              />
            )
          }
          if (!badge) return <span className="text-[10px] text-muted-foreground">{equiv}</span>
          return (
            <Badge
              variant="secondary"
              className={`px-1.5 py-0 text-[9px] font-medium ${badge.className}`}
              title={equiv}
            >
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
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={t('concept_mapping.no_mapping_needed')}>
                <EyeOff size={10} className="shrink-0" />
                <span className="block min-w-0 flex-1 truncate italic">{t('concept_mapping.no_mapping_needed')}</span>
              </span>
            )
          }
          return <TruncatedText text={m.targetConceptName} />
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
        // `mappedOn` is when a human made the mapping — the date this Provenance
        // block is about, and the one that survives a git round trip. `createdAt`
        // is the row's own timestamp (Usagi's createdOn, exported beside it): the
        // two coincide in practice, but only mappedOn was ever exported, so a
        // reimported project showed every row as created at import time.
        id: 'mappedOn',
        header: () => t('concept_mapping.col_mapped_on'),
        accessorFn: (row) => row.mappedOn ?? row.createdAt,
        cell: ({ row }) => {
          const d = row.original.mappedOn ?? row.original.createdAt
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

    // Review action buttons (only in review mode). Delegates to ReviewActionsCell.
    if (!editMode) {
      cols.push({
        id: '_review',
        header: () => t('concept_mapping.col_review'),
        cell: ({ row }) => {
          const m = row.original
          const d = rowDerived.get(m.id)
          return (
            <ReviewActionsCell
              mappingId={m.id}
              isOwn={m.mappedBy === currentUser}
              canWrite={canWrite}
              myReview={d?.myReviewStatus ?? 'unchecked'}
              commentsCount={(m.comments ?? []).length}
              reviewsCount={(m.reviews ?? []).length}
              onOpenComments={onOpenComments}
              onOpenReviews={onOpenReviews}
              onReview={handleReview}
              t={t}
            />
          )
        },
        size: 190,
        minSize: 190,
        enableResizing: false,
      })
    }

    return cols
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, editMode, selected, pageAllSelected, handleReview, handleChangeEquivalence, onOpenComments, onOpenReviews, toggleSelect, currentUser, rowDerived, sourceConceptIdMap, useRegistryForId])

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
    // Read the live counterpart from the store so vote updates show without
    // forcing a parent re-render.
    const liveMapping = mappings.find((m) => m.id === detailMapping.id)
    const effectiveMapping = liveMapping ?? detailMapping

    // 1-based index in the parent filtered+sorted list, for the "X / Y" header.
    const navList = sorted
    const currentIdx = navList.findIndex((m) => m.id === detailMapping.id)
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
          onOpenComments={(id) => setCommentsMappingId(id)}
          onOpenReviews={(id) => setReviewsMappingId(id)}
          position={currentIdx >= 0 ? { index: currentIdx + 1, total: navList.length } : undefined}
          onPrev={currentIdx > 0 ? () => goTo(currentIdx - 1) : undefined}
          onNext={currentIdx >= 0 && currentIdx < navList.length - 1 ? () => goTo(currentIdx + 1) : undefined}
          onReview={handleReview}
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
      <AlertDialogContent className="sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('concept_mapping.import_mappings_result_title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1">
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
    {/* Step 1 — choose where to import from. Two cards: file vs other projects. */}
    <Dialog open={importSourceOpen} onOpenChange={setImportSourceOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('concept_mapping.import_source_title')}</DialogTitle>
          <DialogDescription>{t('concept_mapping.import_source_description')}</DialogDescription>
        </DialogHeader>
        {/* Two cards styled like the Export tab widgets: a coloured icon+title
            header, then a neutral description block below. Clicking the card
            picks the source. */}
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            className="group flex flex-col overflow-hidden rounded-lg border bg-card text-left transition hover:border-primary"
            onClick={() => {
              setImportSourceOpen(false)
              fileInputRef.current?.click()
            }}
          >
            <div className="flex items-center gap-2.5 bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
              <FileJson size={16} className="shrink-0 text-amber-500" />
              <span className="text-sm font-medium">{t('concept_mapping.import_source_file')}</span>
            </div>
            <div className="px-4 py-2.5">
              <p className="text-xs text-muted-foreground">{t('concept_mapping.import_source_file_desc')}</p>
            </div>
          </button>
          <button
            type="button"
            className={`group flex flex-col overflow-hidden rounded-lg border bg-card text-left transition hover:border-primary ${bulkCandidates.length === 0 ? 'cursor-not-allowed opacity-50 hover:border-border' : ''}`}
            disabled={bulkCandidates.length === 0}
            onClick={() => {
              setImportSourceOpen(false)
              setBulkImportOpen(true)
            }}
          >
            <div className="flex items-center gap-2.5 bg-blue-50 px-4 py-3 dark:bg-blue-950/30">
              <FolderInput size={16} className="shrink-0 text-blue-500" />
              <span className="text-sm font-medium">{t('concept_mapping.import_source_other_projects')}</span>
            </div>
            <div className="px-4 py-2.5">
              <p className="text-xs text-muted-foreground">
                {bulkCandidates.length === 0
                  ? t('concept_mapping.import_source_other_projects_empty')
                  : t('concept_mapping.import_source_other_projects_desc', { count: bulkCandidates.length })}
              </p>
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>

    {/* Step 2a — Bulk import from other projects: full-width datatable with
        per-column filters, column visibility, select all/none on filtered rows. */}
    <Dialog open={bulkImportOpen} onOpenChange={(open) => { if (!open) { setBulkImportOpen(false); setBulkSelectedIds(new Set()); setBulkPendingSearch(''); setBulkFilters((p) => ({ ...p, globalSearch: '' })) } }}>
      <DialogContent className="sm:max-w-[min(98vw,1500px)] max-h-[92vh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle>{t('concept_mapping.bulk_import_title')}</DialogTitle>
          <DialogDescription>{t('concept_mapping.bulk_import_description')}</DialogDescription>
        </DialogHeader>

        {/* Filters popover + Search input + Search button. Search applies on
            click or Enter (typing in the input doesn't filter live). */}
        <div className="flex items-center gap-1.5">
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={`h-8 w-8 shrink-0 ${(bulkFilters.sourceProjectIds.length + bulkFilters.sourceVocabIds.length + bulkFilters.targetVocabIds.length + bulkFilters.statuses.length + bulkFilters.equivalences.length + (bulkFilters.sourceCode ? 1 : 0) + (bulkFilters.sourceName ? 1 : 0) + (bulkFilters.targetId ? 1 : 0) + (bulkFilters.targetName ? 1 : 0)) > 0 ? 'text-primary' : ''}`}
                  >
                    <Filter size={14} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.search_filters')}</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" className="w-[320px] p-3 space-y-3" onCloseAutoFocus={(e) => e.preventDefault()}>
              {bulkFilterOptions.projects.length > 0 && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_source_project')}</label>
                  <MultiSelectFilter
                    value={bulkFilters.sourceProjectIds}
                    options={bulkFilterOptions.projects}
                    placeholder={t('concept_mapping.filter_all')}
                    onChange={(v) => setBulkFilters((p) => ({ ...p, sourceProjectIds: v }))}
                    triggerClass="h-7 w-full justify-start text-xs"
                  />
                </div>
              )}
              {bulkFilterOptions.sourceVocabs.length > 0 && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_source_vocabulary')}</label>
                  <MultiSelectFilter
                    value={bulkFilters.sourceVocabIds}
                    options={bulkFilterOptions.sourceVocabs}
                    placeholder={t('concept_mapping.filter_all')}
                    onChange={(v) => setBulkFilters((p) => ({ ...p, sourceVocabIds: v }))}
                    triggerClass="h-7 w-full justify-start text-xs"
                  />
                </div>
              )}
              {bulkFilterOptions.targetVocabs.length > 0 && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_target_vocabulary')}</label>
                  <MultiSelectFilter
                    value={bulkFilters.targetVocabIds}
                    options={bulkFilterOptions.targetVocabs}
                    placeholder={t('concept_mapping.filter_all')}
                    onChange={(v) => setBulkFilters((p) => ({ ...p, targetVocabIds: v }))}
                    triggerClass="h-7 w-full justify-start text-xs"
                  />
                </div>
              )}
              {bulkFilterOptions.equivalences.length > 0 && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_equivalence')}</label>
                  <MultiSelectFilter
                    value={bulkFilters.equivalences}
                    options={bulkFilterOptions.equivalences}
                    placeholder={t('concept_mapping.filter_all')}
                    onChange={(v) => setBulkFilters((p) => ({ ...p, equivalences: v }))}
                    triggerClass="h-7 w-full justify-start text-xs"
                  />
                </div>
              )}
              {bulkFilterOptions.statuses.length > 0 && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_status')}</label>
                  <MultiSelectFilter
                    value={bulkFilters.statuses}
                    options={bulkFilterOptions.statuses.map((s) => ({ value: s, label: t(`concept_mapping.status_${s}`) }))}
                    placeholder={t('concept_mapping.filter_all')}
                    onChange={(v) => setBulkFilters((p) => ({ ...p, statuses: v as MappingStatus[] }))}
                    triggerClass="h-7 w-full justify-start text-xs"
                  />
                </div>
              )}
            </PopoverContent>
          </Popover>
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              className="h-8 w-full rounded border bg-transparent pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
              placeholder={t('concept_mapping.bulk_import_search_placeholder')}
              value={bulkPendingSearch}
              onChange={(e) => setBulkPendingSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  setBulkFilters((p) => ({ ...p, globalSearch: bulkPendingSearch.trim() }))
                }
              }}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs shrink-0"
            onClick={() => setBulkFilters((p) => ({ ...p, globalSearch: bulkPendingSearch.trim() }))}
          >
            {t('common.search')}
          </Button>
        </div>

        {/* Toolbar: count + columns toggle + select-all/none */}
        <div className="flex flex-wrap items-center gap-2 border-b pb-2 text-xs">
          <span className="text-muted-foreground">
            {t('concept_mapping.bulk_import_filtered_count', {
              filtered: bulkFilteredCandidates.length,
              total: bulkCandidates.length,
              shown: Math.min(bulkChunkSize, bulkFilteredCandidates.length),
            })}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="outline" className="h-7 gap-1 text-xs">
                  <Settings2 size={12} />
                  {t('concept_mapping.bulk_import_columns')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-[60vh] overflow-auto">
                <DropdownMenuLabel>{t('concept_mapping.bulk_import_columns')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {bulkTable.getAllLeafColumns()
                  .filter((c) => c.getCanHide())
                  .map((c) => {
                    const headerDef = c.columnDef.header
                    const labelNode = typeof headerDef === 'function' ? headerDef({} as Parameters<typeof headerDef>[0]) : headerDef
                    return (
                      <DropdownMenuCheckboxItem
                        key={c.id}
                        checked={c.getIsVisible()}
                        onCheckedChange={(v) => c.toggleVisibility(!!v)}
                        className="text-xs"
                      >
                        <span className="truncate">{typeof labelNode === 'string' ? labelNode : c.id}</span>
                      </DropdownMenuCheckboxItem>
                    )
                  })}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="xs" variant="outline" className="h-7 text-xs" onClick={bulkSelectAllFiltered} disabled={bulkFilteredCandidates.length === 0}>
              {t('concept_mapping.bulk_import_select_all_filtered')}
            </Button>
            <Button size="xs" variant="outline" className="h-7 text-xs" onClick={bulkClearSelection} disabled={bulkSelectedIds.size === 0}>
              {t('concept_mapping.bulk_import_clear_selection')}
            </Button>
          </span>
        </div>

        {/* Datatable */}
        <div
          className="min-h-0 flex-1 overflow-auto rounded-md border"
          onScroll={(e) => {
            const el = e.currentTarget
            // When scrolled to within ~200px of bottom, expand the rendered chunk.
            if (
              el.scrollTop + el.clientHeight >= el.scrollHeight - 200
              && bulkChunkSize < bulkFilteredCandidates.length
            ) {
              setBulkChunkSize((n) => Math.min(n + BULK_CHUNK, bulkFilteredCandidates.length))
            }
          }}
        >
          <Table style={{ tableLayout: 'fixed', width: '100%' }}>
            <TableHeader>
              {bulkTable.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((header) => {
                    const colId = header.column.id
                    const size = header.column.getSize()
                    if (colId === '_select') {
                      return (
                        <TableHead key={header.id} className="text-center" style={{ width: size, maxWidth: size }}>
                          <button
                            type="button"
                            onClick={() => {
                              const allFilteredSelected = bulkFilteredCandidates.length > 0
                                && bulkFilteredCandidates.every((r) => bulkSelectedIds.has(r.key))
                              if (allFilteredSelected) bulkClearSelection()
                              else bulkSelectAllFiltered()
                            }}
                            className="flex w-full justify-center"
                            title={t('concept_mapping.bulk_import_toggle_all')}
                          >
                            {bulkFilteredCandidates.length > 0 && bulkFilteredCandidates.every((r) => bulkSelectedIds.has(r.key))
                              ? <CheckSquare size={14} />
                              : <Square size={14} className="text-muted-foreground" />}
                          </button>
                        </TableHead>
                      )
                    }
                    return (
                      <TableHead key={header.id} className="overflow-hidden text-xs" style={{ width: size, maxWidth: size }}>
                        <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </TruncatedHeader>
                      </TableHead>
                    )
                  })}
                </TableRow>
              ))}
              {/* Filter row mirroring the visible columns */}
              <TableRow className="bg-muted/30">
                {bulkTable.getVisibleLeafColumns().map((c) => {
                  const colId = c.id
                  const size = c.getSize()
                  let filter: ReactNode = null
                  if (colId === 'sourceProjectName') {
                    filter = <MultiSelectFilter
                      value={bulkFilters.sourceProjectIds}
                      options={bulkFilterOptions.projects}
                      placeholder={t('concept_mapping.filter_all')}
                      onChange={(v) => setBulkFilters((p) => ({ ...p, sourceProjectIds: v }))}
                      triggerClass="h-7 w-full justify-start text-[10px]"
                    />
                  } else if (colId === 'sourceVocabularyId') {
                    filter = <MultiSelectFilter
                      value={bulkFilters.sourceVocabIds}
                      options={bulkFilterOptions.sourceVocabs}
                      placeholder={t('concept_mapping.filter_all')}
                      onChange={(v) => setBulkFilters((p) => ({ ...p, sourceVocabIds: v }))}
                      triggerClass="h-7 w-full justify-start text-[10px]"
                    />
                  } else if (colId === 'sourceConceptCode') {
                    filter = <input type="text" className="h-7 w-full rounded border bg-transparent px-1.5 text-[10px] outline-none focus:border-primary" placeholder="…" value={bulkFilters.sourceCode} onChange={(e) => setBulkFilters((p) => ({ ...p, sourceCode: e.target.value }))} />
                  } else if (colId === 'sourceConceptName') {
                    filter = <input type="text" className="h-7 w-full rounded border bg-transparent px-1.5 text-[10px] outline-none focus:border-primary" placeholder="…" value={bulkFilters.sourceName} onChange={(e) => setBulkFilters((p) => ({ ...p, sourceName: e.target.value }))} />
                  } else if (colId === 'targetVocabularyId') {
                    filter = <MultiSelectFilter
                      value={bulkFilters.targetVocabIds}
                      options={bulkFilterOptions.targetVocabs}
                      placeholder={t('concept_mapping.filter_all')}
                      onChange={(v) => setBulkFilters((p) => ({ ...p, targetVocabIds: v }))}
                      triggerClass="h-7 w-full justify-start text-[10px]"
                    />
                  } else if (colId === 'targetConceptId') {
                    filter = <input type="text" className="h-7 w-full rounded border bg-transparent px-1.5 text-[10px] outline-none focus:border-primary" placeholder="…" value={bulkFilters.targetId} onChange={(e) => setBulkFilters((p) => ({ ...p, targetId: e.target.value }))} />
                  } else if (colId === 'targetConceptName') {
                    filter = <input type="text" className="h-7 w-full rounded border bg-transparent px-1.5 text-[10px] outline-none focus:border-primary" placeholder="…" value={bulkFilters.targetName} onChange={(e) => setBulkFilters((p) => ({ ...p, targetName: e.target.value }))} />
                  } else if (colId === 'equivalence') {
                    filter = <MultiSelectFilter
                      value={bulkFilters.equivalences}
                      options={bulkFilterOptions.equivalences}
                      placeholder={t('concept_mapping.filter_all')}
                      onChange={(v) => setBulkFilters((p) => ({ ...p, equivalences: v }))}
                      triggerClass="h-7 w-full justify-start text-[10px]"
                    />
                  } else if (colId === 'status') {
                    filter = <MultiSelectFilter
                      value={bulkFilters.statuses}
                      options={bulkFilterOptions.statuses.map((s) => ({ value: s, label: t(`concept_mapping.status_${s}`) }))}
                      placeholder={t('concept_mapping.filter_all')}
                      onChange={(v) => setBulkFilters((p) => ({ ...p, statuses: v as MappingStatus[] }))}
                      triggerClass="h-7 w-full justify-start text-[10px]"
                    />
                  }
                  return <TableHead key={`f-${c.id}`} className="py-1" style={{ width: size, maxWidth: size }}>{filter}</TableHead>
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {bulkFilteredCandidates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={bulkTable.getVisibleLeafColumns().length} className="h-24 text-center text-xs text-muted-foreground">
                    {t('common.no_results')}
                  </TableCell>
                </TableRow>
              ) : bulkTable.getRowModel().rows.slice(0, bulkChunkSize).map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer text-xs"
                  onClick={() => bulkToggleOne(row.original.key)}
                >
                  {row.getVisibleCells().map((cell) => {
                    const size = cell.column.getSize()
                    return (
                      <TableCell key={cell.id} className="overflow-hidden" style={{ width: size, maxWidth: size }}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
              {bulkFilteredCandidates.length > bulkChunkSize && (
                <TableRow>
                  <TableCell colSpan={bulkTable.getVisibleLeafColumns().length} className="text-center text-[10px] text-muted-foreground">
                    {t('concept_mapping.bulk_import_more_on_scroll', { shown: bulkChunkSize, total: bulkFilteredCandidates.length })}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => setBulkImportOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleBulkImport}
            disabled={bulkImporting || bulkSelectedIds.size === 0}
          >
            {bulkImporting ? <Loader2 size={12} className="mr-1 animate-spin" /> : null}
            {t('concept_mapping.bulk_import_button')} ({bulkSelectedIds.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {/* Bulk import — result dialog */}
    <AlertDialog open={!!bulkResult} onOpenChange={(open) => { if (!open) setBulkResult(null) }}>
      <AlertDialogContent className="sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('concept_mapping.bulk_import_done_title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1">
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
          {/* Import — opens a source picker (file vs. other projects). */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className="h-7 w-7"
                onClick={() => setImportSourceOpen(true)}
                disabled={importing || bulkImporting || !canWrite}
              >
                {(importing || bulkImporting) ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.import_mappings')}</TooltipContent>
          </Tooltip>
          {editMode && selected.size > 0 && (
            <Button variant="destructive" size="sm-tight" onClick={() => setShowDeleteConfirm(true)}>
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
                          className="size-3.5 rounded border-border accent-primary"
                        />
                        <span className="text-xs">{t(`concept_mapping.status_${status}`)}</span>
                        <Badge variant="secondary" className="ml-auto">{count}</Badge>
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
            size="sm-tight"
            onClick={toggleEditMode}
            disabled={!canWrite}
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
                  return (
                    <TableHead
                      key={header.id}
                      className="relative select-none overflow-hidden text-xs"
                      style={{ width: header.getSize(), maxWidth: header.getSize() }}
                    >
                      {isSortable ? (
                        <button
                          type="button"
                          className="flex w-full min-w-0 items-center gap-1 overflow-hidden hover:text-foreground"
                          onClick={() => handleSort(colId)}
                        >
                          <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </TruncatedHeader>
                          <SortIndicator columnId={colId} sorting={sorting} />
                        </button>
                      ) : (
                        <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </TruncatedHeader>
                      )}
                      <ColumnResizeHandle header={header} />
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
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center text-xs text-muted-foreground">
                  {projectMappings.length === 0
                    ? t('concept_mapping.prog_empty')
                    : t('common.no_results')}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.original.id}
                  className="group cursor-pointer"
                  data-state={selected.has(row.original.id) ? 'selected' : undefined}
                  onClick={() => onOpenDetail(row.original.id)}
                >
                  {row.getVisibleCells().map((cell) => {
                    const rendered = flexRender(cell.column.columnDef.cell, cell.getContext())
                    const raw = cell.getValue()
                    const title = raw != null ? String(raw) : undefined
                    return (
                      <TableCell
                        key={cell.id}
                        className="overflow-hidden truncate px-2 py-1 text-xs"
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

      {/* Footer: count + columns on the left, paging on the right — the layout
          ConceptDataTable uses, so the two read the same. */}
      <div className="flex shrink-0 items-center justify-between border-t px-4 py-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            {sorted.length.toLocaleString()} {t('concept_mapping.existing_mappings').toLowerCase()}
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
                    {columnLabel(columns, col.id)}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {pageCount > 1 && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPage(safePage - 1)}
              disabled={safePage === 0}
              aria-label={t('common.previous')}
            >
              <ChevronLeft size={14} />
            </Button>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {safePage + 1} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPage(safePage + 1)}
              disabled={safePage >= pageCount - 1}
              aria-label={t('common.next')}
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        )}
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
