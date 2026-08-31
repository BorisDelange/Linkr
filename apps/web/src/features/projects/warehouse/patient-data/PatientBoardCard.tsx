import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { PatientDashboard } from '@/types'
import {
  User,
  MoreHorizontal,
  Trash2,
  Pencil,
  Copy,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cardMenuTriggerClass, cn, isTypingTarget } from '@/lib/utils'
import { ENTITY_COLORS } from '@/lib/entity-colors'
import { Card } from '@/components/ui/card'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { EntityDatabaseLine } from '@/components/ui/entity-database-line'
import { TruncatedText } from '@/components/ui/truncated-text'
import { selectedCardClass } from '@/components/ui/use-card-selection'
import { localized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface PatientBoardCardProps {
  board: PatientDashboard
  /** Target URL, built by the caller through `paths.patientBoard` so it carries
   *  the same shortened ids the sidebar matches on. */
  href: string
  onRemove: () => void
  onEdit: () => void
  onDuplicate: () => void
  /** Gate the edit / remove menu items (default true for front-only mode). */
  canEdit?: boolean
  canDelete?: boolean
  /** Part of a multi-selection — greys the card out. */
  selected?: boolean
  /** Returns true when the click was consumed as a selection gesture, so the card skips navigation. */
  onSelectClick?: (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => boolean
}

export function PatientBoardCard({
  board,
  href,
  onRemove,
  onEdit,
  onDuplicate,
  canEdit = true,
  canDelete = true,
  selected = false,
  onSelectClick,
}: PatientBoardCardProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const language = useAppStore((s) => s.language)

  const description = board.description ? localized(board.description, language) : ''

  const handleClick = () => {
    navigate(href)
  }

  return (
    <Card
      className={cn(
        'flex min-h-44 min-w-0 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent',
        selected && selectedCardClass,
      )}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (onSelectClick?.(e)) return
        handleClick()
      }}
      onKeyDown={(e) => {
        if (isTypingTarget(e)) return
        if (e.key === 'Enter' || e.key === ' ') handleClick()
      }}
    >
      <div className="flex flex-1 flex-col px-4 pt-5">
       <div className="flex flex-1 flex-col justify-center">
        {/* Row 1: icon + title + actions */}
        <div className="flex items-center gap-3">
          <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', ENTITY_COLORS['patient-data'].bg)}>
            <User size={20} className={ENTITY_COLORS['patient-data'].icon} />
          </div>
          <TruncatedText
            text={localized(board.name, language)}
            readOnly
            className="min-w-0 flex-1 text-sm font-medium"
          />
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
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* Description */}
        <div className="mt-2 h-4">
          {description && (
            <TruncatedText text={description} className="text-xs text-muted-foreground" />
          )}
        </div>
        <EntityDatabaseLine projectUid={board.projectUid} dataSourceId={board.dataSourceId} />
       </div>
        <CardMetaFooter
          createdById={board.createdById}
          createdBy={board.createdBy}
          createdByDetails={board.createdByDetails}
          createdAt={board.createdAt}
          updatedAt={board.updatedAt}
        />
      </div>
    </Card>
  )
}
