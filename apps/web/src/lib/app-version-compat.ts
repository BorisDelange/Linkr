/**
 * Refuse a tree this importer must not read: one written for a newer Linkr, or
 * one holding another kind of entity.
 *
 * The readers are tolerant on purpose, so an entity whose structure changed after
 * this build does not fail to import — it lands empty or half-read, and nothing
 * says why. Every manifest of a kind whose structure changed carries
 * `minAppVersion` (see `MIN_APP_VERSION` in @linkr/format); this reads them all,
 * nested ones included (a workspace ZIP embeds its children), and throws before
 * anything is written.
 */
import type JSZip from 'jszip'
import { compareVersions, ENTITY_MANIFEST, isAppTooOld, isEntityType, MANIFEST, type LayoutKind } from '@linkr/format'
import i18n from '@/lib/i18n'
import { APP_VERSION } from '@/lib/version'

const MANIFEST_NAMES = new Set<string>([ENTITY_MANIFEST, ...Object.values(MANIFEST)])

export class IncompatibleAppVersionError extends Error {
  readonly required: string
  readonly current: string

  constructor(required: string, current: string = APP_VERSION) {
    super(i18n.t('common.import_app_too_old', { required, current }))
    this.name = 'IncompatibleAppVersionError'
    this.required = required
    this.current = current
  }
}

/** The highest `minAppVersion` a manifest in the ZIP declares, or null. */
export async function requiredAppVersion(zip: JSZip): Promise<string | null> {
  let highest: string | null = null
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !MANIFEST_NAMES.has(path.split('/').pop() ?? '')) continue
    const text = await entry.async('string')
    // A record list sharing a manifest's name (a mapping project's mappings.json
    // can run to megabytes) carries no stamp: not worth parsing.
    if (text.trimStart().startsWith('[')) continue
    let meta: unknown
    try {
      meta = JSON.parse(text)
    } catch {
      continue
    }
    const min = (meta as { minAppVersion?: unknown } | null)?.minAppVersion
    if (typeof min === 'string' && min.trim() && (!highest || compareVersions(min, highest) > 0)) highest = min
  }
  return highest
}

export async function assertAppVersionSupported(zip: JSZip): Promise<void> {
  const required = await requiredAppVersion(zip)
  if (required && isAppTooOld(required, APP_VERSION)) throw new IncompatibleAppVersionError(required)
}

/** An entity type's display name, as the catalog labels it; the raw type when unlabelled. */
function typeLabel(type: string): string {
  const key = `catalog.type_${type.replace(/-/g, '_')}`
  return i18n.exists(key) ? i18n.t(key) : type
}

/**
 * A tree that declares another kind than the importer expects — a schema dropped
 * on the Projects page. The readers accept any manifest carrying an id, so without
 * this the schema imported as an empty project.
 */
export class WrongEntityTypeError extends Error {
  readonly found: string
  readonly expected: string

  constructor(found: string, expected: string) {
    super(i18n.t('common.import_wrong_type', { found: typeLabel(found), expected: typeLabel(expected) }))
    this.name = 'WrongEntityTypeError'
    this.found = found
    this.expected = expected
  }
}

/**
 * A ZIP holding no manifest the importer can read for `expected`: not an export
 * of that kind at all. Thrown rather than returned, so the import dialog shows it
 * instead of closing as if something had been imported.
 */
export class MissingManifestError extends Error {
  readonly expected: string

  constructor(expected: string) {
    super(i18n.t('common.import_no_manifest', { expected: typeLabel(expected) }))
    this.name = 'MissingManifestError'
    this.expected = expected
  }
}

/**
 * Throw when a manifest declares a known entity type other than `expected`. A
 * manifest with no `type` (trees exported before it was written) passes.
 */
export function assertEntityType(meta: unknown, expected: LayoutKind): void {
  const found = (meta as { type?: unknown } | null)?.type
  if (isEntityType(found) && found !== expected) throw new WrongEntityTypeError(found, expected)
}
