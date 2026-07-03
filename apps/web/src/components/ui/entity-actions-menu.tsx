import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, Pencil, Download, GitBranch, History, MoreHorizontal } from 'lucide-react'
import { EntityVersioningDialog } from '@/components/ui/entity-versioning-dialog'
import type { GitRemoteConfig, LocalizedString } from '@/types'
import { localized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityActionsMenuProps<T extends { id: string; name: LocalizedString | string }> {
  item: T
  onDelete: (id: string) => void | Promise<void>
  onExport?: (item: T) => void
  getGitRemote?: (item: T) => GitRemoteConfig | null
  onSaveGitRemote?: (item: T, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData?: boolean
  renderEditDialog: (props: { item: T; onOpenChange: (open: boolean) => void }) => ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
  /** Optional custom trigger; defaults to a ghost icon "..." button. */
  trigger?: ReactNode
  /** Controls DropdownMenu open state externally (for right-click). Optional. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Alignment for the dropdown content. */
  align?: 'start' | 'end'
  /** Called after a successful delete. Used by the header badge to navigate away
   *  from the now-deleted entity's detail page (the list page doesn't need this). */
  onDeleted?: (id: string) => void
  /** When set, the Export menu item calls this instead of downloading a ZIP or
   *  opening the versioning dialog — e.g. to navigate to the entity's own export
   *  view. Versioning (git) stays available. */
  onExportOverride?: (item: T) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EntityActionsMenu<T extends { id: string; name: LocalizedString | string }>({
  item,
  onDelete,
  onExport,
  getGitRemote,
  onSaveGitRemote,
  exportSupportsIncludeData = true,
  renderEditDialog,
  deleteConfirmTitleKey,
  deleteConfirmDescriptionKey,
  trigger,
  open,
  onOpenChange,
  align = 'end',
  onDeleted,
  onExportOverride,
}: EntityActionsMenuProps<T>) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const menuOpen = open ?? uncontrolledOpen
  const setMenuOpen = onOpenChange ?? setUncontrolledOpen

  const [toEdit, setToEdit] = useState<T | null>(null)
  const [toDelete, setToDelete] = useState<T | null>(null)
  const [versioning, setVersioning] = useState<{ item: T; tab: 'export' | 'git' } | null>(null)

  const versioningEnabled = !!getGitRemote && !!onSaveGitRemote && !!onExport

  const handleDelete = async () => {
    if (toDelete) {
      const deletedId = toDelete.id
      await onDelete(deletedId)
      setToDelete(null)
      onDeleted?.(deletedId)
    }
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal size={14} />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setToEdit(item) }}>
            <Pencil size={14} />
            {t('common.edit')}
          </DropdownMenuItem>
          {(onExport || onExportOverride) ? (
            <DropdownMenuItem onClick={(e) => {
              e.stopPropagation()
              if (onExportOverride) onExportOverride(item)
              else if (versioningEnabled) setVersioning({ item, tab: 'export' })
              else onExport?.(item)
            }}>
              <Download size={14} />
              {t('common.export')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>
              <Download size={14} />
              {t('common.export')}
              <span className="ml-auto text-[10px] text-muted-foreground">{t('common.coming_soon')}</span>
            </DropdownMenuItem>
          )}
          {versioningEnabled && (
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setVersioning({ item, tab: 'git' }) }}>
              <GitBranch size={14} />
              {t('common.versioning')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled>
            <History size={14} />
            {t('common.history')}
            <span className="ml-auto inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground leading-none">{t('common.server_only')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(e) => { e.stopPropagation(); setToDelete(item) }}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 size={14} className="text-destructive" />
            {t('common.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Edit dialog */}
      {toEdit && renderEditDialog({
        item: toEdit,
        onOpenChange: (open) => { if (!open) setToEdit(null) },
      })}

      {/* Versioning dialog (export + git link) */}
      {versioning && getGitRemote && onSaveGitRemote && onExport && (
        <EntityVersioningDialog
          open
          onOpenChange={(open) => { if (!open) setVersioning(null) }}
          initialTab={versioning.tab}
          supportsIncludeData={exportSupportsIncludeData}
          gitRemote={getGitRemote(versioning.item)}
          onExport={() => onExport(versioning.item)}
          onSaveGitRemote={async (config) => {
            await onSaveGitRemote(versioning.item, config)
          }}
        />
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!toDelete} onOpenChange={(open) => { if (!open) setToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(deleteConfirmTitleKey)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(deleteConfirmDescriptionKey, { name: localized(toDelete?.name, language) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
