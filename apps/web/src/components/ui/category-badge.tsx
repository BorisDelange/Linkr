import { getBadgeClasses, getBadgeStyle, isCustomColor } from '@/lib/badge-colors'
import { cn } from '@/lib/utils'
import type { BadgeColor } from '@/types'

interface CategoryBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Text before the separator, e.g. "Source". Rendered darker. */
  category: string
  /** Text after it, e.g. "MIMIC". */
  value: string
  color: BadgeColor
}

/**
 * A two-tone chip for a scoped badge: the category half is darker than the
 * value half, so `Source::MIMIC` reads as one badge that says which axis it is
 * on — the same visual grammar GitLab uses for scoped labels.
 *
 * The separator itself is not drawn: the tone change already marks the boundary,
 * and printing `::` inside a chip that is already split reads as a typo.
 */
export function CategoryBadge({ category, value, color, className, ...rest }: CategoryBadgeProps) {
  const custom = isCustomColor(color)
  const style = getBadgeStyle(color)

  return (
    <span
      {...rest}
      className={cn(
        'inline-flex shrink-0 items-center overflow-hidden rounded-full text-[10px] font-medium',
        className,
      )}
    >
      <span
        className={cn('px-2 py-0.5', !custom && getBadgeClasses(color), !custom && 'brightness-95 dark:brightness-125')}
        // A custom hex has no preset class pair, so the two halves are built
        // from the same colour at different alphas.
        style={custom ? { backgroundColor: `${color}38`, color } : undefined}
      >
        {category}
      </span>
      <span
        className={cn('px-2 py-0.5', !custom && getBadgeClasses(color))}
        style={custom ? style : undefined}
      >
        {value}
      </span>
    </span>
  )
}
