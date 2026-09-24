/** A cohort's export key: the file name under `cohorts/`, and the name a
 *  derivation's provenance gives the cohort. */
import { slugify } from '@linkr/format'
import { localized } from '@/lib/localized'
import type { Cohort } from '@/types'

/** cohortKey — slug of the English name, matching the export filename. English
 *  so the filename (and the id derived from it) stays put when the cohort is
 *  renamed in another language.
 *
 *  Use `buildCohortKeyMap` when writing or reading a whole project: nothing
 *  enforces unique cohort names, and two that share one collapse onto this key. */
export function cohortKey(c: Cohort): string {
  return slugify(localized(c.name, 'en') || c.id)
}

/**
 * Every cohort id → its export key, `#<n>` on a collision.
 *
 * Cohort names are not unique — nothing in the app enforces it — and the key is
 * the slug of the name, so two cohorts called "Adults" produce one filename:
 * writing them both wrote `cohorts/adults.json` twice and the second silently
 * destroyed the first, losing a cohort the user had authored. Disambiguated the
 * way sibling tabs and widgets already are.
 *
 * Fixed iteration order for the same reason `buildPatientTabKeyMap` sorts: the
 * suffix is handed out as we go, so a different order gives the pair each
 * other's keys — swapped ids on reimport and a diff with no change behind it.
 * Code-point order on the id, matching Python's `sorted(key=str)`.
 */
export function buildCohortKeyMap(cohorts: Cohort[]): Map<string, string> {
  const keyOf = new Map<string, string>()
  const seen = new Set<string>()
  const ordered = [...cohorts].sort((a, b) => {
    const x = String(a.id)
    const y = String(b.id)
    return x < y ? -1 : x > y ? 1 : 0
  })
  for (const c of ordered) {
    const base = cohortKey(c)
    let key = base
    for (let n = 2; seen.has(key); n++) key = `${base}#${n}`
    seen.add(key)
    keyOf.set(c.id, key)
  }
  return keyOf
}
