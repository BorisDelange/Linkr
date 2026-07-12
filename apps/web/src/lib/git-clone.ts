/**
 * Best-effort in-browser git clone for git-linked entities.
 *
 * Browsers cannot reach `https://host/repo.git` directly (the git HTTP endpoints
 * don't send CORS headers), so isomorphic-git needs a CORS proxy. We never ship a
 * default third-party proxy — that would route the user's (possibly private health)
 * data through someone else's server. The proxy URL is opt-in via settings; when it
 * is empty, cloning is disabled and callers fall back to "metadata only".
 *
 * Everything here is dynamically imported so isomorphic-git stays out of the main bundle.
 */
import JSZip from 'jszip'

const PROXY_KEY = 'linkr-git-cors-proxy'

/**
 * Default CORS proxy. Most linked repos are public, so a sensible default lets cloning
 * work out of the box. Users handling private health data should point this at their own
 * proxy (or clear it) — see the import dialog hint.
 */
export const DEFAULT_GIT_CORS_PROXY = 'https://cors.isomorphic-git.org'

/** The configured CORS proxy URL, falling back to the default when the user hasn't set one. */
export function getGitCorsProxy(): string {
  try {
    const stored = localStorage.getItem(PROXY_KEY)
    // null = never set → default; '' = explicitly cleared → disabled.
    if (stored === null) return DEFAULT_GIT_CORS_PROXY
    return stored.trim()
  } catch {
    return DEFAULT_GIT_CORS_PROXY
  }
}

export function setGitCorsProxy(url: string): void {
  try {
    // Store the value verbatim — '' is a meaningful "disabled" state (distinct from "never set").
    localStorage.setItem(PROXY_KEY, url.trim())
  } catch {
    // ignore storage errors (private mode etc.)
  }
}

/** Whether a clone can even be attempted (a CORS proxy is configured). */
export function canCloneFromGit(): boolean {
  return getGitCorsProxy().length > 0
}

export interface CloneOptions {
  url: string
  branch?: string
  /** Optional auth token for private repos (sent as the HTTP password). */
  token?: string
}

/** Classify a clone failure into a stable code so the UI can show a helpful message. */
export type CloneErrorKind = 'proxy' | 'auth' | 'not_found' | 'ref' | 'network' | 'unknown'

export function classifyCloneError(err: unknown): CloneErrorKind {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('cors') || msg.includes('access-control') || msg.includes('failed to fetch') || msg.includes('networkerror')) {
    // The proxy itself is down/unreachable, or never reached (CORS) — almost always the proxy.
    return 'proxy'
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('auth')) return 'auth'
  if (msg.includes('404') || msg.includes('not found') || msg.includes('could not find repo')) return 'not_found'
  if (msg.includes('ref') || msg.includes('branch')) return 'ref'
  if (msg.includes('network')) return 'network'
  return 'unknown'
}

/**
 * Clone a repo into an ephemeral in-memory filesystem and return its files as a JSZip,
 * so callers can reuse the existing ZIP parsers (parseProjectZip, tree readers, …).
 * Throws on failure (network, CORS, auth, bad ref) — callers should catch and degrade.
 */
/**
/**
 * Strip the browser-navigation cruft users paste from a repo web page, leaving
 * the bare clone URL. Handles:
 *  - GitLab/framagit `…/repo/-/tree/main`, `…/-/blob/…`, `…/-/merge_requests/…`
 *    (everything from the `/-/` separator on is navigation; subgroups keep it robust)
 *  - GitHub `…/repo/tree/main`, `/blob/…`, `/commit/…`, `/pull/…`, `/releases/…`
 *  - any query string / fragment (`?ref_type=heads`, `#readme`)
 * SSH-style URLs (git@host:path) are left untouched.
 */
export function cleanGitUrl(raw: string): string {
  let url = raw.trim()
  if (!url || !/^https?:\/\//i.test(url)) return url
  // Drop query + fragment.
  url = url.split(/[?#]/, 1)[0]
  // GitLab: cut at the `/-/` navigation separator.
  const gitlabCut = url.indexOf('/-/')
  if (gitlabCut !== -1) url = url.slice(0, gitlabCut)
  // GitHub-style: cut at a known navigation segment.
  url = url.replace(/\/(?:tree|blob|commit|commits|pull|pulls|releases|tags|branches|find|raw)\/.*$/i, '')
  return url.replace(/\/+$/, '')
}

/**
 * Normalize a clone URL: strip web-navigation parts, drop a trailing slash and
 * append `.git` when it's missing. Many hosts (GitLab/framagit, GitHub)
 * 301-redirect `…/repo` → `…/repo.git`; adding it up front avoids the redirect
 * entirely and works even on hosts that don't redirect.
 */
export function normalizeGitUrl(raw: string): string {
  let url = cleanGitUrl(raw)
  if (!url) return url
  // Only touch http(s) URLs; leave SSH-style (git@host:path) alone.
  if (/^https?:\/\//i.test(url) && !/\.git$/i.test(url)) {
    url += '.git'
  }
  return url
}

export async function cloneRepoToZip(opts: CloneOptions): Promise<JSZip> {
  const proxy = getGitCorsProxy()
  if (!proxy) throw new Error('No CORS proxy configured for git clone')

  const url = normalizeGitUrl(opts.url)

  // isomorphic-git needs a global `Buffer`, which browsers don't provide. Polyfill it
  // lazily (only when cloning) so the main bundle isn't affected.
  if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
    const { Buffer } = await import('buffer')
    ;(globalThis as { Buffer?: unknown }).Buffer = Buffer
  }

  const [{ default: git }, { default: http }, { default: LightningFS }] = await Promise.all([
    import('isomorphic-git'),
    import('isomorphic-git/http/web'),
    import('@isomorphic-git/lightning-fs'),
  ])

  // Unique FS name per clone so concurrent/repeat clones don't collide.
  const fsName = `linkr-clone-${url.replace(/[^a-z0-9]/gi, '').slice(-24)}-${Date.now()}`
  const fs = new LightningFS(fsName, { wipe: true })
  const dir = '/repo'

  await git.clone({
    fs,
    http,
    dir,
    url,
    corsProxy: proxy,
    ref: opts.branch || 'main',
    singleBranch: true,
    depth: 1,
    ...(opts.token ? { onAuth: () => ({ username: opts.token, password: 'x-oauth-basic' }) } : {}),
  })

  // Walk the working tree into a JSZip (skip .git).
  const zip = new JSZip()
  const pfs = fs.promises
  async function walk(rel: string): Promise<void> {
    const abs = rel ? `${dir}/${rel}` : dir
    const entries: string[] = await pfs.readdir(abs)
    for (const name of entries) {
      if (name === '.git') continue
      const childRel = rel ? `${rel}/${name}` : name
      const stat = await pfs.stat(`${dir}/${childRel}`)
      if (stat.isDirectory()) {
        await walk(childRel)
      } else {
        const data: Uint8Array = await pfs.readFile(`${dir}/${childRel}`)
        zip.file(childRel, data)
      }
    }
  }
  await walk('')
  return zip
}
