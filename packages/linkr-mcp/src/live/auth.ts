import { createHash, timingSafeEqual } from 'node:crypto'

export const MIN_SHARED_KEY_LENGTH = 24

export type Caller = 'env' | { token: string }

export interface IdentifyOptions {
  apiUrl: string
  /** LINKR_MCP_KEY: unset disables single-user mode rather than accepting anything. */
  sharedKey?: string
  ttlMs?: number
  timeoutMs?: number
  fetch?: typeof fetch
}

export function presentedKey(headers: Headers): string {
  return headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
}

export function isSharedKey(given: string, sharedKey: string | undefined): boolean {
  if (!sharedKey) return false
  const a = Buffer.from(given)
  const b = Buffer.from(sharedKey)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** How to serve a request: as the owner of a personal key (checked against Linkr,
 *  cached `ttlMs`, so a revoked key stops working within that delay), with the .env
 *  credentials (shared key), or not at all. Rejects when Linkr does not answer. */
export function createIdentify(options: IdentifyOptions): (headers: Headers) => Promise<Caller | null> {
  const { apiUrl, sharedKey, ttlMs = 60_000, timeoutMs = 5000 } = options
  if (sharedKey && sharedKey.length < MIN_SHARED_KEY_LENGTH) {
    throw new Error(`LINKR_MCP_KEY is shorter than ${MIN_SHARED_KEY_LENGTH} characters — see packages/linkr-mcp/.env.example.`)
  }
  const doFetch = options.fetch ?? fetch
  const verified = new Map<string, number>()

  async function linkrAccepts(token: string): Promise<boolean> {
    if ((verified.get(token) ?? 0) > Date.now()) return true
    const res = await doFetch(`${apiUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      verified.delete(token)
      return false
    }
    verified.set(token, Date.now() + ttlMs)
    return true
  }

  return async (headers) => {
    const given = presentedKey(headers)
    if (given.startsWith('lnk_')) return (await linkrAccepts(given)) ? { token: given } : null
    return isSharedKey(given, sharedKey) ? 'env' : null
  }
}

/** Tells callers apart in the logs without writing their key there. */
export function keyTag(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

const MAX_LOGGED_ARGS = 200

/** One line per tool call in a JSON-RPC body (single or batch). Arguments can hold
 *  SQL, code or patient ids, so they are left out unless `withArgs`. */
export function toolCallLogLines(body: string, tag: string, withArgs: boolean, time = new Date()): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const lines: string[] = []
  for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
    const m = msg as { method?: string; params?: { name?: string; arguments?: unknown } } | null
    if (m?.method !== 'tools/call') continue
    let line = `${time.toLocaleTimeString()} [${tag}] ${m.params?.name}`
    if (withArgs) {
      const args = JSON.stringify(m.params?.arguments ?? {})
      line += ` ${args.length > MAX_LOGGED_ARGS ? `${args.slice(0, MAX_LOGGED_ARGS)}…` : args}`
    }
    lines.push(line)
  }
  return lines
}
