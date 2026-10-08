import type { FilterValue } from '@/types'

// An "empty" value (Clear pressed, no selection, no bounds) does nothing, so the filter is
// removed entirely — otherwise the active dot lingers and it counts as active.
// For categorical, selected=[] means "all pass" (see applyFilters), i.e. no active filter.
export function isEmptyFilterValue(value: FilterValue): boolean {
  switch (value.type) {
    case 'categorical': return value.selected.length === 0
    case 'numeric': return value.min == null && value.max == null
    case 'numeric-double':
      return value.min1 == null && value.max1 == null && value.min2 == null && value.max2 == null
    case 'date': return value.from == null && value.to == null
    case 'date-relative': return false
  }
}
