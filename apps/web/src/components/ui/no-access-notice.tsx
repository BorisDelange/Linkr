import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'

interface NoAccessNoticeProps {
  /** Optional override for the explanatory line (defaults to the generic message). */
  description?: string
}

/**
 * Shown in place of a protected section when the current account lacks the
 * required permission. The section/tab stays visible (so users see the feature
 * exists) but its contents are replaced by this notice. Purely cosmetic — the
 * real enforcement is server-side; this never grants access on its own.
 */
export function NoAccessNotice({ description }: NoAccessNoticeProps) {
  const { t } = useTranslation()
  return (
    <div className="flex justify-center py-10">
      <div className="flex max-w-md items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800/70 dark:bg-amber-950/40">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50">
          <Lock size={16} className="text-amber-600 dark:text-amber-400" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {t('common.no_access_title')}
          </p>
          <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300/90">
            {description ?? t('common.no_access_description')}
          </p>
        </div>
      </div>
    </div>
  )
}
