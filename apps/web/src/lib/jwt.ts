/** The `sub` claim of a JWT, read without verifying it — only to tell whether two
 *  tokens belong to the same user. Null when the token is absent or unreadable. */
export function jwtSubject(token: string | null | undefined): string | null {
  const payload = token?.split('.')[1]
  if (!payload) return null
  try {
    const sub = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).sub
    return sub == null ? null : String(sub)
  } catch {
    return null
  }
}
