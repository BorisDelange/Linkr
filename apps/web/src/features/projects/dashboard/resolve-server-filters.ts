import type { DatasetColumn, FilterValue } from '@/types'
import { resolveRelativeWindow } from './date-presets'
import { FILTER_NONE } from './DashboardDataProvider'

/**
 * A dashboard filter resolved to a concrete server predicate (keyed by columnId,
 * the raw Parquet column). Alternatives are OR'd; predicates are AND'd server-side.
 * See app/services/execution/injection.py (_python_filter_code / _r_filter_code).
 */
export interface ServerFilterPredicate {
  colId: string
  kind: 'string' | 'number' | 'date'
  alternatives: (
    | { op: 'in'; values: string[] }
    | { op: 'between'; min?: number | string; max?: number | string }
  )[]
}

/**
 * Translate the dashboard's active filters into server predicates. Runs on the
 * client so relative-date windows resolve against the user's "today" — matching
 * applyFilters() exactly, without duplicating that logic on the server.
 * A predicate that would exclude everything (categorical "none") is preserved as
 * an impossible `in []` so the server also returns nothing.
 */
export function resolveServerFilters(
  filters: Record<string, FilterValue>,
  _columns: DatasetColumn[],
): ServerFilterPredicate[] {
  // The predicate `kind` follows the filter type (categorical→string,
  // numeric→number, date/date-relative→date), so column metadata isn't needed here.
  const out: ServerFilterPredicate[] = []
  for (const [colId, filter] of Object.entries(filters)) {
    switch (filter.type) {
      case 'categorical': {
        if (filter.selected.length === 1 && filter.selected[0] === FILTER_NONE) {
          out.push({ colId, kind: 'string', alternatives: [{ op: 'in', values: [] }] })
        } else if (filter.selected.length > 0) {
          out.push({ colId, kind: 'string', alternatives: [{ op: 'in', values: filter.selected }] })
        }
        break
      }
      case 'numeric': {
        if (filter.min != null || filter.max != null) {
          out.push({
            colId, kind: 'number',
            alternatives: [{ op: 'between', ...(filter.min != null ? { min: filter.min } : {}), ...(filter.max != null ? { max: filter.max } : {}) }],
          })
        }
        break
      }
      case 'numeric-double': {
        const alts: ServerFilterPredicate['alternatives'] = []
        if (filter.min1 != null || filter.max1 != null) alts.push({ op: 'between', ...(filter.min1 != null ? { min: filter.min1 } : {}), ...(filter.max1 != null ? { max: filter.max1 } : {}) })
        if (filter.min2 != null || filter.max2 != null) alts.push({ op: 'between', ...(filter.min2 != null ? { min: filter.min2 } : {}), ...(filter.max2 != null ? { max: filter.max2 } : {}) })
        if (alts.length > 0) out.push({ colId, kind: 'number', alternatives: alts })
        break
      }
      case 'date': {
        if (filter.from || filter.to) {
          out.push({
            colId, kind: 'date',
            alternatives: [{ op: 'between', ...(filter.from ? { min: filter.from } : {}), ...(filter.to ? { max: filter.to } : {}) }],
          })
        }
        break
      }
      case 'date-relative': {
        const { from, to } = resolveRelativeWindow(filter.count, filter.unit)
        out.push({ colId, kind: 'date', alternatives: [{ op: 'between', min: from, max: to }] })
        break
      }
    }
  }
  return out
}
