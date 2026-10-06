/**
 * What an analysis shows while its result is on the way — the one loading state
 * every analysis plugin uses, so a dashboard reads the same whichever is slow.
 *
 * The plugin's own icon, its name, and three dots in a wave, all in the muted
 * colour. The icon alone is indistinguishable from an empty state, and small
 * pulsing "…" went unnoticed: a slow server fit read as "nothing to display"
 * rather than "still working".
 */
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { getAllPlugins } from '@/lib/plugins/registry'
import { localized } from '@/lib/localized'
import type { LucideIcon } from 'lucide-react'

/**
 * A component plugin's display name, resolved from the registry.
 *
 * Looked up by COMPONENT id rather than passed in, so a renamed plugin (the
 * name lives in its manifest) needs no change here — and so a component does
 * not have to know its own manifest id.
 */
export function usePluginName(componentId: string): string | undefined {
  const { i18n } = useTranslation()
  const plugin = getAllPlugins().find((p) => p.componentId === componentId)
  return plugin ? localized(plugin.manifest.name, i18n.language) : undefined
}

export function AnalysisLoading({
  icon: Icon,
  name,
  compact,
  className,
}: {
  icon: LucideIcon
  /** The plugin's name, already localized. */
  name?: string
  compact?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      aria-label={t('common.loading')}
      className={cn(
        'flex h-full min-h-0 flex-col items-center justify-center text-center text-muted-foreground',
        compact ? 'gap-2 p-3' : 'gap-2.5 p-8',
        className,
      )}
    >
      <Icon size={compact ? 40 : 48} strokeWidth={1.5} className="opacity-60" />
      {name && <p className="text-xs opacity-80">{name}</p>}
      <div className={cn('flex items-center', compact ? 'gap-1.5' : 'gap-2')} aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn('animate-loading-dot rounded-full bg-current motion-reduce:animate-none', compact ? 'size-[6.5px]' : 'size-2')}
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </div>
    </div>
  )
}
