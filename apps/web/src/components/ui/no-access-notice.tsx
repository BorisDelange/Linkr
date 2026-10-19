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
      <div className="flex max-w-md items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning/15">
          <Lock size={16} className="text-warning-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-warning-foreground">
            {t('common.no_access_title')}
          </p>
          <p className="text-xs leading-relaxed text-warning-foreground">
            {description ?? t('common.no_access_description')}
          </p>
        </div>
      </div>
    </div>
  )
}
