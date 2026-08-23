import * as LucideIcons from 'lucide-react'
import { Puzzle } from 'lucide-react'

// ---------------------------------------------------------------------------
// Color mapping — shared by KeyIndicator, PlotBuilder (card mode), etc.
// ---------------------------------------------------------------------------

export const COLOR_MAP: Record<string, { text: string; bg: string; accent: string; hex: string }> = {
  none: { text: 'text-foreground', bg: '', accent: 'border-border', hex: '#000000' },
  slate: { text: 'text-slate-600', bg: 'bg-slate-50 dark:bg-slate-950/30', accent: 'border-slate-200 dark:border-slate-800', hex: '#475569' },
  red: { text: 'text-red-600', bg: 'bg-red-50 dark:bg-red-950/30', accent: 'border-red-200 dark:border-red-800', hex: '#dc2626' },
  rose: { text: 'text-rose-600', bg: 'bg-rose-50 dark:bg-rose-950/30', accent: 'border-rose-200 dark:border-rose-800', hex: '#e11d48' },
  pink: { text: 'text-pink-600', bg: 'bg-pink-50 dark:bg-pink-950/30', accent: 'border-pink-200 dark:border-pink-800', hex: '#db2777' },
  fuchsia: { text: 'text-fuchsia-600', bg: 'bg-fuchsia-50 dark:bg-fuchsia-950/30', accent: 'border-fuchsia-200 dark:border-fuchsia-800', hex: '#c026d3' },
  orange: { text: 'text-orange-600', bg: 'bg-orange-50 dark:bg-orange-950/30', accent: 'border-orange-200 dark:border-orange-800', hex: '#ea580c' },
  amber: { text: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-950/30', accent: 'border-amber-200 dark:border-amber-800', hex: '#d97706' },
  yellow: { text: 'text-yellow-600', bg: 'bg-yellow-50 dark:bg-yellow-950/30', accent: 'border-yellow-200 dark:border-yellow-800', hex: '#ca8a04' },
  lime: { text: 'text-lime-600', bg: 'bg-lime-50 dark:bg-lime-950/30', accent: 'border-lime-200 dark:border-lime-800', hex: '#65a30d' },
  green: { text: 'text-green-600', bg: 'bg-green-50 dark:bg-green-950/30', accent: 'border-green-200 dark:border-green-800', hex: '#16a34a' },
  emerald: { text: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-950/30', accent: 'border-emerald-200 dark:border-emerald-800', hex: '#059669' },
  teal: { text: 'text-teal-600', bg: 'bg-teal-50 dark:bg-teal-950/30', accent: 'border-teal-200 dark:border-teal-800', hex: '#0d9488' },
  cyan: { text: 'text-cyan-600', bg: 'bg-cyan-50 dark:bg-cyan-950/30', accent: 'border-cyan-200 dark:border-cyan-800', hex: '#0891b2' },
  sky: { text: 'text-sky-600', bg: 'bg-sky-50 dark:bg-sky-950/30', accent: 'border-sky-200 dark:border-sky-800', hex: '#0284c7' },
  blue: { text: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-950/30', accent: 'border-blue-200 dark:border-blue-800', hex: '#2563eb' },
  indigo: { text: 'text-indigo-600', bg: 'bg-indigo-50 dark:bg-indigo-950/30', accent: 'border-indigo-200 dark:border-indigo-800', hex: '#4f46e5' },
  violet: { text: 'text-violet-600', bg: 'bg-violet-50 dark:bg-violet-950/30', accent: 'border-violet-200 dark:border-violet-800', hex: '#7c3aed' },
  purple: { text: 'text-purple-600', bg: 'bg-purple-50 dark:bg-purple-950/30', accent: 'border-purple-200 dark:border-purple-800', hex: '#9333ea' },
}

export const DEFAULT_COLOR = COLOR_MAP.blue

/** Categorical color palettes shared by chart-rendering plugins (Plot Builder, Map). */
export const CHART_PALETTES: Record<string, string[]> = {
  // Drawn from the Tailwind 500/600 ramps the rest of the app is built from, so
  // a chart sits in the same world as the buttons and badges around it. The
  // hues are spaced around the wheel and alternate warm/cool, which keeps
  // adjacent categories distinct without any two reading as "the same colour,
  // slightly different" — the failing of the classic Tableau ramp, whose muted
  // pastels also look dated beside a modern interface.
  default: ['#2563eb', '#f97316', '#14b8a6', '#e11d48', '#8b5cf6', '#eab308', '#0ea5e9', '#84cc16', '#ec4899', '#64748b'],
  // The 2010 Tableau ramp, kept because published figures were drawn with it.
  tableau: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'],
  tableau10: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
  pastel: ['#aec7e8', '#ffbb78', '#ff9896', '#98df8a', '#c5b0d5', '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5'],
  vivid: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#999999', '#66c2a5', '#fc8d62'],
  earth: ['#8c510a', '#bf812d', '#dfc27d', '#80cdc1', '#35978f', '#01665e', '#c7eae5', '#f6e8c3', '#d8b365', '#5ab4ac'],
  ocean: ['#08519c', '#3182bd', '#6baed6', '#9ecae1', '#c6dbef', '#084594', '#2171b5', '#4292c6', '#6baed6', '#9ecae1'],
  warm: ['#e41a1c', '#fc4e2a', '#fd8d3c', '#feb24c', '#fed976', '#d7301f', '#ef6548', '#fc8d59', '#fdbb84', '#fdd49e'],
  cool: ['#225ea8', '#1d91c0', '#41b6c4', '#7fcdbb', '#c7e9b4', '#253494', '#2c7fb8', '#41b6c4', '#a1dab4', '#ffffcc'],
  monochrome: ['#252525', '#525252', '#737373', '#969696', '#bdbdbd', '#d9d9d9', '#636363', '#a8a8a8', '#454545', '#cccccc'],
}

/** Parse a comma-separated list of hex colors (the custom-palette editor format). */
export function parseCustomPalette(input: string): string[] | null {
  if (!input.trim()) return null
  const colors = input.split(',').map(s => s.trim()).filter(s => /^#[0-9a-fA-F]{3,8}$/.test(s))
  return colors.length > 0 ? colors : null
}

/** Resolve a palette name (or "custom" + editor string) to an array of hex colors. */
export function resolvePalette(name: string, customStr = ''): string[] {
  if (name === 'custom') return parseCustomPalette(customStr) ?? CHART_PALETTES.default
  return CHART_PALETTES[name] ?? CHART_PALETTES.default
}

/** Resolve a color name or hex string to a color config. Hex colors use inline styles. */
export function resolveColor(name: string): { text: string; bg: string; accent: string; hex: string; isCustom?: boolean } {
  if (name.startsWith('#')) {
    return { text: '', bg: '', accent: '', hex: name, isCustom: true }
  }
  return COLOR_MAP[name] ?? DEFAULT_COLOR
}

// ---------------------------------------------------------------------------
// Lucide icon helper
// ---------------------------------------------------------------------------

export function getLucideIcon(name: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[name]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

// ---------------------------------------------------------------------------
// Shared Recharts tooltip style (dark background, white text)
// ---------------------------------------------------------------------------

export const TOOLTIP_STYLE = {
  // Theme tokens rather than hard black: a solid black card is heavy against
  // the app's light surfaces and, in dark mode, was the one element that did
  // not follow the theme. The popover tokens are what every other floating
  // surface in the app uses.
  contentStyle: {
    fontSize: 11,
    padding: '6px 10px',
    background: 'var(--color-popover)',
    border: '1px solid var(--color-border)',
    borderRadius: 6,
    boxShadow: '0 4px 12px rgb(0 0 0 / 0.08)',
    color: 'var(--color-popover-foreground)',
  },
  labelStyle: { fontSize: 11, fontWeight: 600, color: 'var(--color-foreground)', marginBottom: 2 },
  itemStyle: { fontSize: 11, color: 'var(--color-muted-foreground)', padding: 0 },
  cursor: { fill: 'var(--color-muted)', fillOpacity: 0.5 },
} as const

// ---------------------------------------------------------------------------
// Per-entity aggregation — shared by KeyIndicator, PlotBuilder, etc.
// ---------------------------------------------------------------------------

/**
 * Group rows by `entityCol` and reduce each group to a single row using `aggFn`.
 *
 * - `first` / `last`: keep the first or last row encountered
 * - `mean`, `median`, `min`, `max`, `sum`: aggregate all **numeric** columns,
 *   keeping the first value for non-numeric columns
 */
export function aggregateByEntity(
  rows: Record<string, unknown>[],
  entityCol: string,
  aggFn: string,
): Record<string, unknown>[] {
  if (rows.length === 0) return rows

  // Group rows by entity
  const groups = new Map<unknown, Record<string, unknown>[]>()
  for (const row of rows) {
    const key = row[entityCol]
    if (key == null) continue
    let list = groups.get(key)
    if (!list) { list = []; groups.set(key, list) }
    list.push(row)
  }

  // For first/last, just pick the row directly
  if (aggFn === 'first') {
    return Array.from(groups.values()).map(g => g[0])
  }
  if (aggFn === 'last') {
    return Array.from(groups.values()).map(g => g[g.length - 1])
  }

  // Numeric aggregation: collect all column keys from first row
  const colKeys = Object.keys(rows[0])

  return Array.from(groups.values()).map(group => {
    const result: Record<string, unknown> = {}
    for (const col of colKeys) {
      // Try numeric aggregation
      const nums: number[] = []
      for (const row of group) {
        const v = row[col]
        if (v == null) continue
        const n = typeof v === 'number' ? v : Number(v)
        if (!isNaN(n)) nums.push(n)
      }

      if (nums.length > 0 && col !== entityCol) {
        result[col] = aggregateNumbers(nums, aggFn)
      } else {
        // Non-numeric or entity column: keep first value
        result[col] = group[0][col]
      }
    }
    return result
  })
}

function aggregateNumbers(nums: number[], fn: string): number {
  switch (fn) {
    case 'mean':
      return nums.reduce((s, v) => s + v, 0) / nums.length
    case 'median': {
      const sorted = [...nums].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    }
    case 'min':
      return Math.min(...nums)
    case 'max':
      return Math.max(...nums)
    case 'sum':
      return nums.reduce((s, v) => s + v, 0)
    default:
      return nums[0]
  }
}
