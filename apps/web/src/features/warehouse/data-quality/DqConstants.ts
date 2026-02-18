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

export const CATEGORIES: DqCategory[] = ['completeness', 'validity', 'uniqueness', 'consistency', 'plausibility']
export const SEVERITIES: DqSeverity[] = ['error', 'warning', 'notice']
export const STATUSES: DqCheckStatus[] = ['pass', 'fail', 'error', 'not_applicable']

export const CATEGORY_COLORS: Record<DqCategory, string> = {
  completeness: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  validity: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  uniqueness: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400',
  consistency: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  plausibility: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
}

export const STATUS_CONFIG: Record<DqCheckStatus, { icon: typeof CheckCircle2; color: string; label: string }> = {
  pass: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', label: 'status_pass' },
  fail: { icon: XCircle, color: 'text-red-600 dark:text-red-400', label: 'status_fail' },
  error: { icon: Bug, color: 'text-red-600 dark:text-red-400', label: 'status_error' },
  not_applicable: { icon: Minus, color: 'text-gray-400', label: 'status_not_applicable' },
}

export const SEVERITY_CONFIG: Record<DqSeverity, { icon: typeof ShieldAlert; color: string }> = {
  error: { icon: ShieldX, color: 'text-red-600 dark:text-red-400' },
  warning: { icon: ShieldAlert, color: 'text-amber-600 dark:text-amber-400' },
  notice: { icon: Info, color: 'text-yellow-600 dark:text-yellow-400' },
}

export interface DqFilters {
  searchText: string
  statuses: Set<DqCheckStatus>
  categories: Set<DqCategory>
  tables: Set<string>
  severities: Set<DqSeverity>
}

export function defaultFilters(): DqFilters {
  return {
    searchText: '',
    statuses: new Set(['pass', 'fail', 'error'] as DqCheckStatus[]),
    categories: new Set(CATEGORIES),
    tables: new Set<string>(),
    severities: new Set(SEVERITIES),
  }
}
