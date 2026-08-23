import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, Pencil, Copy, Download, GitBranch, MoreHorizontal, BookOpen, Scale } from 'lucide-react'
import { EntityVersioningDialog } from '@/components/ui/entity-versioning-dialog'
import { EntityDocsDialog, type DocsTab } from '@/components/ui/entity-docs-dialog'
import { EtlPipelinePull } from '@/components/versioning/EtlPipelinePull'
import { SchemaPresetPull } from '@/components/versioning/SchemaPresetPull'
import { useEtlStore } from '@/stores/etl-store'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import type { GitScope } from '@/lib/api/git'
import type { EntityLicense, GitRemoteConfig, LocalizedString, ReadmeOwnerType } from '@/types'
import { localized } from '@/lib/localized'
import { cardMenuTriggerClass } from '@/lib/utils'
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
  /** Adds a Duplicate item after Edit. Omit for an entity that can't be copied
   *  (a workspace, whose contents are too tangled to clone meaningfully). */
  onDuplicate?: (item: T) => void | Promise<void>
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
  /** When set, the Versioning item calls this instead of opening the git dialog —
   *  e.g. to navigate to the entity's own Versioning tab. */
  onVersioningOverride?: (item: T) => void
  /** When false, the Edit item is disabled (viewer). Default true. */
  canEdit?: boolean
  /** When false, the Delete item is disabled (non-owner). Default true. */
  canDelete?: boolean
  /** Extra menu items inserted before the delete separator (e.g. Duplicate). */
  extraItems?: ReactNode
  /** When set, the versioning dialog's Git tab shows the push-only sync panel
   *  for this scope (server mode); the item's id is used as the sync id. */
  syncScope?: GitScope
  /** When set, adds Readme and License items opening the shared docs dialog. */
  docs?: EntityDocsAccessors<T>
}

/** How an entity's README and license are read and written, for the docs dialog. */
export interface EntityDocsAccessors<T> {
  getReadme: (item: T) => LocalizedString | string | undefined
  onSaveReadme: (item: T, readme: LocalizedString) => void | Promise<void>
  getLicense: (item: T) => EntityLicense | null | undefined
  onSaveLicense: (item: T, license: EntityLicense | null) => void | Promise<void>
  /** Owner type for README image attachments. Omitted = no attachments. */
  attachmentOwnerType?: ReadmeOwnerType
  /** Attachment owner id, when it is not the item's `id` (e.g. schema presets). */
  getOwnerId?: (item: T) => string
  getWorkspaceId?: (item: T) => string | undefined
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EntityActionsMenu<T extends { id: string; name: LocalizedString | string }>({
  item,
  onDelete,
  onDuplicate,
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
  onVersioningOverride,
  canEdit = true,
  canDelete = true,
  extraItems,
  syncScope,
  docs,
}: EntityActionsMenuProps<T>) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const menuOpen = open ?? uncontrolledOpen
  const setMenuOpen = onOpenChange ?? setUncontrolledOpen

  const [toEdit, setToEdit] = useState<T | null>(null)
  const [toDelete, setToDelete] = useState<T | null>(null)
  const [versioning, setVersioning] = useState<{ item: T; tab: 'export' | 'git' } | null>(null)
  const [docsOpen, setDocsOpen] = useState<{ item: T; tab: DocsTab } | null>(null)

