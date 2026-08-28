import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Is this keyboard event coming from somewhere the user is typing?
 *
 * A container that activates on Space (a card, a drop zone — `role="button"`
 * with an `onKeyDown`) sees the key AFTER any field inside it, because keyboard
 * events bubble. Without this check, pressing space while typing a name in a
 * dialog also "clicked" the widget around the field. Enter has the same problem,
 * which is why the check is on the event rather than on the key.
 *
 * Matches the rule `useGlobalShortcuts` already applies: Monaco types into a
 * hidden textarea, and rich-text editors into a contentEditable.
 */
export function isTypingTarget(e: { target: EventTarget | null }): boolean {
  const el = e.target as HTMLElement | null
  if (!el || !el.tagName) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

/**
 * Hover styling for a card's "…" (more-actions) ghost button. The card itself
 * hovers to `bg-accent`, so a plain ghost `hover:bg-accent` would be invisible on
 * it. An accent-foreground tint stays visible over both the card and its hovered
 * accent background — but accent-foreground is near-white in dark mode, so 10%
 * barely registers there; bump it to 20% in dark for a comparable contrast.
 */
export const cardMenuTriggerClass =
  'text-muted-foreground hover:bg-accent-foreground/10 hover:text-foreground dark:hover:bg-accent-foreground/20'
