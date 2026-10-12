import { Badge } from '@/components/ui/badge'
import { getBadgeClasses, getBadgeStyle } from '@/lib/badge-colors'
import { getLucideIcon } from '@/lib/plugins/shared-styles'
import { cn } from '@/lib/utils'
import type { Plugin } from '@/types/plugin'

/** A plugin's name in its manifest colour, with its icon (widget editor headers). */
export function PluginNameBadge({ plugin, lang }: { plugin: Plugin; lang: string }) {
  const { iconColor: color, icon, name, id } = plugin.manifest
  const Icon = getLucideIcon(icon)
  const label = name?.[lang as 'en' | 'fr'] ?? name?.en ?? id
  return (
    <Badge
      variant="outline"
      className={cn('shrink-0 gap-1 py-0', color ? getBadgeClasses(color) : undefined)}
      style={color ? getBadgeStyle(color) : undefined}
    >
      {/* eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data */}
      <Icon size={10} />
      {label}
    </Badge>
  )
}
