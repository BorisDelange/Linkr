/**
 * What an analysis shows while its result is on the way.
 *
 * Three lines, all in the same muted colour: the plugin's own icon, its name,
 * and animated dots. The icon alone — which is what these panels used to show —
 * is indistinguishable from an empty state, so a slow server fit read as
 * "nothing to display" rather than "still working".
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
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-1 p-8 text-center text-muted-foreground',
        className,
      )}
    >
      <Icon size={compact ? 20 : 24} className="opacity-40" />
      {name && <p className={cn('opacity-70', compact ? 'text-[10px]' : 'text-xs')}>{name}</p>}
      {/* The dots animate, so the panel is visibly working rather than merely
          quiet. Rendered as three staggered spans instead of an ellipsis
          character, which cannot animate. */}
      <p
        className={cn('flex gap-0.5 opacity-70', compact ? 'text-[10px]' : 'text-xs')}
        aria-hidden
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="animate-pulse"
            style={{ animationDelay: `${i * 200}ms`, animationDuration: '1.2s' }}
          >
            .
          </span>
        ))}
      </p>
    </div>
  )
}
