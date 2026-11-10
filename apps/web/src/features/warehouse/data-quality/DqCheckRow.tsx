import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { InlineRenameField } from '@/components/InlineRenameField'
import { useOverflowTooltip } from '@/hooks/use-overflow-tooltip'
import type { DqCategory } from '@/lib/dq-taxonomy'
import { cn } from '@/lib/utils'
import { CATEGORY_DOT } from './DqConstants'
import { DRAG_CHECKS } from './check-tree'

/**
 * One check in a checks sidebar (a rule set's, a quality profile's). Its actions
 * live on the right-click menu (`menu`) rather than hover icons, matching the
 * IDE and plugin file sidebars — hover clusters competed with the name for the
 * row's width.
 */
export function DqCheckRow({
  id,
  name,
  category,
  dirty = false,
  disabled,
  selected,
  editMode,
  checked,
  renaming = false,
  onSelect,
  onToggleSelected,
  onRename,
  onCancelRename,
  menu,
  dragIds,
}: {
  id: string
  name: string
  category: DqCategory
  /** Its queries hold unsaved edits. */
  dirty?: boolean
  disabled: boolean
  selected: boolean
  editMode: boolean
  checked: boolean
  renaming?: boolean
  onSelect: () => void
  onToggleSelected: () => void
  onRename?: (next: string) => void
  onCancelRename?: () => void
  /** The right-click menu's items; none, no menu. Hidden while selecting several. */
  menu?: ReactNode
  /** Makes the row draggable onto a category: the ids it carries (itself, or the selection it is in). */
  dragIds?: () => string[]
}) {
  const { t } = useTranslation()
  const { ref: nameRef, overflows, triggerProps } = useOverflowTooltip()

  const dot = (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn(
          'inline-block h-2 w-2 shrink-0 rounded-full',
          CATEGORY_DOT[category],
        )} />
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs">
        <span className="font-semibold">{t(`data_quality.category_${category}`)}</span>
        {' — '}
        {t(`data_quality.category_${category}_help`)}
      </TooltipContent>
    </Tooltip>
  )

  // A fixed height, not vertical padding: the rename field then fits inside the
  // row (h-5, `-ml-0.5` absorbing its border) and neither the row nor the text moves.
  const rowClass = cn(
    'flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs transition-colors',
    selected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50',
    disabled && 'opacity-50',
  )

  if (renaming && onRename && onCancelRename) {
    return (
      <div className={rowClass}>
        {editMode && <Checkbox checked={checked} disabled className="size-3.5 shrink-0" />}
        {dot}
        <InlineRenameField
          initialValue={name}
          onSubmit={onRename}
          onCancel={onCancelRename}
          className="-ml-0.5 h-5"
        />
      </div>
    )
  }

  return (
    <Tooltip>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(rowClass, 'group')}
            data-check-id={id}
            draggable={!!dragIds}
            onDragStart={dragIds ? (e) => {
              e.dataTransfer.setData(DRAG_CHECKS, JSON.stringify(dragIds()))
              e.dataTransfer.effectAllowed = 'move'
            } : undefined}
          >
            {editMode && (
              <Checkbox
                checked={checked}
                onCheckedChange={onToggleSelected}
                className="size-3.5 shrink-0"
                aria-label={t('common.select')}
              />
            )}
            {dot}
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onSelect}
                {...triggerProps}
                className={cn('min-w-0 flex-1 truncate text-left', disabled && 'line-through')}
              >
                <span ref={nameRef} className="block truncate">{name}</span>
              </button>
            </TooltipTrigger>
            {dirty && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-orange-400"
                title={t('data_quality.unsaved')}
              />
            )}
          </div>
        </ContextMenuTrigger>
        {menu && !editMode && <ContextMenuContent>{menu}</ContextMenuContent>}
      </ContextMenu>
      {overflows && <TooltipContent side="right">{name}</TooltipContent>}
    </Tooltip>
  )
}
