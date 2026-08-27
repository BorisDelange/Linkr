/**
 * One hue per entity kind, for every place an entity is shown as itself: the sidebar
 * item, the icon square on its list-page card, and its catalog badge.
 *
 * The warehouse used to be a single teal, which made a seven-item sidebar group and a
 * mixed catalog grid read as one undifferentiated block. Hues are now spread around the
 * wheel instead, and picked to stay clear of the ones the surrounding chrome already
 * spends — blue (home, summary), violet (catalog, IDE), orange (pipeline, versioning),
 * slate (settings).
 *
 * Import from here rather than writing `text-teal-500` at a call site: the hue has to
 * match across all three surfaces, and a hand-copied class silently drifts.
 * Tailwind scans source for whole class names, so these are written out in full.
 */

export interface EntityColor {
  /** Icon tint — sidebar item and list-page card. */
  icon: string
  /** Tinted square behind a card's icon. */
  bg: string
  /** Outline badge (border + fill + text), light and dark. */
  badge: string
}

/** Entity kinds that carry a hue. Workspace-level warehouse, project-level, and lab. */
export type EntityColorKey =
  | 'schema-preset'
  | 'database'
  | 'mapping-project'
  | 'sql-collection'
  | 'dq-rule-set'
  | 'data-catalog'
  | 'etl-pipeline'
  | 'concepts'
  | 'cohorts'
  | 'patient-data'
  | 'workspace'
  | 'project'
  | 'wiki-page'
  | 'plugin'
  | 'dataset'
  | 'dashboard'
  | 'report'

export const ENTITY_COLORS: Record<EntityColorKey, EntityColor> = {
  // ── Workspace warehouse: seven items in one sidebar group, so they take seven
  //    hues from around the wheel rather than shades of one. ──
  'schema-preset': {
    icon: 'text-sky-500',
    bg: 'bg-sky-500/10',
    badge: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  },
  'database': {
    icon: 'text-indigo-500',
    bg: 'bg-indigo-500/10',
    badge: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400',
  },
  'mapping-project': {
    icon: 'text-teal-500',
    bg: 'bg-teal-500/10',
    badge: 'border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-400',
  },
  'sql-collection': {
    icon: 'text-yellow-500',
    bg: 'bg-yellow-500/10',
    badge: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
  },
  'dq-rule-set': {
    icon: 'text-red-500',
    bg: 'bg-red-500/10',
    badge: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  },
  'data-catalog': {
    icon: 'text-lime-600',
    bg: 'bg-lime-500/10',
    badge: 'border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-400',
  },
  'etl-pipeline': {
    icon: 'text-orange-500',
    bg: 'bg-orange-500/10',
    badge: 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400',
  },

  // ── Project warehouse: four items, kept clear of each other and of the
  //    project sidebar's existing blue / violet / orange. ──
  'concepts': {
    icon: 'text-lime-600',
    bg: 'bg-lime-500/10',
    badge: 'border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-400',
  },
  'cohorts': {
    icon: 'text-amber-500',
    bg: 'bg-amber-500/10',
    badge: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  'patient-data': {
    icon: 'text-teal-500',
    bg: 'bg-teal-500/10',
    badge: 'border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-400',
  },

  // ── Elsewhere ──
  // The container the rest lives in. Only shown where a workspace appears AS an
  // entity — a catalog card — so it takes a hue none of its own contents use.
  'workspace': {
    icon: 'text-cyan-600 dark:text-cyan-400',
    bg: 'bg-cyan-500/10',
    badge: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400',
  },
  'project': {
    icon: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-500/10',
    badge: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  },
  // Wiki and plugins are chrome rather than warehouse content, and the hues above
  // deliberately leave emerald and pink to them.
  'wiki-page': {
    icon: 'text-emerald-500',
    bg: 'bg-emerald-500/10',
    badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  'plugin': {
    icon: 'text-pink-500',
    bg: 'bg-pink-500/10',
    badge: 'border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-400',
  },

  // ── Lab ──
  'dataset': {
    icon: 'text-rose-500',
    bg: 'bg-rose-500/10',
    badge: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400',
  },
  'dashboard': {
    icon: 'text-fuchsia-500',
    bg: 'bg-fuchsia-500/10',
    badge: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400',
  },
  'report': {
    icon: 'text-purple-500',
    bg: 'bg-purple-500/10',
    badge: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400',
  },
}
