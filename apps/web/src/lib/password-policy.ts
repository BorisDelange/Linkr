/**
 * The password policy of a local account, as the forms state it before the
 * round trip. The server (`apps/api/app/core/security.py` password_policy_error)
 * is what enforces it; this twin only mirrors the rules it can check alone —
 * the common-password list stays server-side and comes back as an error code.
 */

/** The server's default (LINKR_PASSWORD_MIN_LENGTH) until /setup/status says otherwise. */
export const PASSWORD_MIN_LENGTH = 12
/** bcrypt hashes only the first 72 bytes. */
export const PASSWORD_MAX_BYTES = 72

let minLength = PASSWORD_MIN_LENGTH

export function setPasswordMinLength(n: number): void {
  if (Number.isInteger(n) && n > 0) minLength = n
}

export function getPasswordMinLength(): number {
  return minLength
}

export type PasswordErrorCode =
  | 'password_too_short'
  | 'password_too_long'
  | 'password_is_username'
  | 'password_same_as_current'
  | 'password_common'

export interface PasswordRuleError {
  code: PasswordErrorCode
  /** Interpolation values of the `password_policy.<code>` message. */
  params?: Record<string, number>
}

const CODES = new Set<string>([
  'password_too_short', 'password_too_long', 'password_is_username', 'password_same_as_current', 'password_common',
])

/** Why `password` would be refused, in the server's order, or null. */
export function passwordRuleError(
  password: string,
  { username = '', current }: { username?: string; current?: string } = {},
): PasswordRuleError | null {
  if ([...password].length < minLength) return { code: 'password_too_short', params: { count: minLength } }
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    return { code: 'password_too_long', params: { count: PASSWORD_MAX_BYTES } }
  }
  if (username && password.trim().toLowerCase() === username.trim().toLowerCase()) {
    return { code: 'password_is_username' }
  }
  if (current && password === current) return { code: 'password_same_as_current' }
  return null
}

/**
 * The policy error carried by a refused request — a response body, its raw
 * text (what `ApiError.message` holds), or the error itself — or null when the
 * refusal is about something else.
 */
export function passwordErrorFromApi(source: unknown): PasswordRuleError | null {
  let body = source instanceof Error ? source.message : source
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { return null }
  }
  const detail = (body as { detail?: unknown } | null)?.detail as
    { code?: unknown; minLength?: unknown; maxBytes?: unknown } | undefined
  if (!detail || typeof detail.code !== 'string' || !CODES.has(detail.code)) return null
  const code = detail.code as PasswordErrorCode
  if (code === 'password_too_short' && typeof detail.minLength === 'number') {
    return { code, params: { count: detail.minLength } }
  }
  if (code === 'password_too_long' && typeof detail.maxBytes === 'number') {
    return { code, params: { count: detail.maxBytes } }
  }
  return { code }
}
