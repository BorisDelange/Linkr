import { useTranslation } from 'react-i18next'
import { ServerCog } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ServerModeNoticeProps {
  /** Override the title line (defaults to the generic client-only message). */
  title?: string
  /** Override the explanatory line. */
  description?: string
  /** Compact variant (just the amber block, no centering/padding) for use inside
   *  a modal tab. Default is the centered full-section variant. */
  inline?: boolean
  className?: string
}

/**
 * Single source of truth for the "not available in client-only mode" notice: an
 * amber block shown where a server-only feature (members, git sync, versioning)
 * would render in the WASM/front-only build. Mirrors NoAccessNotice's styling so
 * the two read as one system. Purely informational — the feature is simply absent
 * without the backend.
 */
export function ServerModeNotice({ title, description, inline, className }: ServerModeNoticeProps) {
  const { t } = useTranslation()
  const block = (
    <div className={cn(
      'flex max-w-md items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800/70 dark:bg-amber-950/40',
      className,
    )}>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50">
        <ServerCog size={16} className="text-amber-600 dark:text-amber-400" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          {title ?? t('common.requires_server_title')}
        </p>
        <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300/90">
          {description ?? t('common.requires_server_description')}
        </p>
      </div>
    </div>
  )
  if (inline) return block
  return <div className="flex justify-center py-10">{block}</div>
}
