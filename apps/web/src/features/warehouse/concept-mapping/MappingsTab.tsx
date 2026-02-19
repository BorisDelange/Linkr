import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Check, Flag, X, MessageSquare, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import type { MappingProject } from '@/types'

interface MappingsTabProps {
  project: MappingProject
}

const PAGE_SIZE = 50

const STATUS_DOT: Record<string, string> = {
  unchecked: 'bg-gray-400',
  approved: 'bg-green-500',
  rejected: 'bg-red-500',
  flagged: 'bg-orange-500',
  invalid: 'bg-red-500',
  ignored: 'bg-gray-300',
}

export function MappingsTab({ project }: MappingsTabProps) {
  const { t } = useTranslation()
  const { mappings, updateMapping, deleteMapping } = useConceptMappingStore()

  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)

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

  // Reset page when filter changes
  const handleFilterChange = (value: string) => {
    setFilter(value)
    setPage(0)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="border-b px-4 py-2">
        <div className="relative max-w-sm">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder={t('concept_mapping.mappings_filter')}
            value={filter}
            onChange={(e) => handleFilterChange(e.target.value)}
          />
        </div>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_60px_1fr_60px_70px_60px_60px_50px] items-center gap-1 border-b bg-muted/30 px-4 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        <span>{t('concept_mapping.col_source')}</span>
        <span>ID</span>
        <span>{t('concept_mapping.col_target')}</span>
        <span>ID</span>
        <span>{t('concept_mapping.col_vocab')}</span>
        <span>{t('concept_mapping.col_status')}</span>
        <span>{t('concept_mapping.col_equiv')}</span>
        <span />
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
              className="group grid w-full grid-cols-[1fr_60px_1fr_60px_70px_60px_60px_50px] items-center gap-1 border-b border-border/40 px-4 py-1 text-xs hover:bg-accent/30"
            >
              <span className="truncate" title={m.sourceConceptName}>
                {m.sourceConceptName}
              </span>
              <span className="text-muted-foreground">{m.sourceConceptId}</span>
              <span className="flex items-center gap-1.5 min-w-0">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[m.status] ?? 'bg-gray-400'}`}
                />
                <span className="truncate" title={m.targetConceptName}>{m.targetConceptName}</span>
                {m.comment && (
                  <MessageSquare size={10} className="shrink-0 text-muted-foreground" title={m.comment} />
                )}
              </span>
              <span className="text-muted-foreground">{m.targetConceptId}</span>
              <span className="truncate text-muted-foreground">{m.targetVocabularyId}</span>
              <span className="text-[10px]">{m.status}</span>
              <span className="text-[10px] text-muted-foreground">{m.equivalence}</span>
              <span className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100">
                <button
                  className="text-muted-foreground hover:text-green-600"
                  title={t('concept_mapping.approve')}
                  onClick={() => updateMapping(m.id, { status: 'approved' })}
                >
                  <Check size={12} />
                </button>
                <button
                  className="text-muted-foreground hover:text-orange-500"
                  title={t('concept_mapping.flag')}
                  onClick={() => updateMapping(m.id, { status: 'flagged' })}
                >
                  <Flag size={12} />
                </button>
                <button
                  className="text-muted-foreground hover:text-destructive"
                  title={t('common.delete')}
                  onClick={() => deleteMapping(m.id)}
                >
                  <X size={12} />
                </button>
              </span>
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
