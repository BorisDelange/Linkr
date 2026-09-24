/**
 * Personal API keys (server mode): let an external client — the `linkr` MCP
 * server in LibreChat or OpenCode — act as the user without a password.
 * Managing them needs a session login; a key cannot list, mint or revoke keys.
 */
import { apiRequest } from '@/lib/api-client'

export interface ApiToken {
  id: string
  name: string
  /** First characters of the secret after `lnk_`, for recognising a key. */
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

/** The creation response: the only time the plaintext key is ever sent. */
export interface CreatedApiToken extends ApiToken {
  token: string
}

export type ApiTokenStatus = 'active' | 'expired' | 'revoked'

export function apiTokenStatus(token: ApiToken, now: Date = new Date()): ApiTokenStatus {
  if (token.revokedAt) return 'revoked'
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= now.getTime()) return 'expired'
  return 'active'
}

export const listApiTokens = () => apiRequest<ApiToken[]>('/auth/api-tokens')

export const createApiToken = (name: string, expiresInDays: number | null) =>
  apiRequest<CreatedApiToken>('/auth/api-tokens', {
    method: 'POST',
    body: JSON.stringify({ name, expiresInDays }),
  })

export const revokeApiToken = (id: string) =>
  apiRequest<ApiToken>(`/auth/api-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
