/**
 * The remotes a published tree may ask to be cloned. Its `git-links.json` is
 * untrusted: only https, ssh:// or scp-style `user@host:path`, the forms a host
 * check reads the way git does.
 */
const SCP_REMOTE = /^[\w.+-]+@[\w.-]+:(?!\/\/)\S+$/

export function isCloneableRemoteUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  return /^https:\/\/[^\s]+$/i.test(url) || /^ssh:\/\/[^\s]+$/i.test(url) || SCP_REMOTE.test(url)
}

/** A branch or tag name: never an option, a refspec or a range to git. */
export function isSafeGitRef(ref: unknown): ref is string {
  return typeof ref === 'string' && /^\w[\w./-]*$/.test(ref) && !ref.includes('..')
}

/**
 * The LFS endpoint git-lfs derives from `remoteUrl` itself: `<repo>.git/info/lfs`
 * for an https remote, the remote as written otherwise. Pinned on `git lfs` calls,
 * since a committed `.lfsconfig` can name any other.
 */
export function lfsEndpoint(remoteUrl: string): string {
  if (!/^https?:\/\//i.test(remoteUrl)) return remoteUrl
  const url = new URL(remoteUrl)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = `${path.endsWith('.git') ? path : `${path}.git`}/info/lfs`
  url.search = ''
  url.hash = ''
  return url.toString()
}
