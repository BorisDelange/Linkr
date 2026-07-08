import type { ProjectStatus, BadgeColor, PresetBadgeColor } from '@/types'

// Shared badge/status colour helpers. Kept in a neutral module (not a feature
// component) so UI primitives can reuse them without a circular import.

export const PRESET_COLORS: { value: PresetBadgeColor; bg: string; text: string; swatch: string }[] = [
  { value: 'blue', bg: 'bg-blue-100 dark:bg-blue-950', text: 'text-blue-700 dark:text-blue-300', swatch: 'bg-blue-400' },
  { value: 'red', bg: 'bg-red-100 dark:bg-red-950', text: 'text-red-700 dark:text-red-300', swatch: 'bg-red-400' },
  { value: 'green', bg: 'bg-green-100 dark:bg-green-950', text: 'text-green-700 dark:text-green-300', swatch: 'bg-green-400' },
  { value: 'violet', bg: 'bg-violet-100 dark:bg-violet-950', text: 'text-violet-700 dark:text-violet-300', swatch: 'bg-violet-400' },
  { value: 'amber', bg: 'bg-amber-100 dark:bg-amber-950', text: 'text-amber-700 dark:text-amber-300', swatch: 'bg-amber-400' },
  { value: 'rose', bg: 'bg-rose-100 dark:bg-rose-950', text: 'text-rose-700 dark:text-rose-300', swatch: 'bg-rose-400' },
  { value: 'cyan', bg: 'bg-cyan-100 dark:bg-cyan-950', text: 'text-cyan-700 dark:text-cyan-300', swatch: 'bg-cyan-400' },
  { value: 'slate', bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-700 dark:text-slate-300', swatch: 'bg-slate-400' },
]

/** Returns Tailwind classes for preset colors, or inline-style-friendly info for custom hex */
export function getBadgeClasses(color: BadgeColor): string {
  const c = PRESET_COLORS.find((pc) => pc.value === color)
  return c ? `${c.bg} ${c.text}` : ''
}

/** Returns inline style for custom hex colors */
export function getBadgeStyle(color: BadgeColor): React.CSSProperties | undefined {
  const isPreset = PRESET_COLORS.some((pc) => pc.value === color)
  if (isPreset) return undefined
  return { backgroundColor: `${color}20`, color }
}

export function isCustomColor(color: BadgeColor): boolean {
  return !PRESET_COLORS.some((pc) => pc.value === color)
}

const STATUS_COLORS: Record<ProjectStatus, { bg: string; text: string; dot: string }> = {
  active: { bg: 'bg-emerald-100 dark:bg-emerald-950', text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
  completed: { bg: 'bg-blue-100 dark:bg-blue-950', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
  archived: { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-600 dark:text-slate-400', dot: 'bg-slate-400' },
  draft: { bg: 'bg-amber-100 dark:bg-amber-950', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
}

/** Returns Tailwind classes for a project status */
export function getStatusClasses(status: ProjectStatus): string {
  const s = STATUS_COLORS[status]
  return `${s.bg} ${s.text}`
}

/** Returns the dot color class for a project status */
export function getStatusDotClass(status: ProjectStatus): string {
  return STATUS_COLORS[status].dot
}
