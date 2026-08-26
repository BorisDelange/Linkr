import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { Cohort } from '@/types'
import {
  UsersRound,
  MoreHorizontal,
  Trash2,
  Pencil,
  Copy,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cardMenuTriggerClass, cn } from '@/lib/utils'
import { ENTITY_COLORS } from '@/lib/entity-colors'
import { Card } from '@/components/ui/card'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { TruncatedText } from '@/components/ui/truncated-text'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface CohortCardProps {
  cohort: Cohort
  /** Target URL, built by the caller through `paths.cohort` so it carries the
   *  same shortened ids the sidebar matches on. */
  href: string
  onRemove: () => void
  onEdit: () => void
  onDuplicate: () => void
  /** Gate the edit / remove menu items (default true for front-only mode). */
  canEdit?: boolean
  canDelete?: boolean
}

const levelColors: Record<string, string> = {
  patient: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  visit: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300',
  visit_detail: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
}

export function CohortCard({
  cohort,
  href,
  onRemove,
  onEdit,
  onDuplicate,
  canEdit = true,
  canDelete = true,
}: CohortCardProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const levelLabel = t(`cohorts.level_${cohort.level}`)
  const criteriaCount = countCriteria(cohort.criteriaTree)

  const handleClick = () => {
    navigate(href)
  }

  return (
    <Card
      className="flex min-h-44 min-w-0 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent"
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick() }}
    >
      <div className="flex flex-1 flex-col px-4 pt-5">
       <div className="flex flex-1 flex-col justify-center">
        {/* Row 1: icon + title + level pill + actions */}
        <div className="flex items-center gap-3">
          <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', ENTITY_COLORS.cohorts.bg)}>
            <UsersRound size={20} className={ENTITY_COLORS.cohorts.icon} />
          </div>
          <TruncatedText text={cohort.name} readOnly className="min-w-0 flex-1 text-sm font-medium" />
          <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${levelColors[cohort.level] ?? ''}`}>
            {levelLabel}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn('ml-auto shrink-0', cardMenuTriggerClass)}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!canEdit} onClick={(e) => { e.stopPropagation(); onEdit() }}>
                <Pencil size={14} />
                {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canEdit} onClick={(e) => { e.stopPropagation(); onDuplicate() }}>
                <Copy size={14} />
                {t('common.duplicate')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!canDelete}
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 size={14} className="text-destructive" />
                {t('cohorts.remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* Description */}
        <div className="mt-2 h-4">
          {cohort.description && (
            <TruncatedText text={cohort.description} className="text-xs text-muted-foreground" />
          )}
        </div>
        {/* Criteria + results */}
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{t('cohorts.card_criteria', { count: criteriaCount })}</span>
          {cohort.resultCount != null && (
            <span className="font-medium text-foreground">
              {cohort.resultCount.toLocaleString()} {t('cohorts.results_count')}
            </span>
          )}
        </div>
       </div>
        <CardMetaFooter
          createdById={cohort.createdById}
          createdBy={cohort.createdBy}
          createdByDetails={cohort.createdByDetails}
          createdAt={cohort.createdAt}
          updatedAt={cohort.updatedAt}
        />
      </div>
    </Card>
  )
}

/** Count total leaf criteria in the tree */
function countCriteria(node: Cohort['criteriaTree']): number {
  let count = 0
  for (const child of node.children) {
    if (child.kind === 'criterion') count++
    else count += countCriteria(child)
  }
  return count
}
