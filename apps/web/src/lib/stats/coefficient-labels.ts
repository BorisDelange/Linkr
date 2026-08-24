/**
 * Renaming model terms from storage names to labels.
 *
 * Every render spec sends the server a column's `name`, so a fit comes back
 * naming its terms `sofa_score` and, for a dummy, `site: CH Vannes` — where the
 * reader labelled that column "Site". The local compute paths already build
 * their names from `displayColumnName`, so this only has work to do on a
 * server result.
 *
 * Shared by the regression and Cox models, which name their dummies the same
 * way (`"%s: %s" % (column, level)` in both server programs).
 */
import { displayColumnName } from '@/lib/dataset-utils'
import type { DatasetColumn } from '@/types'

/** The separator the server programs put between a column and its level. */
const LEVEL_SEPARATOR = ': '

/**
 * A function mapping one server term name to its display label.
 *
 * Built once per column set: the pairs are sorted LONGEST NAME FIRST, because
 * with columns `site` and `site_type` a shortest-first scan would match `site`
 * against "site_type: A" and relabel it "Site: _type: A".
 */
export function coefficientRelabeler(
  columns: DatasetColumn[],
): (name: string) => string {
  const pairs = [...columns]
    .sort((a, b) => b.name.length - a.name.length)
    .map((c) => [c.name, displayColumnName(c)] as const)

  return (name: string): string => {
    for (const [storage, label] of pairs) {
      if (name === storage) return label
      if (name.startsWith(storage + LEVEL_SEPARATOR)) {
        return label + name.slice(storage.length)
      }
    }
    return name
  }
}
