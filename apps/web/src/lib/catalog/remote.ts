/**
 * Fetch the community catalog and diff it against what we already have.
 *
 * Files are read through the **GitLab API v4** raw-file route, not `/-/raw/`: only the
 * API route sends `access-control-allow-origin: *` (verified on framagit), so the catalog
 * works in the static/WASM build with no backend and no CORS proxy. The `/-/raw/` route
 * has no CORS header and a 60/min limit; the API route allows 500/min.
 *
 * Reading the catalog needs no token — the index repo is public. Only *installing* an
 * entry needs the backend (a git clone), which is gated separately.
 */

import type { CatalogCache, CatalogDiff, CatalogFile, CatalogIndexFile } from './types'

/** The community catalog, used unless the user points Settings at another repo. */
export const DEFAULT_CATALOG_URL = 'https://framagit.org/interhop/linkr/linkr-catalog'
export const DEFAULT_CATALOG_BRANCH = 'main'

/** The schemaVersion this client understands; a newer file asks the user to update Linkr. */
export const CATALOG_SCHEMA_VERSION = 1

/** A catalog repo resolved into the pieces needed to build API URLs. */
export interface CatalogSource {
  /** Web URL of the index repo, as configured. */
  repoUrl: string
  host: string
  /** Project path (`group/subgroup/repo`), un-encoded. */
  project: string
  branch: string
}

/**
 * Parse a catalog repo URL. Any GitLab instance works (gitlab.com, framagit.org,
 * self-hosted) since the API shape is identical; GitHub is deliberately unsupported —
 * its raw-file API differs, and no one has asked for it yet.
 */
export function parseCatalogUrl(raw: string, branch = DEFAULT_CATALOG_BRANCH): CatalogSource | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const project = url.pathname
    .replace(/^\/+|\/+$/g, '')
    // Tolerate a pasted repo page URL (`…/-/tree/main`) and a `.git` clone URL.
    .replace(/\/-\/.*$/, '')
    .replace(/\.git$/, '')
  if (!project || !project.includes('/')) return null
  return { repoUrl: `https://${url.host}/${project}`, host: url.host, project, branch: branch.trim() || DEFAULT_CATALOG_BRANCH }
}

export const DEFAULT_CATALOG_SOURCE = parseCatalogUrl(DEFAULT_CATALOG_URL)!

/**
 * Build the raw-file URL for a catalog file.
 *
 * Uses the GitLab API v4 route — NOT `/-/raw/`. Only the API route sends
 * `access-control-allow-origin: *`, which is what makes the catalog readable from the
 * static/WASM build with no backend.
 */
export function catalogFileUrl(source: CatalogSource, file: string): string {
  const project = encodeURIComponent(source.project)
  return `https://${source.host}/api/v4/projects/${project}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(source.branch)}`
}

/** Distinguishes "no network / blocked" from "the file is not what we expect". */
export type CatalogFetchError = 'network' | 'not-found' | 'malformed' | 'unsupported-version'

export class CatalogError extends Error {
  constructor(readonly kind: CatalogFetchError, message?: string) {
    super(message ?? kind)
    this.name = 'CatalogError'
  }
}

async function fetchJson<T>(source: CatalogSource, file: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(catalogFileUrl(source, file), { headers: { accept: 'application/json' } })
  } catch {
    // Offline, DNS failure, or a corporate proxy blocking framagit.
    throw new CatalogError('network')
  }
  if (res.status === 404) throw new CatalogError('not-found')
  if (!res.ok) throw new CatalogError('network', `HTTP ${res.status}`)
  try {
    return (await res.json()) as T
  } catch {
    throw new CatalogError('malformed')
  }
}

function assertVersion(schemaVersion: unknown): void {
  if (typeof schemaVersion !== 'number') throw new CatalogError('malformed')
  // A newer catalog format than this build knows: refuse rather than silently
  // rendering entries whose fields we may misread.
  if (schemaVersion > CATALOG_SCHEMA_VERSION) throw new CatalogError('unsupported-version')
}

/** Fetch the light index (~2 KB) — used to check for updates without downloading everything. */
export async function fetchCatalogIndex(
  source: CatalogSource = DEFAULT_CATALOG_SOURCE,
): Promise<CatalogIndexFile> {
  const index = await fetchJson<CatalogIndexFile>(source, 'catalog-index.json')
  assertVersion(index?.schemaVersion)
  if (!index.contentHash || typeof index.hashes !== 'object' || index.hashes === null) {
    throw new CatalogError('malformed')
  }
  return index
}

/** Fetch the full catalog. */
export async function fetchCatalog(
  source: CatalogSource = DEFAULT_CATALOG_SOURCE,
): Promise<CatalogFile> {
  const catalog = await fetchJson<CatalogFile>(source, 'catalog.json')
  assertVersion(catalog?.schemaVersion)
  if (!Array.isArray(catalog.entries) || !catalog.contentHash) throw new CatalogError('malformed')
  // Drop entries this build can't act on (e.g. a type added by a newer catalog) instead
  // of failing the whole fetch — one unknown entry shouldn't hide the other 50.
  const entries = catalog.entries.filter(
    (e) => e && typeof e.id === 'string' && typeof e.type === 'string' && e.git?.url,
  )
  return { ...catalog, entries }
}

/**
 * Compare a fetched index against the cached state.
 *
 * Diffing per-entry hashes (not just `contentHash`) is what lets the UI say
 * "3 new, 1 updated" instead of a bare "something changed".
 */
export function diffCatalog(
  cache: Pick<CatalogCache, 'hashes'> | null,
  index: Pick<CatalogIndexFile, 'hashes'>,
): CatalogDiff {
  const prev = cache?.hashes ?? {}
  const next = index.hashes ?? {}
  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []

  for (const [id, hash] of Object.entries(next)) {
    if (!(id in prev)) added.push(id)
    else if (prev[id] !== hash) modified.push(id)
  }
  for (const id of Object.keys(prev)) {
    if (!(id in next)) removed.push(id)
  }

  added.sort()
  modified.sort()
  removed.sort()
  return { changed: added.length + modified.length + removed.length > 0, added, modified, removed }
}

/** Build the cache record to persist after a successful full fetch. */
export function toCache(catalog: CatalogFile, index: CatalogIndexFile | null, now: string): CatalogCache {
  return {
    fetchedAt: now,
    contentHash: catalog.contentHash,
    generatedAt: catalog.generatedAt,
    entries: catalog.entries,
    // Prefer the index's hashes; fall back to an empty map so a later diff simply
    // reports everything as added rather than throwing.
    hashes: index?.hashes ?? {},
  }
}
