import { useState, type DragEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { InlineRenameField } from '@/components/InlineRenameField'
import { groupLabel, nodeChecks, type DqGroupNode } from '@/lib/dq-groups'
import { cn } from '@/lib/utils'
import { DRAG_CHECKS, DRAG_GROUP, groupFoldKey } from './check-tree'

export interface DqCheckTreeDnd {
  /** Checks dropped on a category; null: "Other checks". */
  onDropChecks: (ids: string[], groupKey: string | null) => void
  /** A category dropped on another (its new parent) or on the tree's background (null: the top). */
  onDropGroup: (key: string, parentKey: string | null) => void
  canMoveGroup: (key: string, parentKey: string | null) => boolean
}

interface Props<C> {
  roots: DqGroupNode<C>[]
  ungrouped: C[]
  /** Prefix of the fold keys: one tree per rule set in a profile. */
  scope?: string
  isOpen: (foldKey: string) => boolean
  onToggle: (foldKey: string) => void
  renderCheck: (check: C) => ReactNode
  /** The right-click menu of a category; `key` null is "Other checks". */
  groupMenu?: (key: string | null, node?: DqGroupNode<C>) => ReactNode
  /** Count shown on a header: enabled / all when some are disabled. */
  isDisabled?: (check: C) => boolean
  renaming?: string | null
  onRename?: (key: string, name: string) => void
  onCancelRename?: () => void
  renameClash?: (key: string, candidate: string) => boolean
  dnd?: DqCheckTreeDnd
  /** Whether to show "Other checks" when no check is in it. */
  showEmptyOther?: boolean
}

function dragKind(e: DragEvent): 'checks' | 'group' | null {
  if (e.dataTransfer.types.includes(DRAG_CHECKS)) return 'checks'
  if (e.dataTransfer.types.includes(DRAG_GROUP)) return 'group'
  return null
}

/**
 * A rule set's checks under its categories, nested, each folding on its own;
 * the checks filed under none last, as "Other checks". With `dnd`, checks and
 * categories are dragged onto a category to move them there, and a category
 * dropped on the empty space below the tree goes back to the top.
 */
export function DqCheckTree<C>({
  roots, ungrouped, scope = '', isOpen, onToggle, renderCheck, groupMenu, isDisabled,
  renaming, onRename, onCancelRename, renameClash, dnd, showEmptyOther = false,
}: Props<C>) {
  const { t, i18n } = useTranslation()
  const [over, setOver] = useState<string | null>(null)
  const [overRoot, setOverRoot] = useState(false)

  const dropTarget = (key: string | null) => {
    const id = key ?? ''
    return dnd ? {
      onDragOver: (e: DragEvent) => {
        const kind = dragKind(e)
        // "Other checks" takes checks only: a category is moved to the top on the background.
        if (!kind || (kind === 'group' && key === null)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setOver(id)
        setOverRoot(false)
      },
      onDragLeave: () => setOver((prev) => (prev === id ? null : prev)),
      onDrop: (e: DragEvent) => {
        setOver(null)
        const checks = e.dataTransfer.getData(DRAG_CHECKS)
        const group = e.dataTransfer.getData(DRAG_GROUP)
        if (!checks && !group) return
        e.preventDefault()
        e.stopPropagation()
        if (checks) dnd.onDropChecks(JSON.parse(checks) as string[], key)
        else if (key !== null && group !== key && dnd.canMoveGroup(group, key)) dnd.onDropGroup(group, key)
      },
    } : {}
  }

  const header = (key: string | null, label: string, checks: C[], node?: DqGroupNode<C>) => {
    const foldKey = groupFoldKey(scope, key ?? '')
    const open = isOpen(foldKey)
    const disabled = isDisabled ? checks.filter(isDisabled).length : 0
    const chevron = open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />
    const rowClass = 'flex h-6 w-full items-center gap-1 rounded px-1 text-left text-[10px] font-semibold text-muted-foreground'
    if (key !== null && renaming === key && onRename && onCancelRename) {
      return (
        <div className={rowClass}>
          {chevron}
          <InlineRenameField
            initialValue={label}
            onSubmit={(next) => onRename(key, next)}
            onCancel={onCancelRename}
            hasClash={renameClash ? (candidate) => renameClash(key, candidate) : undefined}
            className="-ml-0.5 h-5"
          />
        </div>
      )
    }
    const button = (
      <button
        type="button"
        onClick={() => onToggle(foldKey)}
        draggable={!!dnd && key !== null}
        onDragStart={key !== null ? (e) => {
          e.dataTransfer.setData(DRAG_GROUP, key)
          e.dataTransfer.effectAllowed = 'move'
        } : undefined}
        {...dropTarget(key)}
        className={cn(rowClass, 'hover:bg-accent/50', over === (key ?? '') && 'bg-accent/70 ring-1 ring-primary/50')}
      >
        {chevron}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 font-normal tabular-nums text-muted-foreground/70">
          {disabled ? `${checks.length - disabled}/${checks.length}` : checks.length}
        </span>
      </button>
    )
    const menu = groupMenu?.(key, node)
    if (!menu) return button
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
        <ContextMenuContent>{menu}</ContextMenuContent>
      </ContextMenu>
    )
  }

  const renderNode = (node: DqGroupNode<C>): ReactNode => {
    const open = isOpen(groupFoldKey(scope, node.key))
    return (
      <div key={node.key}>
        {header(node.key, groupLabel(node, i18n.language), nodeChecks(node), node)}
        {open && (
          <div className="space-y-0.5 pl-3">
            {node.children.map(renderNode)}
            {node.checks.map(renderCheck)}
            {node.checks.length === 0 && node.children.length === 0 && (
              <p className="py-1 pl-4 pr-2 text-[10px] text-muted-foreground/70">{t('data_quality.group_empty')}</p>
            )}
          </div>
        )}
      </div>
    )
  }

  const showOther = ungrouped.length > 0 || showEmptyOther
  return (
    <div
      className={cn('min-h-full space-y-0.5 pb-6', overRoot && 'rounded bg-accent/30')}
      onDragOver={dnd ? (e) => {
        if (dragKind(e) !== 'group') return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOverRoot(true)
        setOver(null)
      } : undefined}
      onDragLeave={dnd ? () => setOverRoot(false) : undefined}
      onDrop={dnd ? (e) => {
        setOverRoot(false)
        const group = e.dataTransfer.getData(DRAG_GROUP)
        if (!group) return
        e.preventDefault()
        if (dnd.canMoveGroup(group, null)) dnd.onDropGroup(group, null)
      } : undefined}
    >
      {roots.map(renderNode)}
      {showOther && (
        <div>
          {header(null, t('data_quality.group_other'), ungrouped)}
          {isOpen(groupFoldKey(scope, '')) && (
            <div className="space-y-0.5 pl-3">
              {ungrouped.map(renderCheck)}
              {ungrouped.length === 0 && (
                <p className="py-1 pl-4 pr-2 text-[10px] text-muted-foreground/70">{t('data_quality.group_empty')}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
