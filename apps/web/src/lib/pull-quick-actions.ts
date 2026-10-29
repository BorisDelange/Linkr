/**
 * Quick-action cards of the pull: one per SUBJECT of the entity — its information,
 * its dashboards, its wiki pages… — each listing its elements with a take/keep
 * choice (docs/planning/collaborative-versioning-plan.md §9.3).
 *
 * A file lands on the first card whose patterns match it; what no card claims
 * falls on "Other", so nothing coming in is ever out of reach.
 */
import type { GitScope } from '@/lib/api/git'

export interface PullCardDef {
  /** Stable id, also the i18n suffix (`versioning.subject_<id>`). */
  id: string
  /** Paths this card covers. Absent = everything left (the "other" card). */
  patterns?: RegExp[]
  /** Kept for the push side's accent; no pull card carries it any more. */
  isAll?: boolean
}

const INFO = { id: 'info', patterns: [/^(entity|organization)\.json$/, /^README(\.[a-z]{2,3}(-[A-Za-z]{2,4})?)?\.md$/i, /^LICENSE\.md$/i, /^tasks\.json$/, /^attachments\//, /^\.gitignore$/, /^\.gitattributes$/] }

export const PULL_CARDS: Partial<Record<GitScope, PullCardDef[]>> = {
  workspaces: [
    INFO,
    { id: 'wiki', patterns: [/^wiki\//] },
    { id: 'projects', patterns: [/^projects\//] },
    { id: 'sql_collections', patterns: [/^sql-scripts\//] },
    { id: 'etl_pipelines', patterns: [/^etl\//] },
    { id: 'data_quality', patterns: [/^data-quality\//, /^dq\//] },
    { id: 'mapping_projects', patterns: [/^mapping-projects\//, /^source-concept-ids\//] },
    { id: 'catalogs', patterns: [/^catalogs\//] },
    { id: 'schemas', patterns: [/^schemas\//] },
    { id: 'databases', patterns: [/^databases\//] },
    { id: 'dictionaries', patterns: [/^concept-sets\//, /^service-mappings\//] },
    { id: 'plugins', patterns: [/^plugins\//] },
  ],
  projects: [
    INFO,
    { id: 'dashboards', patterns: [/^dashboards\//] },
    { id: 'patient_boards', patterns: [/^patient-dashboards\//] },
    { id: 'scripts', patterns: [/^scripts\//] },
    { id: 'cohorts', patterns: [/^cohorts\//, /^cohort-boards\//] },
    { id: 'datasets', patterns: [/^datasets\//] },
    { id: 'concept_lists', patterns: [/^concept-lists\//] },
    { id: 'connections', patterns: [/^databases\//] },
  ],
  'mapping-projects': [
    INFO,
    { id: 'mappings', patterns: [/^mappings\.json$/] },
    { id: 'source_concepts', patterns: [/^source-concepts\.csv$/, /^source-concept-ids\//] },
    { id: 'scores', patterns: [/^similarity-scores\//] },
  ],
  'sql-script-collections': [INFO, { id: 'scripts', patterns: [/^scripts\//] }],
  'etl-pipelines': [INFO, { id: 'scripts', patterns: [/^scripts\//] }, { id: 'mapping_files', patterns: [/^mapping\//] }],
  'dq-rule-sets': [INFO, { id: 'checks', patterns: [/^checks\.json$/] }],
  'schema-presets': [INFO, { id: 'schema', patterns: [/^schema\.ddl$/, /^mapping\.json$/] }],
  databases: [INFO, { id: 'schema', patterns: [/^schema\.ddl$/, /^mapping(-overrides)?\.json$/] }, { id: 'cohorts', patterns: [/^cohorts\//, /^cohort-boards\//] }],
  'data-catalogs': [INFO],
  'user-plugins': [INFO],
}

const OTHER: PullCardDef = { id: 'other' }

/** The cards a scope defines, with the catch-all last. */
export function cardsForScope(scope: GitScope): PullCardDef[] {
  return [...(PULL_CARDS[scope] ?? []), OTHER]
}

/** Does this card cover that path? The catch-all covers everything. */
export function cardMatches(card: PullCardDef, path: string): boolean {
  if (!card.patterns) return true
  return card.patterns.some((re) => re.test(path))
}

/** Each path on exactly one card: the first that claims it. */
export function assignToCards<T>(scope: GitScope, items: T[], pathOf: (item: T) => string): { card: PullCardDef; items: T[] }[] {
  const cards = cardsForScope(scope)
  const buckets = new Map(cards.map((c) => [c.id, [] as T[]]))
  for (const item of items) {
    const card = cards.find((c) => cardMatches(c, pathOf(item)))!
    buckets.get(card.id)!.push(item)
  }
  return cards.map((card) => ({ card, items: buckets.get(card.id)! })).filter((g) => g.items.length > 0)
}
