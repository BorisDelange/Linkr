import { useTranslation } from 'react-i18next'
import { GitBranch, Info } from 'lucide-react'

export function WsLocalHistoryTab() {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center py-12">
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
  )
}
