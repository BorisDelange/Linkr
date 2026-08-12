/**
 * Quick-action cards, shared by push and pull.
 *
 * One definition per card, with a verb per direction: "Sync" going out, "Pull"
 * coming in. Keeping one list is what makes the two directions symmetric — a card
 * that exists on one side and not the other was how "Sync mappings" ended up
 * quietly pushing `project.json` too, and why source concepts had no card at all.
 *
 * The verbs deliberately stay different: unifying on "Sync" would make the
 * direction ambiguous exactly where the user needs it to be obvious.
 */
import type { GitScope } from '@/lib/api/git'

export interface PullCardDef {
  /** Stable id, also the i18n suffix (`versioning.card_<id>`). */
  id: string
  /** Paths this card covers. Absent = everything (the primary "all" card). */
  patterns?: RegExp[]
  /** The primary card — carries the shared accent colour. */
  isAll?: boolean
}

/**
 * Cards per scope, in display order.
 *
 * `general` groups project.json with README/LICENSE on purpose: they are the same
 * entity fields (`readme` and `license` merge field-by-field exactly like `name`),
 * so splitting them would ask the user to arbitrate one identity in two places.
 */
export const PULL_CARDS: Partial<Record<GitScope, PullCardDef[]>> = {
  // ONE card on the pull side, deliberately.
  //
  // Splitting the incoming changes into per-kind cards was a false symmetry with
  // the push: pulling is already element-by-element (each file's rows are ticked
  // in its picker), so a second, coarser grouping on top only asks the user to
  // choose twice. And a partial card would be misleading anyway — `stats` in
  // project.json is DERIVED from the mappings, so taking mappings without the
  // metadata leaves counters contradicting the rows beside them.
  'mapping-projects': [{ id: 'all', isAll: true }],
  projects: [{ id: 'all', isAll: true }],
}

/** The cards a scope defines, or a single "all" card when it defines none. */
export function cardsForScope(scope: GitScope): PullCardDef[] {
  return PULL_CARDS[scope] ?? [{ id: 'all', isAll: true }]
}

/** Does this card cover that path? The "all" card covers everything. */
export function cardMatches(card: PullCardDef, path: string): boolean {
  if (!card.patterns) return true
  return card.patterns.some((re) => re.test(path))
}
