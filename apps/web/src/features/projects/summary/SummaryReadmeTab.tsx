import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/stores/app-store'
import { localized } from '@/lib/localized'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { AttachmentsDialog } from '@/components/editor/AttachmentsDialog'
import { ReadmeEditor } from '@/components/editor/ReadmeEditor'


interface SummaryReadmeTabProps {
  uid: string
}

export function SummaryReadmeTab({ uid }: SummaryReadmeTabProps) {
  const { t } = useTranslation()
  const canWrite = useMyProjectRole(uid).can('project-summary:write')
  const { _projectsRaw, updateProjectReadme, language } = useAppStore()
  const project = _projectsRaw.find((p) => p.uid === uid)
  const readme = localized(project?.readme, language)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)

  const {
    attachments,
    uploadAttachment,
    deleteAttachment,
    resolveAttachmentUrls,
  } = useReadmeAttachments('project', uid, project?.workspaceId)

  return (
    <>
      <ReadmeEditor
        className="flex h-full flex-col pt-4 pb-1.5"
        readme={readme}
        onSave={(content) => updateProjectReadme(uid, content)}
        resolveUrls={resolveAttachmentUrls}
        canEdit={canWrite}
        headerActions={
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-2 text-xs text-muted-foreground"
            disabled={!canWrite}
            onClick={() => setAttachmentsOpen(true)}
          >
            <Paperclip size={12} />
            {t('summary.attachments')}
          </Button>
        }
      />
      <AttachmentsDialog
        open={attachmentsOpen}
        onOpenChange={setAttachmentsOpen}
        attachments={attachments}
        onUpload={async (file) => { await uploadAttachment(file) }}
        onDelete={async (id) => { await deleteAttachment(id) }}
      />
    </>
  )
}
