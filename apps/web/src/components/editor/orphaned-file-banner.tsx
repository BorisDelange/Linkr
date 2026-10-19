import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { NoticeBanner } from '@/components/ui/notice-banner'

/** Over the editor of a file with an unsaved edit that was deleted elsewhere
 *  (an agent over MCP): the user's text is still here, nothing else is. */
export function OrphanedFileBanner({ onRecreate, onDiscard }: { onRecreate: () => void; onDiscard: () => void }) {
  const { t } = useTranslation()
  return (
    <NoticeBanner
      tone="warning"
      className="m-2"
      title={t('files.orphaned_title')}
      description={t('files.orphaned_description')}
      action={(
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onRecreate} className="text-xs">
            {t('files.orphaned_recreate')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDiscard} className="text-xs">
            {t('files.orphaned_discard')}
          </Button>
        </div>
      )}
    />
  )
}
