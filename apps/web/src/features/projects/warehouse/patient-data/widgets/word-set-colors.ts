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
  /** Stable name a set stores to claim this slot. */
  name: string
  bg: string
  css: string
  cssDark: string
  /** Nearest badge preset, for the editor chips. */
  badge: BadgeColor
}[] = [
  { name: 'yellow', bg: 'bg-yellow-200 dark:bg-yellow-500/30', css: 'background:rgb(254 240 138);', cssDark: 'background:rgba(234 179 8 / 0.3);', badge: 'amber' },
  { name: 'cyan', bg: 'bg-cyan-200 dark:bg-cyan-500/30', css: 'background:rgb(165 243 252);', cssDark: 'background:rgba(6 182 212 / 0.3);', badge: 'cyan' },
  { name: 'pink', bg: 'bg-pink-200 dark:bg-pink-500/30', css: 'background:rgb(251 207 232);', cssDark: 'background:rgba(236 72 153 / 0.3);', badge: 'rose' },
  { name: 'lime', bg: 'bg-lime-200 dark:bg-lime-500/30', css: 'background:rgb(217 249 157);', cssDark: 'background:rgba(132 204 22 / 0.3);', badge: 'green' },
  { name: 'orange', bg: 'bg-orange-200 dark:bg-orange-500/30', css: 'background:rgb(254 215 170);', cssDark: 'background:rgba(249 115 22 / 0.3);', badge: 'amber' },
  { name: 'violet', bg: 'bg-violet-200 dark:bg-violet-500/30', css: 'background:rgb(221 214 254);', cssDark: 'background:rgba(139 92 246 / 0.3);', badge: 'violet' },
]

/**
 * Text search always uses the first colour (yellow). Being index 0 is what lets
 * the positional fallback below skip it by counting from 1.
 */
export const SEARCH_COLOR_INDEX = 0

/**
 * The slot a set takes from its position alone.
 *
 * Cycles through every colour EXCEPT the search yellow: a set landing on it
 * would be indistinguishable from a text-search hit. The old `(i + 1) % n`
 * merely delayed that — the sixth set wrapped straight onto yellow.
 */
export function getWordSetColorIndex(setIndex: number): number {
  return (setIndex % (WORD_SET_COLORS.length - 1)) + 1
}

/**
 * The palette slot a set uses: its chosen colour, or its position when it has
 * none — which is what every set did before the colour could be picked.
 *
 * An unknown colour name falls back to the position too, so a set that
 * travelled from an instance with a different palette still draws.
 */
export function wordSetColorIndex(setIndex: number, color: string | undefined): number {
  if (color) {
    const i = WORD_SET_COLORS.findIndex((c) => c.name === color)
    if (i >= 0) return i
  }
  return getWordSetColorIndex(setIndex)
}
