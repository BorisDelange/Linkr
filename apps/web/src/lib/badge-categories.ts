import { localized } from '@/lib/localized'
import type { BadgeCategory, LocalizedString, ProjectBadge } from '@/types'

/** Separates a category from its value inside a badge label, as in GitLab. */
export const CATEGORY_SEPARATOR = '::'

/**
 * A badge's label split around the separator. `category` is the raw text before
 * it — matched against the workspace's declared categories by the caller, since
 * an undeclared prefix is just part of the label.
 */
export interface SplitLabel {
  category: string | null
  value: string
}

/**
 * Split `Source::MIMIC` into its category and value.
 *
 * Splits on the FIRST separator, so a value may itself contain one
 * (`Source::a::b` is category `Source`, value `a::b`). A label with nothing on
 * either side of the separator is not a scoped label at all — `::x` and `x::`
 * come back uncategorized, rather than yielding an empty category that would
 * render as a blank chip half.
 */
export function splitLabel(label: string): SplitLabel {
  const at = label.indexOf(CATEGORY_SEPARATOR)
  if (at <= 0) return { category: null, value: label }
  const value = label.slice(at + CATEGORY_SEPARATOR.length)
  if (!value.trim()) return { category: null, value: label }
  return { category: label.slice(0, at), value }
}

/** Build the label a categorized badge carries: `Source::MIMIC`. */
export function joinLabel(category: string, value: string): string {
  return `${category}${CATEGORY_SEPARATOR}${value}`
}

/** Case-insensitive lookup of a declared category by its name in `lang`. */
export function findCategory(
  categories: BadgeCategory[],
  name: string,
  lang: string,
): BadgeCategory | undefined {
  const key = name.trim().toLowerCase()
  return categories.find((c) => localized(c.name, lang).toLowerCase() === key)
}

/**
 * The category a badge belongs to, or undefined when its prefix names none.
 *
 * Resolved against the workspace's list on every read rather than stored on the
 * badge: a category can be renamed or deleted, and a stored id would then point
 * at nothing while the label still reads `Source::MIMIC`.
 */
export function categoryOf(
  badge: ProjectBadge,
  categories: BadgeCategory[],
  lang: string,
): BadgeCategory | undefined {
  const { category } = splitLabel(localized(badge.label, lang))
  return category ? findCategory(categories, category, lang) : undefined
}

/**
 * Add `badge` to `badges`, honouring exclusivity.
 *
 * An exclusive category holds one value per entity, so adding `Source::eICU`
 * where `Source::MIMIC` sits REPLACES it — that is the whole point of a scoped
 * label. Non-exclusive categories and uncategorized badges just append.
 *
 * An exact duplicate is refused in every case (the caller's input is unchanged),
 * so a suggestion clicked twice doesn't produce two identical chips.
 */
export function addBadge(
  badges: ProjectBadge[],
  badge: ProjectBadge,
  categories: BadgeCategory[],
  lang: string,
): ProjectBadge[] {
  const label = localized(badge.label, lang).trim()
  if (!label) return badges
  if (badges.some((b) => localized(b.label, lang).trim().toLowerCase() === label.toLowerCase())) {
    return badges
  }

  const category = categoryOf(badge, categories, lang)
  if (!category?.exclusive) return [...badges, badge]

  // Drop whatever this category already holds — one value per entity.
  return [...badges.filter((b) => categoryOf(b, categories, lang)?.id !== category.id), badge]
}

/**
 * Rename a category across the workspace's badges.
 *
 * The label holds the category name, so renaming the category alone would leave
 * every badge reading the old prefix. Deleting a category deliberately does NOT
 * go through here: the badges keep their labels verbatim.
 */
export function renameCategoryInBadges(
  badges: ProjectBadge[],
  from: string,
  to: string,
  lang: string,
): ProjectBadge[] {
  const key = from.trim().toLowerCase()
  return badges.map((badge) => {
    const label = localized(badge.label, lang)
    const { category, value } = splitLabel(label)
    if (!category || category.trim().toLowerCase() !== key) return badge
    return { ...badge, label: relabel(badge.label, label, joinLabel(to, value)) }
  })
}

/** Replace a badge's label, keeping every other language it carries. */
function relabel(
  original: LocalizedString | string,
  resolved: string,
  next: string,
): LocalizedString | string {
  if (typeof original === 'string') return next
  return Object.fromEntries(
    Object.entries(original).map(([lang, val]) => [lang, val === resolved ? next : val]),
  )
}
