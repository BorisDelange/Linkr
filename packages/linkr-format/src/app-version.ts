/**
 * The oldest Linkr able to read an entity, per kind.
 *
 * `appVersion` says which version WROTE a file; it cannot say which versions can
 * READ it — most exports stay readable by older apps, so refusing every newer
 * `appVersion` would block trees that would import fine. When a kind's structure
 * changes in a way an older reader would misread (silently: the reads are
 * tolerant), its entry here is raised to the first release carrying the change,
 * and every export of that kind stamps `minAppVersion`. Readers refuse a tree
 * whose `minAppVersion` is above their own version, and the catalog greys the
 * entry out.
 *
 * Twin of `MIN_APP_VERSION` in apps/api/app/export_version.py — change both.
 */
import type { LayoutKind } from './layout.js'

export const MIN_APP_VERSION: Partial<Record<LayoutKind, string>> = {
  // mapping.json v2: relations instead of event tables, database overrides with a
  // `removed` list. A 2.4.2 reads the file as an empty mapping.
  'schema-preset': '2.4.3',
}

/**
 * Compare two `X.Y.Z` versions numerically (`2.10.0` > `2.9.0`). A pre-release or
 * build suffix is ignored, and a missing segment reads as 0.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[-+]/)[0]!.split('.').map((n) => parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/**
 * The `minAppVersion` to stamp on an export of `kind` written by `appVersion`, or
 * undefined when the kind declares none.
 *
 * Capped at the writer's own version: a tree is always readable by the app that
 * wrote it. Without the cap, a development build still numbered before the
 * release that introduces a change would refuse its own exports; with it, the
 * stamp follows `VERSION` up to the declared minimum once that release is cut.
 */
export function minAppVersionFor(kind: LayoutKind, appVersion: string): string | undefined {
  const declared = MIN_APP_VERSION[kind]
  if (!declared) return undefined
  return compareVersions(declared, appVersion) > 0 ? appVersion : declared
}

/** Whether an app at `appVersion` is too old for a tree requiring `minAppVersion`. */
export function isAppTooOld(minAppVersion: unknown, appVersion: string): boolean {
  return typeof minAppVersion === 'string' && minAppVersion.trim() !== ''
    && compareVersions(minAppVersion, appVersion) > 0
}
