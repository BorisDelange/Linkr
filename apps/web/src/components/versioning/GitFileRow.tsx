import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { GitFileChange, GitScope } from '@/lib/api/git'
import { getBadgeClasses } from '@/lib/badge-colors'
import { gitFileMeta } from '@/lib/git-file-meta'
import { cn } from '@/lib/utils'
import { ChangeBadge } from './ChangeBadge'

interface GitFileRowProps {
  scope: GitScope
  file: GitFileChange
  checked: boolean
  isLfs: boolean
  onToggleSelect: () => void
  onToggleLfs: () => void
  onOpenDiff: () => void
  /** Open the mappings review table. Absent for scopes without a mappings.json. */
  onViewMappings?: () => void
}

/** One row of the changes list: commit checkbox, change badge, path, an LFS chip
 *  (click to toggle), an info icon (hover = what the file is for), and a
 *  right-click menu to add/remove LFS tracking. */
export function GitFileRow({ scope, file, checked, isLfs, onToggleSelect, onToggleLfs, onOpenDiff, onViewMappings }: GitFileRowProps) {
  const { t } = useTranslation()
  const descriptionKey = gitFileMeta(scope, file.path).descriptionKey
  const description = descriptionKey ? t(descriptionKey) : null
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50">
          <Checkbox checked={checked} onCheckedChange={onToggleSelect} className="shrink-0" />
          <button
            type="button"
            onClick={onOpenDiff}
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
          >
            <ChangeBadge changeType={file.changeType} />
            <span className="truncate font-mono">{file.path}</span>
          </button>
          {/* Mirrors the pull row's Choose: a text diff of a generated JSON hides
              which mappings actually move. */}
          {onViewMappings && file.path === 'mappings.json' && (
            <button
              type="button"
              onClick={onViewMappings}
              className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {t('versioning.push_view_mappings')}
            </button>
          )}
          {isLfs && (
            <button
              type="button"
              onClick={onToggleLfs}
              title={t('versioning.lfs_remove')}
              className={cn('shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-bold tracking-wide hover:opacity-80', getBadgeClasses('violet'))}
            >
              LFS
            </button>
          )}
          {description && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 cursor-help text-muted-foreground/60 hover:text-muted-foreground" aria-label={description}>
                  <Info size={12} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs text-xs">
                {description}
              </TooltipContent>
            </Tooltip>
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onToggleLfs}>
          {isLfs ? t('versioning.lfs_remove') : t('versioning.lfs_add')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
