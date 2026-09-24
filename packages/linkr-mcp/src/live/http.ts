#!/usr/bin/env -S npx tsx
/**
 * `linkr` over streamable HTTP, for clients that take a URL — LibreChat, Claude
 * Desktop, Cursor. Same tools as the stdio entry (`server.ts`).
 *
 * Each request authenticates as a Linkr user with a personal API key (`lnk_…`,
 * Profile → API keys), sent as `Authorization: Bearer …` or `X-API-Key: …`: the
 * tools then act with that user's permissions. In LibreChat, tick "each user
 * provides their own key". The key is checked against Linkr (cached a minute).
 *
 * Optional single-user mode: a request carrying LINKR_MCP_KEY acts with the
 * credentials of packages/linkr-mcp/.env instead.
 *
 *   LINKR_MCP_PORT  default 3940
 *   LINKR_MCP_HOST  default 127.0.0.1 — keep it on loopback unless a proxy with TLS fronts it
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { timingSafeEqual } from 'node:crypto'
import { createMcpHandler } from '@modelcontextprotocol/server'
import './env.js'

const { buildServer } = await import('./build.js')
const { withApiToken } = await import('./shared.js')

const apiUrl = process.env.LINKR_API_URL?.replace(/\/+$/, '')
if (!apiUrl) {
  console.error('LINKR_API_URL is not set — see packages/linkr-mcp/.env.example.')
  process.exit(1)
}
const key = process.env.LINKR_MCP_KEY
if (key && key.length < 24) {
  console.error('LINKR_MCP_KEY is shorter than 24 characters — see packages/linkr-mcp/.env.example.')
  process.exit(1)
}
const port = Number(process.env.LINKR_MCP_PORT ?? 3940)
const host = process.env.LINKR_MCP_HOST ?? '127.0.0.1'

const handler = createMcpHandler(() => buildServer())

const verified = new Map<string, number>()
const VERIFY_TTL_MS = 60_000

/** Whether Linkr accepts this personal key — revoked or expired keys stop working
 *  within a minute. */
async function linkrAccepts(token: string): Promise<boolean> {
  if ((verified.get(token) ?? 0) > Date.now()) return true
  const res = await fetch(`${apiUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    verified.delete(token)
    return false
  }
  verified.set(token, Date.now() + VERIFY_TTL_MS)
  return true
}

function isSharedKey(given: string): boolean {
  if (!key) return false
  const a = Buffer.from(given)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** How to serve this request: as the owner of a personal key, with the .env
 *  credentials (shared key), or not at all. */
async function identify(headers: Headers): Promise<'env' | { token: string } | null> {
  const given = headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (given.startsWith('lnk_')) return (await linkrAccepts(given)) ? { token: given } : null
  return isSharedKey(given) ? 'env' : null
}

/** One stderr line per tool call, so a session can be followed from the terminal. */
function logToolCalls(body: string) {
  try {
    const parsed = JSON.parse(body) as unknown
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      const m = msg as { method?: string; params?: { name?: string; arguments?: unknown } }
      if (m.method !== 'tools/call') continue
      const args = JSON.stringify(m.params?.arguments ?? {})
      console.error(`${new Date().toLocaleTimeString()} ${m.params?.name} ${args.length > 200 ? `${args.slice(0, 200)}…` : args}`)
    }
  } catch { /* not JSON: the handler reports it */ }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    const who = await identify(headers)
    if (!who) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
        .end('{"error":"invalid, revoked or missing Linkr API key"}')
      return
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const body = hasBody ? await new Response(Readable.toWeb(req) as ReadableStream).text() : undefined
    if (body) logToolCalls(body)
    const request = new Request(url, { method: req.method, headers, body })
    const serve = async () => {
      const response = await handler.fetch(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body) {
        res.end()
        return
      }
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
      res.end()
    }
    await (who === 'env' ? serve() : withApiToken(who.token, serve))
  } catch (e) {
    console.error(e)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
}).listen(port, host, () => {
  console.error(`linkr MCP (live) on http://${host}:${port}/mcp`)
})
