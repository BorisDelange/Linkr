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

/**
 * Build a categorized badge's label in EVERY language the category is named in.
 *
 * The prefix is the category's own name, which is translated — so storing a
 * single language's spelling (`Source FR::MIMIC`) leaves the badge unmatchable
 * once the UI switches, and it renders as raw text with a visible `::`. The
 * value half is the same in all languages unless the user edits it per language.
 */
export function joinLocalizedLabel(
  category: BadgeCategory,
  value: string,
  existing?: LocalizedString | string,
): LocalizedString {
  const langs = Object.keys(category.name).filter((l) => category.name[l]?.trim())
  const base = typeof existing === 'object' && existing ? { ...existing } : {}
  for (const lang of langs) {
    base[lang] = joinLabel(category.name[lang], valueIn(existing, lang) || value)
  }
  return base
}

/** The value half already stored for `lang`, with no cross-language fallback. */
function valueIn(label: LocalizedString | string | undefined, lang: string): string {
  if (!label || typeof label === 'string') return ''
  const raw = label[lang]
  return raw ? splitLabel(raw).value : ''
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

/** Case-insensitive lookup by a category name in ANY of its languages. */
export function findCategoryAnyLang(
  categories: BadgeCategory[],
  name: string,
): BadgeCategory | undefined {
  const key = name.trim().toLowerCase()
  return categories.find((c) =>
    Object.values(c.name).some((n) => n?.trim().toLowerCase() === key),
  )
}

/**
 * The category a badge belongs to, or undefined when its prefix names none.
 *
 * Resolved against the workspace's list on every read rather than stored on the
 * badge: a category can be renamed or deleted, and a stored id would then point
 * at nothing while the label still reads `Source::MIMIC`.
 *
 * The active language is tried first, then every prefix the label carries in any
 * language — a badge written before the prefix was localized holds one spelling
 * only, and must still resolve (and render two-tone) in the other language.
 */
export function categoryOf(
  badge: ProjectBadge,
  categories: BadgeCategory[],
  lang: string,
): BadgeCategory | undefined {
  const { category } = splitLabel(localized(badge.label, lang))
  const here = category ? findCategory(categories, category, lang) : undefined
  if (here) return here

  const label = badge.label
  if (typeof label !== 'object' || !label) {
    return category ? findCategoryAnyLang(categories, category) : undefined
  }
  for (const raw of Object.values(label)) {
    const prefix = raw ? splitLabel(raw).category : null
    const found = prefix ? findCategoryAnyLang(categories, prefix) : undefined
    if (found) return found
  }
  return undefined
}

/**
 * The value half of a badge in `lang`, whichever language its prefix was written
 * in. Reading `splitLabel(localized(...)).value` alone returns the whole raw
 * label when the active language's prefix names no category, which would print
 * `Source FR::MIMIC` inside a chip.
 */
export function valueOf(
  badge: ProjectBadge,
  categories: BadgeCategory[],
  lang: string,
): string {
  const resolved = localized(badge.label, lang)
  const { category, value } = splitLabel(resolved)
  if (category && findCategoryAnyLang(categories, category)) return value
  return resolved
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
 *
 * `next` is the category AFTER the rename: every language of the badge whose
 * prefix names this category is re-prefixed with that language's new spelling,
 * not just the one the user typed in. Renaming only the active language is what
 * left badges half-migrated and unmatchable in the other one.
 */
export function renameCategoryInBadges(
  badges: ProjectBadge[],
  previous: BadgeCategory,
  next: BadgeCategory,
): ProjectBadge[] {
  const names = new Set(
    Object.values(previous.name).filter(Boolean).map((n) => n.trim().toLowerCase()),
  )
  const belongs = (label: string) => {
    const { category } = splitLabel(label)
    return !!category && names.has(category.trim().toLowerCase())
  }

  return badges.map((badge) => {
    if (typeof badge.label === 'string') {
      if (!belongs(badge.label)) return badge
      const value = splitLabel(badge.label).value
      return { ...badge, label: joinLocalizedLabel(next, value) }
    }

    const entries = Object.entries(badge.label)
    const seed = entries.find(([, val]) => val && belongs(val))
    if (!seed) return badge

    // Each language keeps its own value; a language the badge never carried is
    // seeded from one that did, so the rename leaves no half-prefixed label.
    const fallback = splitLabel(seed[1]).value
    const label: LocalizedString = {}
    for (const [lang, val] of entries) {
      if (!val || !belongs(val)) { label[lang] = val; continue }
      const name = next.name[lang]?.trim()
      const own = splitLabel(val).value
      // A language the renamed category no longer names keeps the bare value:
      // an empty prefix would render as a blank chip half.
      label[lang] = name ? joinLabel(name, own) : own
    }
    for (const [lang, name] of Object.entries(next.name)) {
      if (name?.trim() && !(lang in label)) label[lang] = joinLabel(name.trim(), fallback)
    }
    return { ...badge, label }
  })
}
