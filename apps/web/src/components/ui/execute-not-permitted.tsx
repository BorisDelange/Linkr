import { Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Placeholder shown in place of a code-backed widget/analysis when the current
 * user lacks the resource's `:execute` permission. Rendering it runs R/Python
 * server-side, which a read-only viewer isn't allowed to trigger — so we show
 * this instead of firing a request that can only 403.
 */
export function ExecuteNotPermitted({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className={`flex h-full flex-col items-center justify-center gap-1.5 text-center text-muted-foreground ${compact ? 'p-2' : 'p-4'}`}>
      <Lock size={compact ? 14 : 18} className="opacity-60" />
      <p className="text-xs">{t('common.execute_not_permitted')}</p>
    </div>
  )
}
