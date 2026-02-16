import { useTranslation } from 'react-i18next'
import type { Cohort } from '@/types'
import {
  UsersRound,
  Pencil,
  MoreHorizontal,
  Trash2,
  Play,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface CohortCardProps {
  cohort: Cohort
  onEdit: () => void
  onRemove: () => void
  onExecute: () => void
  hasDataSource: boolean
}

const levelColors: Record<string, string> = {
  patient: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  visit_occurrence: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300',
  visit_detail: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
}

export function CohortCard({
  cohort,
  onEdit,
  onRemove,
  onExecute,
  hasDataSource,
}: CohortCardProps) {
  const { t } = useTranslation()

  const levelLabel = t(`subsets.level_${cohort.level}`)
  const criteriaCount = cohort.criteria.length

  return (
    <Card>
      <CardContent className="p-5">
        {/* Header row */}
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
              <UsersRound size={18} className="text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">{cohort.name}</h3>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${levelColors[cohort.level] ?? ''}`}>
                  {levelLabel}
                </span>
              </div>
              {cohort.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">{cohort.description}</p>
              )}
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{t('subsets.card_criteria', { count: criteriaCount })}</span>
          {cohort.resultCount != null && (
            <span>{t('subsets.card_results', { count: cohort.resultCount })}</span>
          )}
        </div>

        {/* Actions */}
        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onExecute}
            disabled={!hasDataSource}
            className="gap-1.5 text-xs"
          >
            <Play size={12} />
            {t('subsets.execute')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            className="gap-1.5 text-xs"
          >
            <Pencil size={12} />
            {t('data_sources.edit')}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onRemove}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 size={14} />
                {t('subsets.remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  )
}
