/** Visual metadata for a git change type: a coloured letter badge + i18n label,
 *  shared by the sync panel list and the diff dialog sidebar. */

export interface ChangeMeta {
  letter: string
  labelKey: string
  /** Tailwind classes for the small square badge (bg + text). */
  badgeClass: string
}

const META: Record<string, ChangeMeta> = {
  added: {
    letter: 'A',
    labelKey: 'versioning.change_added',
    badgeClass: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  modified: {
    letter: 'M',
    labelKey: 'versioning.change_modified',
    badgeClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  deleted: {
    letter: 'D',
    labelKey: 'versioning.change_deleted',
    badgeClass: 'bg-red-500/15 text-red-600 dark:text-red-400',
  },
  renamed: {
    letter: 'R',
    labelKey: 'versioning.change_renamed',
    badgeClass: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  },
}

export function changeTypeMeta(changeType: string): ChangeMeta {
  return META[changeType] ?? META.modified
}
