import { useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { getBadgeClasses, getBadgeStyle, isCustomColor } from '@/lib/badge-colors'
import { cn } from '@/lib/utils'
import type { BadgeColor } from '@/types'

interface CategoryBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'onChange'> {
  /** Text before the separator, e.g. "Source". Rendered darker. */
  category: string
  /** Text after it, e.g. "MIMIC". */
  value: string
  color: BadgeColor
  /** When omitted, the chip is read-only (no remove button). */
  onRemove?: () => void
  /** When provided, a pencil renames the VALUE half. The category is not editable
   *  here — it is picked, and typing over it would move the badge silently. */
  onRename?: (next: string) => void
  /**
   * Matches the plain chip it sits beside: `sm` is the dense card row's
   * `text-[10px]` (BadgeStrip), `md` is the editor's `text-xs` (EditableBadge).
   * A scoped badge must not read a size apart from its uncategorized siblings.
   */
  size?: 'sm' | 'md'
}

/**
 * A two-tone chip for a scoped badge: the category half is darker than the
 * value half, so `Source::MIMIC` reads as one badge that says which axis it is
 * on — the same visual grammar GitLab uses for scoped labels.
 *
 * The separator itself is not drawn: the tone change already marks the boundary,
 * and printing `::` inside a chip that is already split reads as a typo.
 *
 * Carries the same inline rename/remove controls as `EditableBadge`, in the same
 * place (inside the chip, on its right edge) — a badge should not gain or lose
 * affordances just because it has a category. Only the value is editable.
 */
export function CategoryBadge({
  category,
  value,
  color,
  className,
  onRemove,
  onRename,
  size = 'sm',
  ...rest
}: CategoryBadgeProps) {
  const custom = isCustomColor(color)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const commit = () => {
    const next = draft.trim()
    if (next && next !== value) onRename?.(next)
    setEditing(false)
  }

  // The two halves differ only in tone: presets darken the category via a filter,
  // a custom hex builds both from the same colour at different alphas.
  const pad = size === 'md' ? 'px-2.5' : 'px-2'
  const categoryHalf = cn(
    pad,
    'py-0.5',
    !custom && getBadgeClasses(color),
    !custom && 'brightness-95 dark:brightness-125',
  )
  const categoryStyle = custom ? { backgroundColor: `${color}38`, color } : undefined
  const valueHalf = cn(!custom && getBadgeClasses(color))
  const valueStyle = custom ? getBadgeStyle(color) : undefined

  const controlClass = 'rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20'

  return (
    <span
      {...rest}
      className={cn(
        'inline-flex shrink-0 items-center overflow-hidden rounded-full font-medium',
        size === 'md' ? 'text-xs' : 'text-[10px]',
        className,
      )}
    >
      <span className={categoryHalf} style={categoryStyle}>{category}</span>
      <span
        className={cn(
          valueHalf,
          'flex items-center py-0.5',
          size === 'md' ? 'gap-1.5' : 'gap-1',
          editing || onRemove || onRename ? cn(pad, 'pr-1') : pad,
        )}
        style={valueStyle}
      >
        {editing ? (
          <>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit() }
                else if (e.key === 'Escape') { setDraft(value); setEditing(false) }
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-24 bg-transparent outline-none placeholder:text-current/50"
            />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); commit() }}
              className={controlClass}
            >
              <Check size={12} />
            </button>
          </>
        ) : (
          <>
            {value}
            {onRename && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true) }}
                className={controlClass}
                aria-label="Edit"
              >
                <Pencil size={11} />
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                className={controlClass}
                aria-label="Remove"
              >
                <X size={12} />
              </button>
            )}
          </>
        )}
      </span>
    </span>
  )
}
