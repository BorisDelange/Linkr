import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ReadmeEditor } from '@/components/editor/ReadmeEditor'
import { LicenseEditor } from '@/components/editor/LicenseEditor'
import { AttachmentsDialog } from '@/components/editor/AttachmentsDialog'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import type { EntityLicense, LocalizedString, ReadmeOwnerType } from '@/types'

/** Owner of the README image attachments. */
export interface AttachmentOwner {
  type: ReadmeOwnerType
  id: string
  workspaceId?: string
}

export interface EntityReadmePanelProps {
  readme: LocalizedString | string | undefined
  onSave: (readme: LocalizedString) => void | Promise<void>
  canEdit?: boolean
  attachmentOwner?: AttachmentOwner
  /** Hidden when a tab already names the panel. */
  showTitle?: boolean
  className?: string
}

/**
 * One entity's README, with its image attachments — the editor body only, no
 * dialog around it.
 *
 * Pass-through by design: it reads `readme` on every render rather than
 * snapshotting it on open, because a detail page feeds it live from the store.
 * `EntityDocsDialog` keeps the opposite behaviour for menu items, which capture
 * the entity they were rendered with and would otherwise show pre-save content.
 */
export function EntityReadmePanel({
  readme,
  onSave,
  canEdit = true,
  attachmentOwner,
  showTitle = true,
  className = 'flex h-full flex-col pt-2 pb-1.5',
}: EntityReadmePanelProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)

  const { attachments, uploadAttachment, deleteAttachment, resolveAttachmentUrls } =
    useReadmeAttachments(
      attachmentOwner?.type ?? 'workspace',
      attachmentOwner?.id ?? '',
      attachmentOwner?.workspaceId,
    )

  return (
    <>
      <ReadmeEditor
        className={className}
        readme={localized(readme, language)}
        // Writes only the active language, leaving the others the entity carries.
        onSave={(content) => { void onSave(setLocalized(readme, language, content)) }}
        resolveUrls={attachmentOwner ? resolveAttachmentUrls : undefined}
        canEdit={canEdit}
        showTitle={showTitle}
        headerActions={attachmentOwner ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-2 text-xs text-muted-foreground"
            disabled={!canEdit}
            onClick={() => setAttachmentsOpen(true)}
          >
            <Paperclip size={12} />
            {t('summary.attachments')}
          </Button>
        ) : undefined}
      />

      {attachmentOwner && (
        <AttachmentsDialog
          open={attachmentsOpen}
          onOpenChange={setAttachmentsOpen}
          attachments={attachments}
          onUpload={async (file) => { await uploadAttachment(file) }}
          onDelete={async (id) => { await deleteAttachment(id) }}
        />
      )}
    </>
  )
}

export interface EntityLicensePanelProps {
  license: EntityLicense | null | undefined
  onSave: (license: EntityLicense | null) => void | Promise<void>
  canEdit?: boolean
  /** Pre-fills the copyright line of templates that carry one (MIT, BSD…). */
  copyrightHolder?: string
  /** Hidden when a tab already names the panel. */
  showTitle?: boolean
  className?: string
}

/** One entity's licence — the editor body only, no dialog around it. */
export function EntityLicensePanel({
  license,
  onSave,
  canEdit = true,
  copyrightHolder,
  showTitle = true,
  className = 'flex h-full flex-col pt-2 pb-1.5',
}: EntityLicensePanelProps) {
  return (
    <LicenseEditor
      className={className}
      license={license}
      onSave={onSave}
      copyrightHolder={copyrightHolder}
      canEdit={canEdit}
      showTitle={showTitle}
    />
  )
}
