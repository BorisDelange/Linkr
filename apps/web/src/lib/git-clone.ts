/** Git URL normalization helpers for git-linked entities. */

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
