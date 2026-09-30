/**
 * Refuse a tree written for a newer Linkr than this one.
 *
 * The readers are tolerant on purpose, so an entity whose structure changed after
 * this build does not fail to import — it lands empty or half-read, and nothing
 * says why. Every manifest of a kind whose structure changed carries
 * `minAppVersion` (see `MIN_APP_VERSION` in @linkr/format); this reads them all,
 * nested ones included (a workspace ZIP embeds its children), and throws before
 * anything is written.
 */
import type JSZip from 'jszip'
import { compareVersions, ENTITY_MANIFEST, isAppTooOld, MANIFEST } from '@linkr/format'
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
    let meta: unknown
    try {
      meta = JSON.parse(await entry.async('string'))
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
