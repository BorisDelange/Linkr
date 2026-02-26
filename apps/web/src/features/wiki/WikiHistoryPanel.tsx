import { useTranslation } from 'react-i18next'
import { ArrowLeft, GitBranch, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WikiPage } from '@/types'

interface WikiHistoryPanelProps {
  page: WikiPage
  workspaceId: string
  resolveAttachmentUrls: (md: string) => string
  onRestore: (snapshotId: string) => void
  onClose: () => void
}

export function WikiHistoryPanel({ onClose }: WikiHistoryPanelProps) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-muted-foreground" onClick={onClose}>
          <ArrowLeft size={12} /> {t('wiki.back_to_page')}
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center">
        <GitBranch size={36} className="text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium text-foreground">
          {t('versioning.requires_backend')}
        </p>
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950 max-w-md">
          <Info size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {t('versioning.requires_backend_description')}
          </p>
        </div>
      </div>
    </div>
  )
}
