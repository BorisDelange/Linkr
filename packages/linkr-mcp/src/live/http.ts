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
 *   LINKR_MCP_LOG_ARGS=1  also log each tool call's arguments (may hold patient data)
 */
import { createServer, type IncomingMessage } from 'node:http'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createIdentify, keyTag, presentedKey, toolCallLogLines } from './auth.js'
import './env.js'

const { buildServer } = await import('./build.js')
const { withApiToken } = await import('./shared.js')

const apiUrl = process.env.LINKR_API_URL?.replace(/\/+$/, '')
if (!apiUrl) {
  console.error('LINKR_API_URL is not set — see packages/linkr-mcp/.env.example.')
  process.exit(1)
}
let identify: ReturnType<typeof createIdentify>
try {
  identify = createIdentify({ apiUrl, sharedKey: process.env.LINKR_MCP_KEY })
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
const port = Number(process.env.LINKR_MCP_PORT ?? 3940)
const host = process.env.LINKR_MCP_HOST ?? '127.0.0.1'

const handler = createMcpHandler(() => buildServer())
const logArgs = process.env.LINKR_MCP_LOG_ARGS === '1'
const MAX_BODY_BYTES = 4 * 1024 * 1024

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new BodyTooLarge()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
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
    let body: string | undefined
    try {
      body = hasBody ? await readBody(req) : undefined
    } catch (e) {
      if (!(e instanceof BodyTooLarge)) throw e
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
        .end('{"error":"request body too large"}')
      req.destroy()
      return
    }
    if (body) {
      for (const line of toolCallLogLines(body, keyTag(presentedKey(headers)), logArgs)) console.error(line)
    }
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
