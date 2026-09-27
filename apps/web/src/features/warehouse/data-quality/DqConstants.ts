import {
  CheckCircle2,
  XCircle,
  Bug,
  Minus,
  ShieldX,
  ShieldAlert,
  Info,
} from 'lucide-react'
import type { DqCategory, DqSeverity, DqCheckStatus } from '@/lib/duckdb/data-quality'

// Three hues far apart, and none of red, green or amber, which already mean
// fail, pass and warning. Chip, dot and chart read the same palette.
export const CATEGORY_COLORS: Record<DqCategory, string> = {
  conformance: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  completeness: 'bg-teal-500/15 text-teal-700 dark:text-teal-400',
  plausibility: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400',
}

export const CATEGORY_DOT: Record<DqCategory, string> = {
  conformance: 'bg-blue-500',
  completeness: 'bg-teal-500',
  plausibility: 'bg-fuchsia-500',
}

/** Recharts takes colours, not classes: the -500 of each hue above. */
export const CATEGORY_HEX: Record<DqCategory, string> = {
  conformance: '#3b82f6',
  completeness: '#14b8a6',
  plausibility: '#d946ef',
}

export const STATUS_CONFIG: Record<DqCheckStatus, { icon: typeof CheckCircle2; color: string; label: string }> = {
  pass: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', label: 'status_pass' },
  fail: { icon: XCircle, color: 'text-red-600 dark:text-red-400', label: 'status_fail' },
  error: { icon: Bug, color: 'text-red-600 dark:text-red-400', label: 'status_error' },
  not_applicable: { icon: Minus, color: 'text-muted-foreground', label: 'status_not_applicable' },
}

export const SEVERITY_CONFIG: Record<DqSeverity, { icon: typeof ShieldAlert; color: string }> = {
  error: { icon: ShieldX, color: 'text-red-600 dark:text-red-400' },
  warning: { icon: ShieldAlert, color: 'text-amber-600 dark:text-amber-400' },
  notice: { icon: Info, color: 'text-yellow-600 dark:text-yellow-400' },
}
