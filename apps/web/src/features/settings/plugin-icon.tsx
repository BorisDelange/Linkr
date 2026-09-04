import * as LucideIcons from 'lucide-react'
import { Puzzle } from 'lucide-react'

/** Resolve a Lucide icon by name, falling back to the Puzzle icon. */
export function getPluginIcon(iconName: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[iconName]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

/**
 * Map colour names to Tailwind text classes for icon colouring.
 *
 * Wider than the BadgeColor presets on purpose: manifests name Tailwind hues
 * directly (emerald, teal, sky…), and a name missing from here used to fall
 * through to `style={{ color: 'emerald' }}` — not a CSS colour, so the browser
 * dropped it and the icon rendered black.
 */
const ICON_COLOR_CLASS: Record<string, string> = {
  red: 'text-red-500',
  orange: 'text-orange-500',
  amber: 'text-amber-500',
  yellow: 'text-yellow-500',
  lime: 'text-lime-500',
  green: 'text-green-500',
  emerald: 'text-emerald-500',
  teal: 'text-teal-500',
  cyan: 'text-cyan-500',
  sky: 'text-sky-500',
  blue: 'text-blue-500',
  indigo: 'text-indigo-500',
  violet: 'text-violet-500',
  purple: 'text-purple-500',
  fuchsia: 'text-fuchsia-500',
  pink: 'text-pink-500',
  rose: 'text-rose-500',
  slate: 'text-slate-500',
}

/** Only a real CSS colour may reach `style`; anything else is a name we lack. */
const CSS_COLOR = /^(#|rgb|hsl|oklch|color\()/i

export function getPluginIconColorProps(iconColor?: string): { className?: string; style?: React.CSSProperties } {
  if (!iconColor) return { className: 'text-muted-foreground' }
  const tw = ICON_COLOR_CLASS[iconColor]
  if (tw) return { className: tw }
  if (CSS_COLOR.test(iconColor)) return { style: { color: iconColor } }
  return { className: 'text-muted-foreground' }
}
