import * as LucideIcons from 'lucide-react'
import { Puzzle } from 'lucide-react'

// ---------------------------------------------------------------------------
// Color mapping — shared by KeyIndicator, PlotBuilder (card mode), etc.
// ---------------------------------------------------------------------------

export const COLOR_MAP: Record<string, { text: string; bg: string; accent: string; hex: string }> = {
  none: { text: 'text-foreground', bg: '', accent: 'border-border', hex: '#000000' },
  red: { text: 'text-red-600', bg: 'bg-red-50 dark:bg-red-950/30', accent: 'border-red-200 dark:border-red-800', hex: '#dc2626' },
  rose: { text: 'text-rose-600', bg: 'bg-rose-50 dark:bg-rose-950/30', accent: 'border-rose-200 dark:border-rose-800', hex: '#e11d48' },
  amber: { text: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-950/30', accent: 'border-amber-200 dark:border-amber-800', hex: '#d97706' },
  green: { text: 'text-green-600', bg: 'bg-green-50 dark:bg-green-950/30', accent: 'border-green-200 dark:border-green-800', hex: '#16a34a' },
  emerald: { text: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-950/30', accent: 'border-emerald-200 dark:border-emerald-800', hex: '#059669' },
  cyan: { text: 'text-cyan-600', bg: 'bg-cyan-50 dark:bg-cyan-950/30', accent: 'border-cyan-200 dark:border-cyan-800', hex: '#0891b2' },
  blue: { text: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-950/30', accent: 'border-blue-200 dark:border-blue-800', hex: '#2563eb' },
  indigo: { text: 'text-indigo-600', bg: 'bg-indigo-50 dark:bg-indigo-950/30', accent: 'border-indigo-200 dark:border-indigo-800', hex: '#4f46e5' },
  violet: { text: 'text-violet-600', bg: 'bg-violet-50 dark:bg-violet-950/30', accent: 'border-violet-200 dark:border-violet-800', hex: '#7c3aed' },
  slate: { text: 'text-slate-600', bg: 'bg-slate-50 dark:bg-slate-950/30', accent: 'border-slate-200 dark:border-slate-800', hex: '#475569' },
}

export const DEFAULT_COLOR = COLOR_MAP.blue

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
  contentStyle: { fontSize: 10, padding: '4px 8px', background: 'rgba(0,0,0,.85)', border: 'none', borderRadius: 4, color: '#fff' },
  labelStyle: { fontSize: 10, color: '#fff' },
  itemStyle: { fontSize: 10, color: '#fff', padding: 0 },
  cursor: { fill: 'rgba(255,255,255,.15)' },
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
