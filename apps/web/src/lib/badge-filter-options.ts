import { findCategory, splitLabel } from '@/lib/badge-categories'
import { getBadgeClasses, getBadgeStyle } from '@/lib/badge-colors'
import { localized } from '@/lib/localized'
import type { FilterOption } from '@/components/ui/list-page-toolbar'
import type { BadgeCategory, BadgeColor } from '@/types'

/** The `{ label, color }` shape every list page already derives from its badges. */
export interface BadgeFilterInput {
  label: string
  color: BadgeColor
}

/**
 * Badge filter options, grouped under their category.
 *
 * Categorized options come first, in the workspace's declared order, each run
 * headed by its category name and showing only the value half (the heading
 * already says the category). Uncategorized badges follow, unheaded when there
 * are no categories at all — so a workspace that declares none sees exactly the
 * flat list it saw before.
 *
 * `value` stays the FULL badge label in every case, because that is what the
 * pages match against when filtering.
 */
export function badgeFilterOptions(
  badges: BadgeFilterInput[],
  categories: BadgeCategory[],
  lang: string,
  /** Heading for the uncategorized run, translated by the caller. */
  uncategorizedLabel: string,
): FilterOption[] {
  const scoped = new Map<string, FilterOption[]>()
  const loose: FilterOption[] = []

  for (const badge of badges) {
    const { category: prefix, value } = splitLabel(badge.label)
    const category = prefix ? findCategory(categories, prefix, lang) : undefined

    if (!category) {
      loose.push({
        value: badge.label,
        label: badge.label,
        badgeClass: getBadgeClasses(badge.color),
        badgeStyle: getBadgeStyle(badge.color),
      })
      continue
    }

    const option: FilterOption = {
      value: badge.label,
      // Only the value: the run's heading already names the category.
      label: value,
      badgeClass: getBadgeClasses(category.color),
      badgeStyle: getBadgeStyle(category.color),
      subheading: localized(category.name, lang),
    }
    const bucket = scoped.get(category.id)
    if (bucket) bucket.push(option)
    else scoped.set(category.id, [option])
  }

  const out: FilterOption[] = []
  for (const category of categories) {
    const bucket = scoped.get(category.id)
    if (bucket) out.push(...bucket)
  }
  // Heading the loose run only makes sense once something above it is headed.
  if (loose.length && out.length) {
    out.push(...loose.map((o, i) => (i === 0 ? { ...o, subheading: uncategorizedLabel } : o)))
  } else {
    out.push(...loose)
  }
  return out
}
