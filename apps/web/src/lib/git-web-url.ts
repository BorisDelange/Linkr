/**
 * A git remote's browsable web page, or null when it has none.
 *
 * A clone URL is not always something a browser can open: the same repo is
 * addressed as `https://host/group/repo`, `https://host/group/repo.git` or
 * `git@host:group/repo.git`, and only the first is a page. This normalises the
 * forms that map cleanly onto one and refuses the rest.
 *
 * Used by the "content not imported" badge in client-only mode, where there is
 * no git client to retry a clone with — reading the linked repo is the only
 * action left, so the badge becomes a link to it.
 *
 * Credentials are stripped: a remote may carry a token (`https://user:tok@host/…`),
 * and putting that in an `href` would leak it into the browser's history, the
 * referrer and any shoulder-surfer's view of the status bar.
 */
export function webRepoUrl(raw: string | undefined | null): string | null {
  const url = (raw ?? '').trim()
  if (!url) return null

  // scp-like SSH (`git@host:group/repo.git`) — the one non-URL form git accepts.
  // No scheme, so it must be recognised before parsing.
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url)
  if (scp) {
    const path = scp[2].replace(/\.git$/, '').replace(/^\/+/, '')
    return path ? `https://${scp[1]}/${path}` : null
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  // ssh:// and git:// name the same repo a web host serves over https.
  const scheme = parsed.protocol.replace(/:$/, '')
  if (!['http', 'https', 'ssh', 'git'].includes(scheme)) return null
  if (!parsed.hostname) return null

  const path = parsed.pathname.replace(/\.git$/, '').replace(/\/+$/, '')
  if (!path || path === '/') return null

  // Never carry credentials, a query or a fragment into the page link.
  return `${scheme === 'http' ? 'http' : 'https'}://${parsed.host}${path}`
}
