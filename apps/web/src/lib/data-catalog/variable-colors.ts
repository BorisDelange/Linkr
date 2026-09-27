import type { CatalogVariableId } from '@/types/catalog'

/**
 * One hue per catalog variable, the same in the app (badges, filters, chart
 * series) and in the published page, so "age" reads as amber everywhere.
 *
 * `hex` feeds SVG charts and the standalone page; the classes are written out
 * in full because Tailwind scans source for whole class names.
 */
export const VARIABLE_COLORS: Record<CatalogVariableId, { hex: string; badge: string; icon: string; bg: string }> = {
  concept: { hex: '#8b5cf6', badge: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300', icon: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-500/10' },
  period: { hex: '#0284c7', badge: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300', icon: 'text-sky-600 dark:text-sky-400', bg: 'bg-sky-500/10' },
  service: { hex: '#0d9488', badge: 'border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300', icon: 'text-teal-600 dark:text-teal-400', bg: 'bg-teal-500/10' },
  age: { hex: '#d97706', badge: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300', icon: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/10' },
  sex: { hex: '#db2777', badge: 'border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300', icon: 'text-pink-600 dark:text-pink-400', bg: 'bg-pink-500/10' },
}
