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
    <div className="flex flex-col items-center py-12">
      <Lock size={32} className="text-muted-foreground/50" />
      <p className="mt-3 text-sm font-medium text-foreground">
        {t('common.no_access_title')}
      </p>
      <p className="mt-1 max-w-md text-center text-xs text-muted-foreground">
        {description ?? t('common.no_access_description')}
      </p>
    </div>
  )
}
