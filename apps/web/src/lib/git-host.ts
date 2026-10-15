/** Host (with a non-default port) of an https or scp-style git URL, or null. */
export function gitUrlHost(url: string): string | null {
  const raw = url.trim()
  try {
    const host = new URL(raw).host
    if (host) return host
  } catch {
    /* not a URL: maybe scp-style */
  }
  // scp-style `[user@]host:path` — which `new URL` misreads as a `host:` scheme.
  return /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)/.exec(raw)?.[1] ?? null
}

/** A private repo is unreachable until the account holds a token for its host, or one is typed. */
export function privateTokenMissing(isPrivate: boolean, token: string, hasToken: boolean | null): boolean {
  return isPrivate && !token.trim() && hasToken !== true
}
