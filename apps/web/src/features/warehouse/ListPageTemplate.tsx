import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Upload, type LucideIcon } from 'lucide-react'
import { ImportSourceDialog, type ImportGitRemote } from '@/components/ui/import-source-dialog'
import { EntityActionsMenu, type EntityDocsAccessors } from '@/components/ui/entity-actions-menu'
import { BulkDeleteAction } from '@/components/ui/bulk-delete-action'
import { useCardSelection, selectedCardClass } from '@/components/ui/use-card-selection'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { EntityDocsDialog, type DocsTab } from '@/components/ui/entity-docs-dialog'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { shortenIdAmong } from '@/lib/short-id'
import { useContentBadge } from '@/components/versioning/use-content-badge'
import { linkedTypeForScope, type GitScope } from '@/lib/api/git'
import type { GitLinkedEntity } from '@/lib/entity-io'
import type { GitRemoteConfig, LocalizedString, OrganizationInfo } from '@/types'
import type { AuthorDetails } from '@/types/author'
import { Button } from '@/components/ui/button'
import { GatedButton } from '@/components/ui/gated-button'
import { Card } from '@/components/ui/card'
import { PageContainer, PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
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
  /** Adds Duplicate to the card menu. */
  onDuplicate?: (item: T) => void | Promise<void>

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
  /** When set, each card's menu gets Readme and License items. */
  docs?: EntityDocsAccessors<T>
  /** When set, Readme/License open the entity's own tab instead of the dialog —
   *  for entities whose detail page owns those as tabs. */
  onOpenDocs?: (item: T, tab: DocsTab) => void
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
  onDuplicate,
  onExport,
  onExportOverride,
  onVersioningOverride,
  getGitRemote,
  onSaveGitRemote,
  exportSupportsIncludeData = true,
  syncScope,
  docs,
  onOpenDocs,
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
  const { t, i18n } = useTranslation()

  // These warehouse entities inherit their org from the workspace (no org field of
  // their own): a locally-created item has no frozen `organization` snapshot, so the
  // footer resolves the workspace's org live by id — mirroring plugins. An imported
  // item keeps its own `organization` snapshot, which takes precedence over this.
  const workspaceOrgId = useWorkspaceStore((s) =>
    s._workspacesRaw.find((w) => w.id === s.activeWorkspaceId)?.organizationId,
  )
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  // Git-linked entities whose content wasn't reconstituted → card badge + retry.
  const { badgeFor, repoUrlFor: repoUrlForId } = useContentBadge(syncScope, activeWorkspaceId)
  const linkedType = syncScope ? linkedTypeForScope[syncScope] : undefined

  /** Where a card with missing content sends the user instead of navigating: in
   *  client-only there is nothing behind it, so the whole card opens the repo. */
  const repoUrlFor = (item: T): string | null =>
    repoUrlForId(item.id, getGitRemote?.(item)?.url)

  /** The "content not imported" badge for a card, or null when it doesn't apply.
   *  Rendered in the footer's trailing slot, pinned right of the meta chips. */
  const contentBadge = (item: T): React.ReactNode => {
    if (!linkedType) return null
    return badgeFor({
      type: linkedType as GitLinkedEntity['type'],
      id: item.id,
      name: typeof item.name === 'string' ? item.name : (item.name?.en ?? item.id),
      gitRemote: getGitRemote?.(item),
    })
  }

  const [dialogOpen, setDialogOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const selection = useCardSelection(items.map((i) => i.id))
  // The footer's license chip opens the docs dialog straight on its License tab —
  // the same dialog the card's "..." menu opens.
  const [licenseTarget, setLicenseTarget] = useState<T | null>(null)

  return (
    <PageContainer>
        <PageHeader
          title={t(titleKey)}
          description={t(descriptionKey)}
          above={backAction}
          actions={selection.active ? (
            <BulkDeleteAction
              selection={selection}
              canDelete={canDelete}
              names={(id) => localized(items.find((i) => i.id === id)?.name, i18n.language)}
              onDeleteMany={async (ids) => { for (const id of ids) await onDelete(id) }}
            />
          ) : <>
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
          </>}
        />
        {toolbar}

        {/* Empty state / Item grid */}
        {items.length === 0 ? (
          <Card className="mt-6">
            <EmptyState
              icon={EmptyIcon}
              title={t(emptyTitleKey)}
              description={t(emptyDescriptionKey)}
            />
          </Card>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {items.map((item) => (
              <Card
                key={item.id}
                className={cn(
                  'flex min-h-44 min-w-0 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent',
                  selection.isSelected(item.id) && selectedCardClass,
                )}
                onClick={(e) => {
                  if (selection.onCardClick(e, item.id)) return
                  // Content missing and no way to fetch it: the entity page would
                  // be empty, so send the user to the repo that holds it.
                  const repo = repoUrlFor(item)
                  if (repo) { window.open(repo, '_blank', 'noopener,noreferrer'); return }
                  onNavigate(shortenIdAmong(item.id, items.map((i) => i.id)))
                }}
              >
                <div className="flex flex-1 flex-col px-4 pt-5">
                  <div className="flex flex-1 items-center gap-4">
                    {renderCardBody(
                      item,
                      <EntityActionsMenu
                        item={item}
                        onDelete={onDelete}
                        onDuplicate={onDuplicate}
                        onExport={onExport}
                        onExportOverride={onExportOverride}
                        onVersioningOverride={onVersioningOverride}
                        getGitRemote={getGitRemote}
                        onSaveGitRemote={onSaveGitRemote}
                        exportSupportsIncludeData={exportSupportsIncludeData}
                        syncScope={syncScope}
                        docs={docs}
                        onOpenDocs={onOpenDocs}
                        renderEditDialog={renderEditDialog}
                        deleteConfirmTitleKey={deleteConfirmTitleKey}
                        deleteConfirmDescriptionKey={deleteConfirmDescriptionKey}
                        canEdit={canEdit}
                        canDelete={canDelete}
                        // Nothing was imported behind this card: editing,
                        // exporting or duplicating an empty shell does nothing
                        // useful. Only removing it still means something.
                        deleteOnly={!!contentBadge(item)}
                      />,
                    )}
                  </div>
                  <CardMetaFooter
                    className="mt-auto"
                    createdById={item.createdById}
                    createdBy={item.createdBy}
                    createdByDetails={item.createdByDetails}
                    organizationId={item.organization ? undefined : workspaceOrgId}
                    organization={item.organization}
                    createdAt={item.createdAt}
                    updatedAt={item.updatedAt}
                    // With the badge, the row is the author and the badge only:
                    // the licence of an entity whose content is missing is fine
                    // print about something that isn't there yet.
                    compact={!!contentBadge(item)}
                    license={docs ? docs.getLicense(item) : undefined}
                    onOpenLicense={
                      onOpenDocs
                        ? () => onOpenDocs(item, 'license')
                        : docs ? () => setLicenseTarget(item) : undefined
                    }
                    trailing={contentBadge(item)}
                  />
                </div>
              </Card>
            ))}
          </div>
        )}

      {/* Create dialog */}
      {renderCreateDialog({
        open: dialogOpen,
        onOpenChange: setDialogOpen,
        onCreated: (id) => { setDialogOpen(false); onNavigate(shortenIdAmong(id, [...items.map((i) => i.id), id])) },
      })}

      {/* Import dialog (ZIP upload or git clone) */}
      {docs && licenseTarget && (
        <EntityDocsDialog
          open
          onOpenChange={(open) => { if (!open) setLicenseTarget(null) }}
          initialTab="license"
          entityName={localized(licenseTarget.name, i18n.language)}
          readme={docs.getReadme(licenseTarget)}
          onSaveReadme={(readme) => docs.onSaveReadme(licenseTarget, readme)}
          license={docs.getLicense(licenseTarget)}
          onSaveLicense={(license) => docs.onSaveLicense(licenseTarget, license)}
          canEdit={canEdit}
          attachmentOwner={docs.attachmentOwnerType ? {
            type: docs.attachmentOwnerType,
            id: docs.getOwnerId?.(licenseTarget) ?? licenseTarget.id,
            workspaceId: docs.getWorkspaceId?.(licenseTarget),
          } : undefined}
        />
      )}

      {onImport && (
        <ImportSourceDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          accept={importAccept}
          onImport={onImport}
          // Same scope the page already declares for git sync: it also names the
          // catalog type whose entries this page can install.
          scope={syncScope}
        />
      )}
    </PageContainer>
  )
}
