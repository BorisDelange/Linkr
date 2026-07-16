import type { EffectiveMappingStatus } from '@/types'

/** Canonical color per effective mapping status. Shared by the Progress tab
 *  (status pie + breakdown bars) and any other status visualisation so the color
 *  code stays consistent. */
export const STATUS_COLORS: Record<EffectiveMappingStatus, string> = {
  unchecked: '#94a3b8', // slate-400
  suggested: '#60a5fa', // blue-400
  approved: '#34d399', // emerald-400
  rejected: '#ef4444', // red-500
  flagged: '#fb923c', // orange-400
  invalid: '#f87171', // red-400
  ignored: '#a78bfa', // violet-400
  disputed: '#f59e0b', // amber-500
}

/** Color for source concepts with no mapping yet. */
export const UNMAPPED_COLOR = '#e2e8f0'

/** Fallback color for an unknown status key. */
export const STATUS_FALLBACK_COLOR = '#9ca3af'

export function statusColor(status: string): string {
  return STATUS_COLORS[status as EffectiveMappingStatus] ?? STATUS_FALLBACK_COLOR
}
