import * as LucideIcons from 'lucide-react'
import { Puzzle } from 'lucide-react'

/** Resolve a Lucide icon by name, falling back to the Puzzle icon. */
export function getPluginIcon(iconName: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[iconName]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

/** Map preset colour names to Tailwind text classes for icon colouring. */
const ICON_COLOR_CLASS: Record<string, string> = {
  red: 'text-red-500',
  blue: 'text-blue-500',
  green: 'text-green-500',
  violet: 'text-violet-500',
  amber: 'text-amber-500',
  rose: 'text-rose-500',
  cyan: 'text-cyan-500',
  slate: 'text-slate-500',
}

export function getPluginIconColorProps(iconColor?: string): { className?: string; style?: React.CSSProperties } {
  if (!iconColor) return { className: 'text-muted-foreground' }
  const tw = ICON_COLOR_CLASS[iconColor]
  if (tw) return { className: tw }
  return { style: { color: iconColor } }
}
