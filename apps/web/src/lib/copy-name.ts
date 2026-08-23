import { localized, toLocalized } from '@/lib/localized'
import type { LocalizedString } from '@/types'

/**
 * The suffix a copy carries, numbered once " (copy)" is itself taken.
 * Resolved on the English name alone: every language is suffixed together, so
 * one collision check answers for all of them. Suffixing per language would let
 * "Cohort (copy)" and "Cohorte (copy) 2" disagree about which copy they are.
 */
function copySuffix(base: string, siblings: (LocalizedString | string)[]): string {
  const taken = new Set(siblings.map((n) => localized(n, 'en').toLowerCase()))
  const suffix = (n: number) => (n > 1 ? ` (copy) ${n}` : ' (copy)')
  let n = 1
  while (taken.has((base + suffix(n)).toLowerCase())) n++
  return suffix(n)
}

/**
 * Name for a duplicated entity: the original with " (copy)" appended, numbered
 * when that is already taken among `siblings`.
 *
 * Not `uniqueName` (which yields "Foo (2)"): that one only avoids a collision
 * when re-creating from a template, while this one has to *say* the entity is a
 * copy. "(copy)" is what `duplicateWidget` has always produced, and the two
 * dashboards' duplicate actions now read the same as their widgets'.
 */
export function copyName(name: LocalizedString | string, siblings: (LocalizedString | string)[]): LocalizedString {
  const suffix = copySuffix(localized(name, 'en'), siblings)
  return Object.fromEntries(
    Object.entries(toLocalized(name)).map(([lang, val]) => [lang, `${val}${suffix}`]),
  )
}

/** `copyName` for an entity whose name is a plain string, not a localized map. */
export function copyNameString(name: string, siblings: string[]): string {
  return name + copySuffix(name, siblings)
}