  // Git versioning is available whenever the entity exposes a remote getter/setter.
  // The Export tab of the dialog needs a real onExport; when the entity exports via
  // a dedicated page instead (onExportOverride), the dialog shows the Git tab only.
  const hasGit = !!getGitRemote && !!onSaveGitRemote
  const versioningEnabled = hasGit && !!onExport
  const gitOnly = hasGit && !onExport

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
        {/* Right-click opens the menu too (asChild merges the handler onto the trigger). */}
        <DropdownMenuTrigger
          asChild
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(!menuOpen) }}
        >
          {trigger ?? (
            <Button
              variant="ghost"
              size="icon-sm"
              className={cardMenuTriggerClass}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal size={14} />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          <DropdownMenuItem disabled={!canEdit} onClick={(e) => { e.stopPropagation(); setToEdit(item) }}>
            <Pencil size={14} />
            {t('common.edit')}
          </DropdownMenuItem>
          {onDuplicate && (
            <DropdownMenuItem disabled={!canEdit} onClick={(e) => { e.stopPropagation(); onDuplicate(item) }}>
              <Copy size={14} />
              {t('common.duplicate')}
            </DropdownMenuItem>
          )}
          {(onExport || onExportOverride) && (
            <DropdownMenuItem onClick={(e) => {
              e.stopPropagation()
              if (onExportOverride) onExportOverride(item)
              else if (versioningEnabled) setVersioning({ item, tab: 'export' })
              else onExport?.(item)
            }}>
              <Download size={14} />
              {t('common.export')}
            </DropdownMenuItem>
          )}
          {(onVersioningOverride || versioningEnabled || gitOnly) && (
            <DropdownMenuItem onClick={(e) => {
              e.stopPropagation()
              if (onVersioningOverride) onVersioningOverride(item)
              else setVersioning({ item, tab: 'git' })
            }}>
              <GitBranch size={14} />
              {t('common.versioning')}
            </DropdownMenuItem>
          )}
          {docs && (
            <>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setDocsOpen({ item, tab: 'readme' }) }}>
                <BookOpen size={14} />
                {t('summary.tab_readme')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setDocsOpen({ item, tab: 'license' }) }}>
                <Scale size={14} />
                {t('license.title')}
              </DropdownMenuItem>
            </>
          )}
          {extraItems}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!canDelete}
            onClick={(e) => { e.stopPropagation(); setToDelete(item) }}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 size={14} className="text-destructive" />
            {t('common.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Dialogs are portaled to <body>, but React events still bubble through the
          component tree — so a click inside a dialog would otherwise reach the
          enclosing card's onClick (opening the entity). Stop it here. */}
      <div className="contents" onClick={(e) => e.stopPropagation()}>
        {/* Edit dialog */}
        {toEdit && renderEditDialog({
          item: toEdit,
          onOpenChange: (open) => { if (!open) setToEdit(null) },
        })}

        {/* Versioning dialog (export + git link, or git-only when export lives elsewhere) */}
        {versioning && getGitRemote && onSaveGitRemote && (
          <EntityVersioningDialog
            open
            onOpenChange={(open) => { if (!open) setVersioning(null) }}
            initialTab={versioning.tab}
            gitOnly={gitOnly}
            syncScope={syncScope}
            syncId={syncScope ? versioning.item.id : undefined}
            // Chosen from the scope rather than passed in by each caller: the pull
            // flow is a property of the entity kind, and an ETL pipeline is reached
            // from both the list page and the header menu.
            renderInlinePull={
              syncScope === 'etl-pipelines'
                ? ({ branch, remoteHead, mode, onPulled }) => (
                  <EtlPipelinePull
                    pipelineId={versioning.item.id}
                    branch={branch}
                    remoteHead={remoteHead}
                    mode={mode}
                    onPulled={onPulled}
                  />
                )
                : syncScope === 'schema-presets'
                  ? ({ branch, remoteHead, mode, onPulled }) => (
                    <SchemaPresetPull
                      presetId={versioning.item.id}
                      branch={branch}
                      remoteHead={remoteHead}
                      mode={mode}
                      onPulled={onPulled}
                    />
                  )
                  : undefined}
            onAfterPull={
              syncScope === 'etl-pipelines'
                ? async () => {
                  // The pull wrote to storage; the ETL views read from the store.
                  await useEtlStore.getState().loadEtlPipelines()
                  await useEtlStore.getState().loadPipelineFiles(versioning.item.id)
                }
                : syncScope === 'schema-presets'
                  ? async () => {
                    // Same reason: the preset list reads from its own store.
                    // Reloaded in the SAME scope the page uses (per workspace) —
                    // an unscoped reload would swap the list for every workspace's
                    // presets.
                    const ws = (versioning.item as { workspaceId?: string }).workspaceId
                    await useSchemaPresetStore.getState().loadPresets(ws)
                  }
                  : undefined}
            supportsIncludeData={exportSupportsIncludeData}
            gitRemote={getGitRemote(versioning.item)}
            onExport={onExport ? () => onExport(versioning.item) : undefined}
            onSaveGitRemote={async (config) => {
              await onSaveGitRemote(versioning.item, config)
            }}
          />
        )}

        {/* Readme + license */}
        {docsOpen && docs && (
          <EntityDocsDialog
            open
            onOpenChange={(open) => { if (!open) setDocsOpen(null) }}
            initialTab={docsOpen.tab}
            entityName={localized(docsOpen.item.name, language)}
            readme={docs.getReadme(docsOpen.item)}
            onSaveReadme={(readme) => docs.onSaveReadme(docsOpen.item, readme)}
            license={docs.getLicense(docsOpen.item)}
            onSaveLicense={(license) => docs.onSaveLicense(docsOpen.item, license)}
            canEdit={canEdit}
            attachmentOwner={docs.attachmentOwnerType ? {
              type: docs.attachmentOwnerType,
              id: docs.getOwnerId?.(docsOpen.item) ?? docsOpen.item.id,
              workspaceId: docs.getWorkspaceId?.(docsOpen.item),
            } : undefined}
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
      </div>
    </>
  )
}
