/**
 * README + LICENSE in a pull, shared by every scope.
 *
 * These files are the one part of an export that is NOT tree content: the export
 * writes `README.md` (+ `README.<lang>.md`) and `LICENSE.md` beside the manifests,
 * and the entity owns them as its `readme` / `license` fields. A pull that plans
 * only from `_tree.json` therefore misses them entirely — which is exactly the bug
 * that made a remote commit adding a README report "nothing to pull".
 *
 * Every scope writes them (all nine `git-file-meta` rule sets classify them under
 * `readme`), so the reading and comparing belong here rather than being re-derived
 * per scope. What differs per scope is only the MECHANISM that carries them:
 *   - projects / ETL pipelines: clone the repo, offer a "take theirs" docs block
 *   - mapping projects: a server-side 3-way merge, so readme/license are merged
 *     field by field like name/description (a local edit becomes a conflict, not
 *     a silent loss)
 * Both consume the helpers below.
 */
import type { EntityLicense, LocalizedString } from '@/types'
import { readLicense, readReadmeByLang } from '@/lib/entity-io'
import { toLocalized } from '@/lib/localized'

/** An entity's docs as the pull carries them (entity fields, not files). */
export interface EntityDocs {
  readme?: LocalizedString
  license?: EntityLicense
}

/**
 * A readme that is present in substance, or undefined.
 *
 * `{}` is truthy, and `toLocalized(undefined)` returns exactly that — so a caller
 * normalising a missing readme would report "the remote has one" and mark the
 * block as changed forever. An all-empty map counts as absent too: an entity whose
 * readme was cleared has `{ en: '' }`, which is not content to pull.
 */
export function presentReadme(
  readme: LocalizedString | string | null | undefined,
): LocalizedString | undefined {
  if (!readme) return undefined
  const byLang = toLocalized(readme)
  return Object.values(byLang).some((v) => v) ? byLang : undefined
}

/** The subset of an entity a docs comparison needs. */
export interface DocsOwner {
  readme?: LocalizedString | string
  license?: EntityLicense
}

/**
 * Read the docs out of an already-parsed clone (path → text, JSON values ignored).
 *
 * `meta` is the entity's own JSON (project.json / _pipeline.json / …): the license
 * ID lives there while only its text is in LICENSE.md, so `readLicense` recombines
 * the two. Delegates the README split to `readReadmeByLang`, the inverse of the
 * export's `writeReadmeFiles`.
 */
export function readEntityDocsFrom(
  parsed: Record<string, unknown>,
  meta: { license?: { id?: string; name?: string } } | null | undefined,
): EntityDocs {
  const textByPath: Record<string, string> = {}
  for (const [path, value] of Object.entries(parsed)) {
    if (typeof value === 'string') textByPath[path] = value
  }
  const licenseText = textByPath['LICENSE.md']
  return {
    readme: presentReadme(readReadmeByLang(textByPath)),
    license: readLicense(meta?.license, licenseText),
  }
}

/**
 * Do the remote docs differ from the local ones?
 *
 * Only fields the remote actually carries are compared: a pull ADDS or REPLACES,
 * so a repo with no LICENSE must not report a change (and must never blank out a
 * local licence). A legacy plain-string readme is normalised first — `toLocalized`
 * fills every language from a bare string, so it is compared on equal terms.
 */
export function entityDocsChanged(local: DocsOwner | undefined, remote: EntityDocs): boolean {
  if (!remote.readme && !remote.license) return false
  const norm = (v: unknown) => JSON.stringify(v ?? null)
  const localReadme = presentReadme(local?.readme)
  return (
    (!!remote.readme && norm(localReadme) !== norm(remote.readme))
    || (!!remote.license && norm(local?.license) !== norm(remote.license))
  )
}

/**
 * The changes to persist when the user takes the remote docs.
 *
 * Absent fields are omitted rather than written as undefined, so taking a repo
 * that has a README but no LICENSE leaves the local licence alone.
 */
export function entityDocsChanges(remote: EntityDocs): EntityDocs {
  const changes: EntityDocs = {}
  if (remote.readme) changes.readme = remote.readme
  if (remote.license) changes.license = remote.license
  return changes
}
