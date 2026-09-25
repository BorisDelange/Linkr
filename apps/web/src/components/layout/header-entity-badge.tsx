import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface HeaderEntityBadgeProps extends Omit<ComponentProps<'span'>, 'children'> {
  icon: LucideIcon
  label: string
}

/** The header's name chip for the entity being edited: opens its actions menu.
 *  Spreads its props onto the badge, so it can be a menu's `asChild` trigger. */
export function HeaderEntityBadge({ icon: Icon, label, className, ...props }: HeaderEntityBadgeProps) {
  const { t } = useTranslation()
  return (
    <Badge
      variant="outline"
      className={cn(
        'cursor-pointer translate-y-px gap-1 py-0 text-xs text-foreground/80 border-border bg-muted transition-colors hover:bg-foreground/10',
        className,
      )}
      aria-label={t('common.actions')}
      {...props}
    >
      <Icon size={10} className="text-muted-foreground" />
      {label}
      <MoreHorizontal size={12} className="text-muted-foreground" />
    </Badge>
  )
}
