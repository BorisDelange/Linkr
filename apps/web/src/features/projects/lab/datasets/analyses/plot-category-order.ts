/** Plot Builder category ordering, shared by every plot whose axis is categorical
 *  (categorical histogram and ranked list, bar, pie, boxplot, violin). Server
 *  parity: `_linkr_order_categories` in
 *  apps/api/app/services/execution/render/plot_builder.py. */

export const CATEGORY_ORDERS = ['value-desc', 'value-asc', 'alpha', 'data', 'custom'] as const
export type CategoryOrder = (typeof CATEGORY_ORDERS)[number]

/** The saved order, or null when the widget never chose one — each plot path then
 *  keeps the order it has always drawn. A widget saved with the older boolean
 *  `sortByMedian: true` reads as `value-desc`. */
export function readCategoryOrder(config: Record<string, unknown>): CategoryOrder | null {
  const saved = config.categoryOrder
  if (typeof saved === 'string' && (CATEGORY_ORDERS as readonly string[]).includes(saved)) return saved as CategoryOrder
  if (config.sortByMedian === true) return 'value-desc'
  return null
}

export function readCustomCategoryOrder(config: Record<string, unknown>): string[] {
  const saved = config.categoryOrderCustom
  return Array.isArray(saved) ? saved.filter((v): v is string => typeof v === 'string') : []
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Reorder categories that arrive in first-appearance order. Sorts are stable, so
 * ties keep that order. `custom` puts the saved names first, in their saved order
 * (names the data no longer has are skipped), then every other category by
 * descending value. Callers apply their category cap AFTER this, so a sorted chart
 * keeps its top categories rather than the first ones met.
 */
export function orderCategories<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  valueOf: (item: T) => number,
  order: CategoryOrder,
  custom: readonly string[] = [],
): T[] {
  const byValueDesc = (a: T, b: T) => valueOf(b) - valueOf(a)
  switch (order) {
    case 'value-desc':
      return [...items].sort(byValueDesc)
    case 'value-asc':
      return [...items].sort((a, b) => valueOf(a) - valueOf(b))
    case 'alpha':
      return [...items].sort((a, b) => collator.compare(nameOf(a), nameOf(b)))
    case 'custom': {
      const byName = new Map(items.map(item => [nameOf(item), item]))
      const head: T[] = []
      const placed = new Set<string>()
      for (const name of custom) {
        const item = byName.get(name)
        if (item === undefined || placed.has(name)) continue
        head.push(item)
        placed.add(name)
      }
      const rest = items.filter(item => !placed.has(nameOf(item))).sort(byValueDesc)
      return [...head, ...rest]
    }
    default:
      return [...items]
  }
}
