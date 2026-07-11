/**
 * App version detection for deployed builds.
 *
 * Two independent version signals:
 * - __APP_BUILD_HASH__ (git short hash, injected by Vite) — detects any new deployment
 * - APP_SCHEMA_VERSION (manual integer) — detects breaking IndexedDB/store schema changes
 *
 * Seed content updates are handled separately by the seed change detector
 * (seed-change-detector.ts), which re-seeds bundled content without a full reset.
 */

/** Increment this when IndexedDB schema or Zustand store shapes change in a breaking way. */
export const APP_SCHEMA_VERSION = 1

const BUILD_HASH_KEY = 'linkr-app-build-hash'
const SCHEMA_VERSION_KEY = 'linkr-app-schema-version'
const PENDING_RESET_KEY = 'linkr-pending-reset'
const SERVER_IDB_PURGED_KEY = 'linkr-server-idb-purged'

export type VersionStatus =
  | { kind: 'up-to-date' }
  | { kind: 'new-build'; schemaChanged: boolean }
  | { kind: 'first-visit' }

export function checkVersion(): VersionStatus {
  // Allow forcing in dev: ?force-version-check or ?force-version-check=schema
  const params = new URLSearchParams(window.location.search)
  const forceCheck = params.get('force-version-check')
  if (forceCheck !== null) {
    return { kind: 'new-build', schemaChanged: forceCheck === 'schema' }
  }

  const storedHash = localStorage.getItem(BUILD_HASH_KEY)
  const storedSchema = localStorage.getItem(SCHEMA_VERSION_KEY)

  // First visit — no stored hash at all
  if (!storedHash) {
    return { kind: 'first-visit' }
  }

  const currentHash = __APP_BUILD_HASH__
  const currentSchema = APP_SCHEMA_VERSION

  if (storedHash === currentHash) {
    return { kind: 'up-to-date' }
  }

  const schemaChanged = storedSchema !== null && parseInt(storedSchema, 10) !== currentSchema

  return { kind: 'new-build', schemaChanged }
}

/**
 * Request a full data reset. Sets a flag in localStorage, then navigates to '/'.
 * The actual deletion happens on next boot via `executePendingReset()`,
 * before any IDB connection is opened — so deleteDatabase is never blocked
 * by the current tab. Other tabs auto-close via the `versionchange` listener
 * in idb-storage.ts.
 */
export function clearAllData(): void {
  localStorage.setItem(PENDING_RESET_KEY, '1')
  window.location.href = '/'
}

/**
 * If a reset was requested, delete all IDB databases and clear localStorage.
 * Must be called at app startup BEFORE opening any IDB connection.
 */
async function deleteAllIndexedDbs(): Promise<void> {
  try {
    const databases = await indexedDB.databases()
    await Promise.all(
      databases
        .filter((db) => db.name)
        .map((db) => new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(db.name!)
          req.onsuccess = () => resolve()
          req.onerror = () => resolve()
          req.onblocked = () => resolve()
        })),
    )
  } catch {
    // indexedDB.databases() not supported in all browsers — best effort
  }
}

export async function executePendingReset(): Promise<boolean> {
  if (localStorage.getItem(PENDING_RESET_KEY) !== '1') return false
  await deleteAllIndexedDbs()
  localStorage.clear()
  return true
}

/**
 * One-time purge of residual client-only IndexedDB when the app runs in
 * server mode. Data lives on the server there; a leftover local database from
 * a previous client-only run would otherwise serve stale entities for whichever
 * stores aren't API-backed yet, producing a confusing hybrid state.
 *
 * Runs at most once (guarded by a localStorage flag) and never touches
 * localStorage otherwise, so the auth token / theme survive. Must be called at
 * startup BEFORE opening any IDB connection.
 */
export async function purgeStaleLocalDataForServerMode(serverMode: boolean): Promise<boolean> {
  if (!serverMode) return false
  if (localStorage.getItem(SERVER_IDB_PURGED_KEY) === '1') return false

  let purged = false
  try {
    const databases = await indexedDB.databases()
    if (databases.some((db) => db.name)) {
      await deleteAllIndexedDbs()
      purged = true
    }
  } catch {
    // indexedDB.databases() unsupported — best effort; still set the flag below.
  }

  localStorage.setItem(SERVER_IDB_PURGED_KEY, '1')
  return purged
}

/** Store current version info in localStorage (call after user acknowledges or on first visit). */
export function acknowledgeVersion(): void {
  localStorage.setItem(BUILD_HASH_KEY, __APP_BUILD_HASH__)
  localStorage.setItem(SCHEMA_VERSION_KEY, String(APP_SCHEMA_VERSION))
}
