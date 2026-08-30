import type { BadgeColor } from '@/types'

/**
 * The highlight colours a word set can take, shared by the document, the apply
 * popover and the editor so one set looks the same in all three.
 *
 * Each entry carries the same colour three ways because it is needed in three
 * places: Tailwind classes for the swatches, inline CSS for the highlight spans
 * injected into sanitized note HTML, and a badge preset for the editor chips.
 */
export const WORD_SET_COLORS: {
  bg: string
  css: string
  cssDark: string
  badge: BadgeColor
}[] = [
  { bg: 'bg-yellow-200 dark:bg-yellow-500/30', css: 'background:rgb(254 240 138);', cssDark: 'background:rgba(234 179 8 / 0.3);', badge: 'amber' },
  { bg: 'bg-cyan-200 dark:bg-cyan-500/30', css: 'background:rgb(165 243 252);', cssDark: 'background:rgba(6 182 212 / 0.3);', badge: 'cyan' },
  { bg: 'bg-pink-200 dark:bg-pink-500/30', css: 'background:rgb(251 207 232);', cssDark: 'background:rgba(236 72 153 / 0.3);', badge: 'rose' },
  { bg: 'bg-lime-200 dark:bg-lime-500/30', css: 'background:rgb(217 249 157);', cssDark: 'background:rgba(132 204 22 / 0.3);', badge: 'green' },
  { bg: 'bg-orange-200 dark:bg-orange-500/30', css: 'background:rgb(254 215 170);', cssDark: 'background:rgba(249 115 22 / 0.3);', badge: 'amber' },
  { bg: 'bg-violet-200 dark:bg-violet-500/30', css: 'background:rgb(221 214 254);', cssDark: 'background:rgba(139 92 246 / 0.3);', badge: 'violet' },
]

/** Text search always uses the first colour (yellow). */
export const SEARCH_COLOR_INDEX = 0

/** Offset by one so text search (yellow) and the first word set do not collide. */
export function getWordSetColorIndex(setIndex: number): number {
  return (setIndex + 1) % WORD_SET_COLORS.length
}
