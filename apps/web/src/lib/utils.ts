import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
