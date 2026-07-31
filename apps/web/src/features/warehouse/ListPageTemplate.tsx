import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Upload, type LucideIcon } from 'lucide-react'
import { ImportSourceDialog, type ImportGitRemote } from '@/components/ui/import-source-dialog'
import { EntityActionsMenu } from '@/components/ui/entity-actions-menu'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { shortenIdAmong } from '@/lib/short-id'
import { GitContentStatusBadge } from '@/components/versioning/GitContentStatusBadge'
import { useGitContentStatuses } from '@/components/versioning/use-git-content-statuses'
import { linkedTypeForScope, type GitScope } from '@/lib/api/git'
import type { GitLinkedEntity } from '@/lib/entity-io'
import type { GitRemoteConfig, LocalizedString, OrganizationInfo } from '@/types'
import type { AuthorDetails } from '@/types/author'
import { Button } from '@/components/ui/button'
import { GatedButton } from '@/components/ui/gated-button'
import { Card } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListPageTemplateProps<T extends { id: string; name: LocalizedString | string; createdAt?: string; updatedAt?: string; createdById?: number; createdBy?: string; createdByDetails?: AuthorDetails; organization?: OrganizationInfo }> {
  /** Page title i18n key */
  titleKey: string
  /** Page description i18n key */
  descriptionKey: string
  /** Create button label i18n key */
  newButtonKey: string
  /** Empty state i18n key */
  emptyTitleKey: string
  /** Empty state description i18n key */
  emptyDescriptionKey: string
  /** Delete confirm title i18n key */
  deleteConfirmTitleKey: string
  /** Delete confirm description i18n key (receives `{ name }`) */
  deleteConfirmDescriptionKey: string

  /** Icon for the empty state */
  emptyIcon: LucideIcon

  /** Items to display */
  items: T[]
  /** Navigate to item detail */
  onNavigate: (id: string) => void
  /** Delete an item */
  onDelete: (id: string) => Promise<void>

  /** Export a single item as ZIP. When provided, the Export menu item is enabled. */
  onExport?: (item: T) => void
  /** When set, the Export menu item calls this instead (e.g. navigate to the item's own export view). */
  onExportOverride?: (item: T) => void
  /** When set, the Versioning menu item calls this instead of opening the dialog (e.g. navigate to a Versioning tab). */
  onVersioningOverride?: (item: T) => void
  /** Read the item's git link (null when unlinked). When provided alongside onSaveGitRemote, the Versioning menu item is enabled. */
  getGitRemote?: (item: T) => GitRemoteConfig | null
  /** Persist (or clear) the item's git link. Required to enable the Versioning menu item. */
  onSaveGitRemote?: (item: T, config: GitRemoteConfig | null) => Promise<void>
  /** Whether the export of this entity supports an "include data" toggle. Default true. */
  exportSupportsIncludeData?: boolean
  /** When set, the versioning dialog's Git tab shows the push-only sync panel for
   *  this scope (server mode), using each item's id as the sync id. */
  syncScope?: GitScope
  /** Import from a file. When provided, the Import header button is enabled.
   *  `gitRemote` is set when the source was cloned from git, so the caller can
   *  pre-link the entity's Versioning page to that repo (url/branch/token). */
  onImport?: (file: File, gitRemote?: ImportGitRemote) => void
  /** File accept filter for import (default: ".zip") */
  importAccept?: string

  /** Render the card body for each item. Receives the actions menu (⋯) to place
   *  on the title row so it aligns with the title (see the reference cards). */
  renderCardBody: (item: T, actionsMenu: ReactNode) => ReactNode

  /** Render the create dialog */
  renderCreateDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }) => ReactNode
  /** Render the edit dialog */
  renderEditDialog: (props: { item: T; onOpenChange: (open: boolean) => void }) => ReactNode
  /** Optional extra actions rendered before the Import/New buttons in the header */
  headerActions?: ReactNode
  /** Optional toolbar (search + filters) rendered on its own row below the title */
  toolbar?: ReactNode
  /** Optional back button/element rendered on the left of the header row */
  backAction?: ReactNode
  /** When false, create/import/edit controls are disabled (viewer). Default true. */
  canEdit?: boolean
  /** When false, the delete action is disabled (non-owner). Default true. */
  canDelete?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ListPageTemplate<T extends { id: string; name: LocalizedString | string; createdAt?: string; updatedAt?: string; createdById?: number; createdBy?: string; createdByDetails?: AuthorDetails; organization?: OrganizationInfo }>({
  titleKey,
  descriptionKey,
  newButtonKey,
  emptyTitleKey,
  emptyDescriptionKey,
  deleteConfirmTitleKey,
  deleteConfirmDescriptionKey,
  emptyIcon: EmptyIcon,
  items,
  onNavigate,
  onDelete,
  onExport,
  onExportOverride,
  onVersioningOverride,
  getGitRemote,
  onSaveGitRemote,
  exportSupportsIncludeData = true,
  syncScope,
  onImport,
  importAccept = '.zip',
  renderCardBody,
  renderCreateDialog,
  renderEditDialog,
  headerActions,
  toolbar,
  backAction,
  canEdit = true,
  canDelete = true,
}: ListPageTemplateProps<T>) {
  const { t } = useTranslation()

  // These warehouse entities inherit their org from the workspace (no org field of
  // their own): a locally-created item has no frozen `organization` snapshot, so the
  // footer resolves the workspace's org live by id — mirroring plugins. An imported
  // item keeps its own `organization` snapshot, which takes precedence over this.
  const workspaceOrgId = useWorkspaceStore((s) =>
    s._workspacesRaw.find((w) => w.id === s.activeWorkspaceId)?.organizationId,
  )
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  // Git-linked entities whose content wasn't reconstituted → card badge + retry.
  const { statuses: contentStatuses, refetch: refetchContentStatuses } = useGitContentStatuses(activeWorkspaceId)
  const linkedType = syncScope ? linkedTypeForScope[syncScope] : undefined

  const [dialogOpen, setDialogOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        {/* Header */}
        <div>
          {backAction && <div className="mb-1">{backAction}</div>}
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-foreground">{t(titleKey)}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t(descriptionKey)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
            {headerActions}
            {onImport ? (
              <GatedButton
                allowed={canEdit}
                notAllowedReason={t('common.insufficient_permissions')}
                variant="outline"
                size="sm"
                className="gap-1 text-xs"
                onClick={() => setImportOpen(true)}
              >
                <Upload size={14} />
                {t('common.import')}
              </GatedButton>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button variant="outline" size="sm" disabled className="gap-1 text-xs">
                      <Upload size={14} />
                      {t('common.import')}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t('common.coming_soon')}</TooltipContent>
              </Tooltip>
            )}
            <GatedButton
              allowed={canEdit}
              notAllowedReason={t('common.insufficient_permissions')}
              size="sm"
              onClick={() => setDialogOpen(true)}
              className="gap-1 text-xs"
            >
              <Plus size={14} />
              {t(newButtonKey)}
            </GatedButton>
            </div>
          </div>
          {toolbar}
        </div>

        {/* Empty state / Item grid */}
        {items.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <EmptyIcon size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">{t(emptyTitleKey)}</p>
              <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                {t(emptyDescriptionKey)}
              </p>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {items.map((item) => (
              <Card
                key={item.id}
                className="flex min-h-44 min-w-0 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent"
                onClick={() => onNavigate(shortenIdAmong(item.id, items.map((i) => i.id)))}
              >
                <div className="flex flex-1 flex-col px-4 pt-5">
                  <div className="flex flex-1 items-center gap-4">
                    {renderCardBody(
                      item,
                      <EntityActionsMenu
                        item={item}
                        onDelete={onDelete}
                        onExport={onExport}
                        onExportOverride={onExportOverride}
                        onVersioningOverride={onVersioningOverride}
                        getGitRemote={getGitRemote}
                        onSaveGitRemote={onSaveGitRemote}
                        exportSupportsIncludeData={exportSupportsIncludeData}
                        syncScope={syncScope}
                        renderEditDialog={renderEditDialog}
                        deleteConfirmTitleKey={deleteConfirmTitleKey}
                        deleteConfirmDescriptionKey={deleteConfirmDescriptionKey}
                        canEdit={canEdit}
                        canDelete={canDelete}
                      />,
                    )}
                  </div>
                  {activeWorkspaceId && syncScope && linkedType && getGitRemote?.(item) && contentStatuses.get(`${syncScope}:${item.id}`) && (
                    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                      <GitContentStatusBadge
                        workspaceId={activeWorkspaceId}
                        scope={syncScope}
                        type={linkedType as GitLinkedEntity['type']}
                        id={item.id}
                        name={typeof item.name === 'string' ? item.name : (item.name?.en ?? item.id)}
                        gitRemote={getGitRemote(item)}
                        status={contentStatuses.get(`${syncScope}:${item.id}`)}
                        onResolved={refetchContentStatuses}
                      />
                    </div>
                  )}
                  <CardMetaFooter
                    className="mt-auto"
                    createdById={item.createdById}
                    createdBy={item.createdBy}
                    createdByDetails={item.createdByDetails}
                    organizationId={item.organization ? undefined : workspaceOrgId}
                    organization={item.organization}
                    createdAt={item.createdAt}
                    updatedAt={item.updatedAt}
                  />
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create dialog */}
      {renderCreateDialog({
        open: dialogOpen,
        onOpenChange: setDialogOpen,
        onCreated: (id) => { setDialogOpen(false); onNavigate(shortenIdAmong(id, [...items.map((i) => i.id), id])) },
      })}

      {/* Import dialog (ZIP upload or git clone) */}
      {onImport && (
        <ImportSourceDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          accept={importAccept}
          onImport={onImport}
        />
      )}
    </div>
  )
}
