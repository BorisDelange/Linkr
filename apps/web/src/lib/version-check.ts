/**
 * App version detection for deployed builds.
 *
 * Two independent version signals:
 * - __APP_BUILD_HASH__ (git short hash, injected by Vite) — detects any new deployment
 * - APP_SCHEMA_VERSION (manual integer) — detects breaking IndexedDB/store schema changes
 *
 * These are complementary to the DEMO_*_VERSION constants in demo-seed.ts,
 * which handle silent re-seeding of demo content without a full reset.
 */

/** Increment this when IndexedDB schema or Zustand store shapes change in a breaking way. */
export const APP_SCHEMA_VERSION = 1

const BUILD_HASH_KEY = 'linkr-app-build-hash'
const SCHEMA_VERSION_KEY = 'linkr-app-schema-version'
const PENDING_RESET_KEY = 'linkr-pending-reset'

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
export async function executePendingReset(): Promise<boolean> {
  if (localStorage.getItem(PENDING_RESET_KEY) !== '1') return false

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

  localStorage.clear()
  return true
}

/** Store current version info in localStorage (call after user acknowledges or on first visit). */
export function acknowledgeVersion(): void {
  localStorage.setItem(BUILD_HASH_KEY, __APP_BUILD_HASH__)
  localStorage.setItem(SCHEMA_VERSION_KEY, String(APP_SCHEMA_VERSION))
}
