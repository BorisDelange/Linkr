#!/usr/bin/env node
/**
 * Minimal CORS proxy for in-browser git clone (isomorphic-git).
 *
 * Browsers can't reach git HTTP endpoints directly (no CORS headers). isomorphic-git
 * rewrites every request to `<proxy>/<host>/<path>`; this server forwards it to
 * `https://<host>/<path>` and adds the CORS headers the browser needs.
 *
 * Zero dependencies — uses Node's built-in http/https, so it works on modern Node
 * (the npm `@isomorphic-git/cors-proxy` package crashes on Node 18+ via undici).
 *
 * Usage:  node scripts/cors-proxy.mjs [port]   (default port 9999)
 * Then set the app's "CORS proxy" field to  http://localhost:9999
 */
import http from 'node:http'
import https from 'node:https'

const PORT = Number(process.argv[2] || process.env.PORT || 9999)

// Headers isomorphic-git expects to be allowed/exposed.
const ALLOW_HEADERS = 'content-type,content-length,accept-encoding,user-agent,cache-control,pragma,authorization,x-requested-with'
const EXPOSE_HEADERS = 'content-type,content-length,content-encoding,accept-ranges'

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS)
  res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin
  if (req.method === 'OPTIONS') {
    setCors(res, origin)
    res.writeHead(204)
    res.end()
    return
  }

  // Path is "/<host>/<rest...>" → forward to https://<host>/<rest...>
  const path = req.url || '/'
  const m = path.match(/^\/([^/]+)\/(.*)$/)
  if (!m) {
    res.writeHead(400)
    res.end('Expected /<host>/<path>')
    return
  }
  const [, host, rest] = m

  // Forward only the headers git needs; drop hop-by-hop and browser-only ones.
  const fwdHeaders = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    if (['host', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding'].includes(lk)) continue
    fwdHeaders[k] = v
  }
  fwdHeaders.host = host
  // Ask upstream for uncompressed bytes — we pipe the body through untouched, so a
  // `content-encoding: gzip` header without us decoding would corrupt git's stream.
  fwdHeaders['accept-encoding'] = 'identity'

  // Buffer the body so we can replay it if we have to follow a redirect (e.g. framagit
  // 301-redirects `…/info/refs` to `….git/info/refs`).
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => forward(host, `/${rest}`, fwdHeaders, Buffer.concat(chunks), 0))

  function forward(h, p, headers, body, depth) {
    if (depth > 5) {
      setCors(res, origin)
      res.writeHead(508)
      res.end('Too many redirects')
      return
    }
    const proxyReq = https.request({ host: h, path: p, method: req.method, headers: { ...headers, host: h } }, (proxyRes) => {
      const status = proxyRes.statusCode || 502
      const loc = proxyRes.headers.location
      // Follow git's "add .git" style redirects transparently.
      if ([301, 302, 303, 307, 308].includes(status) && loc) {
        proxyRes.resume()
        try {
          const u = new URL(loc, `https://${h}${p}`)
          forward(u.host, u.pathname + u.search, headers, body, depth + 1)
        } catch {
          setCors(res, origin); res.writeHead(502); res.end('Bad redirect')
        }
        return
      }
      setCors(res, origin)
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const lk = k.toLowerCase()
        if (lk === 'access-control-allow-origin') continue
        // We requested identity; don't advertise an encoding the body no longer has.
        if (lk === 'content-encoding') continue
        res.setHeader(k, v)
      }
      res.writeHead(status)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', (err) => {
      setCors(res, origin)
      res.writeHead(502)
      res.end(`Proxy error: ${err.message}`)
    })
    if (body.length) proxyReq.write(body)
    proxyReq.end()
  }
})

server.listen(PORT, () => {
  console.log(`CORS proxy listening on http://localhost:${PORT}`)
  console.log(`Set the app's "CORS proxy" field to  http://localhost:${PORT}`)
})
