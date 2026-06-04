import type { DatePresetUnit } from '@/types'

/** Format a Date as YYYY-MM-DD (local). */
function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Resolve a "last N <unit>" sliding window into an inclusive {from, to} date range,
 * ending today. Recomputed each render so the window stays relative to the current date.
 */
export function resolveRelativeWindow(count: number, unit: DatePresetUnit): { from: string; to: string } {
  const to = new Date()
  const from = new Date()
  const n = Math.max(1, count)
  switch (unit) {
    case 'day': from.setDate(from.getDate() - n); break
    case 'week': from.setDate(from.getDate() - n * 7); break
    case 'month': from.setMonth(from.getMonth() - n); break
    case 'year': from.setFullYear(from.getFullYear() - n); break
  }
  return { from: toISODate(from), to: toISODate(to) }
}

const UNIT_LABELS: Record<DatePresetUnit, { en: [string, string]; fr: [string, string] }> = {
  // [singular, plural]
  day: { en: ['day', 'days'], fr: ['jour', 'jours'] },
  week: { en: ['week', 'weeks'], fr: ['semaine', 'semaines'] },
  month: { en: ['month', 'months'], fr: ['mois', 'mois'] },
  year: { en: ['year', 'years'], fr: ['année', 'ans'] },
}

// French uses feminine agreement for semaine/année.
const FR_FEMININE: Record<string, boolean> = { week: true, year: true }

/** Human label for a preset, e.g. "Last week" / "Last 2 weeks" (no number when count === 1). */
export function presetLabel(count: number, unit: DatePresetUnit, lang: 'en' | 'fr'): string {
  const [singular, plural] = UNIT_LABELS[unit][lang] ?? UNIT_LABELS[unit].en
  if (lang === 'fr') {
    const fem = FR_FEMININE[unit]
    if (count === 1) return `${fem ? 'Dernière' : 'Dernier'} ${singular}`
    return `${fem ? 'Dernières' : 'Derniers'} ${count} ${plural}`
  }
  return count === 1 ? `Last ${singular}` : `Last ${count} ${plural}`
}
