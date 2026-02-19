import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search, Check, Flag, X, MessageSquare,
  ChevronLeft, ChevronRight, Pencil, Trash2, Square, CheckSquare,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import type { MappingProject, MappingStatus } from '@/types'

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

// ─── Equivalence short labels ────────────────────────────────────────

const EQUIV_SHORT: Record<string, string> = {
  'skos:exactMatch': 'Exact',
  'skos:closeMatch': 'Close',
  'skos:broadMatch': 'Broad',
  'skos:narrowMatch': 'Narrow',
  'skos:relatedMatch': 'Related',
  equal: 'Exact', equivalent: 'Close', wider: 'Broad', narrower: 'Narrow', inexact: 'Related',
}

export function MappingsTab({ project }: MappingsTabProps) {
  const { t } = useTranslation()
  const { mappings, updateMapping, deleteMapping } = useConceptMappingStore()

  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const projectMappings = mappings.filter((m) => m.projectId === project.id)

  const filtered = filter.trim()
    ? projectMappings.filter((m) => {
        const q = filter.toLowerCase()
        return (
          m.sourceConceptName.toLowerCase().includes(q) ||
          m.targetConceptName.toLowerCase().includes(q) ||
          String(m.sourceConceptId).includes(q) ||
          String(m.targetConceptId).includes(q) ||
          m.sourceVocabularyId.toLowerCase().includes(q) ||
          m.targetVocabularyId.toLowerCase().includes(q) ||
          m.status.includes(q) ||
          m.equivalence.includes(q)
        )
      })
    : projectMappings

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const handleFilterChange = (value: string) => {
    setFilter(value)
    setPage(0)
  }

  const toggleEditMode = () => {
    setEditMode(!editMode)
    setSelected(new Set())
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
  const handleReview = (mappingId: string, current: MappingStatus, target: MappingStatus) => {
    updateMapping(mappingId, { status: current === target ? 'unchecked' : target })
  }

  const pageAllSelected = pageItems.length > 0 && pageItems.every((m) => selected.has(m.id))

  // Grid templates
  const editCols = 'grid-cols-[28px_1fr_50px_1fr_50px_60px_70px_60px]'
  const reviewCols = 'grid-cols-[1fr_50px_1fr_50px_60px_70px_60px_90px]'

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <div className="relative max-w-sm flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder={t('concept_mapping.mappings_filter')}
            value={filter}
            onChange={(e) => handleFilterChange(e.target.value)}
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
          {editMode && selected.size > 0 && (
            <Button variant="destructive" size="sm" className="h-7 gap-1 text-xs" onClick={handleDeleteSelected}>
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
        </div>
      </div>

      {/* Column headers */}
      <div className={`grid items-center gap-1 border-b bg-muted/30 px-4 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider ${editMode ? editCols : reviewCols}`}>
        {editMode && (
          <button onClick={toggleSelectAll} className="flex justify-center">
            {pageAllSelected
              ? <CheckSquare size={14} className="text-foreground" />
              : <Square size={14} />}
          </button>
        )}
        <span>{t('concept_mapping.col_source')}</span>
        <span>ID</span>
        <span>{t('concept_mapping.col_target')}</span>
        <span>ID</span>
        <span>{t('concept_mapping.col_vocab')}</span>
        <span>{t('concept_mapping.col_status')}</span>
        <span>{t('concept_mapping.col_equiv')}</span>
        {!editMode && <span className="text-right">{t('concept_mapping.col_review')}</span>}
      </div>

      {/* Table body */}
      <div className="flex-1 overflow-auto">
        {pageItems.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-xs text-muted-foreground">
              {projectMappings.length === 0
                ? t('concept_mapping.prog_empty')
                : t('common.no_results')}
            </p>
          </div>
        ) : (
          pageItems.map((m) => (
            <div
              key={m.id}
              className={`group grid w-full items-center gap-1 border-b border-border/40 px-4 py-1 text-xs hover:bg-accent/30 ${
                editMode ? editCols : reviewCols
              } ${selected.has(m.id) ? 'bg-accent/40' : ''}`}
            >
              {/* Edit mode: checkbox */}
              {editMode && (
                <button onClick={() => toggleSelect(m.id)} className="flex justify-center">
                  {selected.has(m.id)
                    ? <CheckSquare size={14} className="text-foreground" />
                    : <Square size={14} className="text-muted-foreground" />}
                </button>
              )}

              {/* Source */}
              <span className="truncate" title={m.sourceConceptName}>{m.sourceConceptName}</span>
              <span className="text-muted-foreground">{m.sourceConceptId}</span>

              {/* Target */}
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate" title={m.targetConceptName}>{m.targetConceptName}</span>
                {m.comment && <MessageSquare size={10} className="shrink-0 text-muted-foreground" title={m.comment} />}
              </span>
              <span className="text-muted-foreground">{m.targetConceptId}</span>
              <span className="truncate text-muted-foreground">{m.targetVocabularyId}</span>

              {/* Status badge */}
              <span>
                <Badge
                  variant="secondary"
                  className={`px-1.5 py-0 text-[9px] font-medium ${STATUS_BADGE[m.status] ?? ''}`}
                >
                  {t(`concept_mapping.status_${m.status}`)}
                </Badge>
              </span>

              {/* Equivalence */}
              <span className="truncate text-[10px] text-muted-foreground" title={m.equivalence}>
                {EQUIV_SHORT[m.equivalence] ?? m.equivalence}
              </span>

              {/* Review mode: action buttons */}
              {!editMode && (
                <span className="flex justify-end gap-1 opacity-0 group-hover:opacity-100">
                  <Button
                    variant={m.status === 'approved' ? 'default' : 'outline'}
                    size="icon-sm"
                    className={`size-6 ${m.status === 'approved' ? 'bg-green-600 text-white hover:bg-green-700' : 'hover:border-green-600 hover:text-green-600'}`}
                    title={t('concept_mapping.approve')}
                    onClick={() => handleReview(m.id, m.status, 'approved')}
                  >
                    <Check size={13} />
                  </Button>
                  <Button
                    variant={m.status === 'rejected' ? 'default' : 'outline'}
                    size="icon-sm"
                    className={`size-6 ${m.status === 'rejected' ? 'bg-red-600 text-white hover:bg-red-700' : 'hover:border-red-600 hover:text-red-600'}`}
                    title={t('concept_mapping.reject')}
                    onClick={() => handleReview(m.id, m.status, 'rejected')}
                  >
                    <X size={13} />
                  </Button>
                  <Button
                    variant={m.status === 'flagged' ? 'default' : 'outline'}
                    size="icon-sm"
                    className={`size-6 ${m.status === 'flagged' ? 'bg-orange-500 text-white hover:bg-orange-600' : 'hover:border-orange-500 hover:text-orange-500'}`}
                    title={t('concept_mapping.flag')}
                    onClick={() => handleReview(m.id, m.status, 'flagged')}
                  >
                    <Flag size={13} />
                  </Button>
                </span>
              )}
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t px-4 py-1.5">
        <span className="text-[10px] text-muted-foreground">
          {filtered.length} {t('concept_mapping.existing_mappings').toLowerCase()}
        </span>
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
    </div>
  )
}
