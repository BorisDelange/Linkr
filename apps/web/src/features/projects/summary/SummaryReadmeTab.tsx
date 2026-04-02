import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Paperclip, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/stores/app-store'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { ReadmeAttachmentsDialog } from './ReadmeAttachmentsDialog'
import { ReadmeEditor } from '@/components/editor/ReadmeEditor'

// Re-export for backwards compatibility (used by other files)
export { remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'

interface SummaryReadmeTabProps {
  uid: string
}

export function SummaryReadmeTab({ uid }: SummaryReadmeTabProps) {
  const { t } = useTranslation()
  const { _projectsRaw, updateProjectReadme } = useAppStore()
  const project = _projectsRaw.find((p) => p.uid === uid)
  const readme = project?.readme ?? ''
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)

  const {
    attachments,
    uploadAttachment,
    deleteAttachment,
    resolveAttachmentUrls,
  } = useReadmeAttachments(uid)

  return (
    <>
      <ReadmeEditor
        readme={readme}
        onSave={(content) => updateProjectReadme(uid, content)}
        resolveUrls={resolveAttachmentUrls}
        headerActions={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-2 text-xs text-muted-foreground"
              onClick={() => setAttachmentsOpen(true)}
            >
              <Paperclip size={12} />
              {t('summary.attachments')}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled
                    className="h-5 px-2 text-xs text-muted-foreground"
                  >
                    <History size={12} />
                    {t('summary.history')}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('common.server_only')}</TooltipContent>
            </Tooltip>
          </>
        }
      />
      <ReadmeAttachmentsDialog
        open={attachmentsOpen}
        onOpenChange={setAttachmentsOpen}
        attachments={attachments}
        onUpload={async (file) => { await uploadAttachment(file) }}
        onDelete={async (id) => { await deleteAttachment(id) }}
      />
    </>
  )
}
