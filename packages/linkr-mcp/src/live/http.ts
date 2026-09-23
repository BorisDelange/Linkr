#!/usr/bin/env -S npx tsx
/**
 * `linkr` over streamable HTTP, for clients that take a URL — LibreChat, Claude
 * Desktop, Cursor. Same tools as the stdio entry (`server.ts`).
 *
 * Local-machine setup for now: it acts as the one user of packages/linkr-mcp/.env
 * and answers only requests carrying LINKR_MCP_KEY (as `Authorization: Bearer …`
 * or `X-API-Key: …`). Per-user tokens are the ApiToken step of the plan
 * (docs/planning/ai-agents-plan.md §4b).
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

const key = process.env.LINKR_MCP_KEY
if (!key || key.length < 24) {
  console.error('LINKR_MCP_KEY is missing or shorter than 24 characters — see packages/linkr-mcp/.env.example.')
  process.exit(1)
}
const port = Number(process.env.LINKR_MCP_PORT ?? 3940)
const host = process.env.LINKR_MCP_HOST ?? '127.0.0.1'

const handler = createMcpHandler(() => buildServer())

function authorized(headers: Headers): boolean {
  const given = headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(key!)
  return a.length === b.length && timingSafeEqual(a, b)
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
    if (!authorized(headers)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"invalid or missing key"}')
      return
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const body = hasBody ? await new Response(Readable.toWeb(req) as ReadableStream).text() : undefined
    if (body) logToolCalls(body)
    const request = new Request(url, { method: req.method, headers, body })
    const response = await handler.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (!response.body) {
      res.end()
      return
    }
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
    res.end()
  } catch (e) {
    console.error(e)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
}).listen(port, host, () => {
  console.error(`linkr MCP (live) on http://${host}:${port}/mcp`)
})
