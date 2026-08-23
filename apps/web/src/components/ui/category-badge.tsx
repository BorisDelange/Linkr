import { useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import {
  darkenForWhiteBackground,
  getBadgeClasses,
  getBadgeOutlineClasses,
  getBadgeStyle,
  isCustomColor,
} from '@/lib/badge-colors'
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
 * A two-tone chip for a scoped badge, in GitLab's scoped-label grammar: the
 * category half is the ordinary filled badge, the value half is the same colour
 * as border and text on the page ground. `Source::MIMIC` then reads as one badge
 * that says which axis it is on.
 *
 * The separator itself is not drawn: the fill change already marks the boundary,
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

  // The border rings the WHOLE chip, drawn once on the parent: a border on the
  // value half alone gets clipped at the rounded ends, since a square child
  // inside a `rounded-full` parent loses exactly the arc the border traces.
  // What separates the halves is then a single divider on the value's left edge.
  const pad = size === 'md' ? 'px-2.5' : 'px-2'
  const outline = !custom && getBadgeOutlineClasses(color)

  const categoryHalf = cn(pad, 'py-0.5', !custom && getBadgeClasses(color))
  const categoryStyle = custom ? getBadgeStyle(color) : undefined

  // Left half: the ordinary filled badge. Right half: the page ground, so the
  // colour reads as border and text. A user-picked hex may be far too pale to
  // be legible there; presets never are, their outline token being the shade
  // meant for a light ground.
  const valueHalf = cn('border-l bg-background', outline)
  const valueStyle = custom
    ? { borderColor: `${color}80`, color: darkenForWhiteBackground(color) }
    : undefined

  const ringStyle = custom ? { borderColor: `${color}80` } : undefined

  const controlClass = 'rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20'

  return (
    <span
      {...rest}
      className={cn(
        'inline-flex shrink-0 items-center overflow-hidden rounded-full border font-medium',
        outline,
        size === 'md' ? 'text-xs' : 'text-[10px]',
        className,
      )}
      style={ringStyle}
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
