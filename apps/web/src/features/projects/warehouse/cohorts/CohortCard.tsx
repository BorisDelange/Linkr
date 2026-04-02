import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { Cohort } from '@/types'
import {
  UsersRound,
  MoreHorizontal,
  Trash2,
  Pencil,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  basePath: string
  onRemove: () => void
  onRename: (name: string) => void
}

const levelColors: Record<string, string> = {
  patient: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  visit: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300',
  visit_detail: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
}

export function CohortCard({
  cohort,
  basePath,
  onRemove,
  onRename,
}: CohortCardProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [renaming, setRenaming] = useState(false)
  const [nameValue, setNameValue] = useState('')

  const levelLabel = t(`cohorts.level_${cohort.level}`)
  const criteriaCount = countCriteria(cohort.criteriaTree)

  const handleClick = () => {
    if (renaming) return
    navigate(`${basePath}/${cohort.id}`)
  }

  const handleStartRename = (e: React.MouseEvent) => {
    e.stopPropagation()
    setNameValue(cohort.name)
    setRenaming(true)
  }

  const handleSaveRename = () => {
    if (nameValue.trim()) {
      onRename(nameValue.trim())
    }
    setRenaming(false)
  }

  return (
    <Card
      className="hover:border-primary/30 hover:bg-accent/50 transition-colors cursor-pointer"
    >
      <CardContent
        className="p-5"
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick() }}
      >
        {/* Header row */}
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
              <UsersRound size={18} className="text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {renaming ? (
                  <Input
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') handleSaveRename()
                      if (e.key === 'Escape') setRenaming(false)
                    }}
                    onBlur={handleSaveRename}
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 text-sm w-48"
                    autoFocus
                  />
                ) : (
                  <h3 className="text-sm font-semibold truncate">{cohort.name}</h3>
                )}
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0 ${levelColors[cohort.level] ?? ''}`}>
                  {levelLabel}
                </span>
              </div>
              {cohort.description && (
                <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{cohort.description}</p>
              )}
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleStartRename}>
                <Pencil size={14} />
                {t('cohorts.rename')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 size={14} className="text-destructive" />
                {t('cohorts.remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Stats */}
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{t('cohorts.card_criteria', { count: criteriaCount })}</span>
          {cohort.resultCount != null && (
            <span className="font-medium text-foreground">
              {cohort.resultCount.toLocaleString()} {t('cohorts.results_count')}
            </span>
          )}
        </div>
      </CardContent>
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
