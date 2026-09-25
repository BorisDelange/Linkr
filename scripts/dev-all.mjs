#!/usr/bin/env node
// Run the frontend, the backend and the MCP server together in one terminal,
// prefixing each line with its source. Ctrl+C stops them all.
//
// Implemented here rather than with `concurrently` so the monorepo root needs no
// dependency of its own, and so the banner can print this worktree's real URL.

import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readEnvValue(key) {
  const envFile = path.join(repoRoot, 'apps/web/.env.local')
  if (!existsSync(envFile)) return undefined
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (match && match[1] === key) return match[2].trim()
  }
  return undefined
}

const webPort = process.env.WEB_PORT || readEnvValue('WEB_PORT') || '3000'
const apiPort = process.env.API_PORT || readEnvValue('API_PORT') || '8000'
// Offset like the API port, so each worktree's MCP server gets its own port
// (API 8001 → MCP 3941) without a third reservation in new-worktree.
const mcpPort =
  process.env.MCP_PORT || readEnvValue('MCP_PORT') || String(3940 + (Number(apiPort) - 8000))

const procs = [
  { label: 'web', color: '\x1b[36m', cmd: 'npm', args: ['run', 'dev:web'] },
  { label: 'api', color: '\x1b[35m', cmd: 'npm', args: ['run', 'dev:api'] },
  // Optional: agents are not needed to use the app, so its exit (port taken,
  // broken install) is reported without stopping the rest. The environment
  // wins over packages/linkr-mcp/.env, which keeps pointing at the main checkout.
  {
    label: 'mcp',
    color: '\x1b[33m',
    cmd: 'npm',
    args: ['run', 'dev:mcp'],
    env: { LINKR_API_URL: `http://localhost:${apiPort}`, LINKR_MCP_PORT: mcpPort },
    optional: true,
  },
]

const children = procs.map(({ label, color, cmd, args, env }) => {
  // detached makes each child lead its own process group, so stopping can signal
  // the whole group: killing the npm wrapper alone leaves vite and uvicorn — the
  // processes actually holding the ports — running.
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: true,
  })
  const prefix = `${color}${label.padEnd(3)}\x1b[0m │ `
  for (const stream of [child.stdout, child.stderr]) {
    let buffered = ''
    stream.on('data', (chunk) => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) process.stdout.write(prefix + line + '\n')
    })
  }
  return child
})

console.log(`\n  ${path.basename(repoRoot)}  →  http://localhost:${webPort}   (Ctrl+C to stop)`)
console.log(`  MCP server for agents  →  http://127.0.0.1:${mcpPort}/mcp\n`)

// The app's process dying takes the others down: a half-running stack silently
// serving stale behaviour is worse than a clean stop. The optional MCP server
// is the exception.
let stopping = false
const stopAll = (signal = 'SIGTERM') => {
  if (stopping) return
  stopping = true
  for (const child of children) {
    // Negative pid = the whole process group (see detached above). Already-dead
    // groups throw ESRCH, which is exactly the case we want to ignore.
    try {
      process.kill(-child.pid, signal)
    } catch {
      /* already gone */
    }
  }
}

process.on('SIGINT', () => stopAll('SIGINT'))
process.on('SIGTERM', () => stopAll('SIGTERM'))

children.forEach((child, i) => {
  child.on('exit', (code) => {
    if (procs[i].optional && !stopping) {
      process.stdout.write(`${procs[i].color}${procs[i].label}\x1b[0m │ stopped (code ${code}) — the app keeps running\n`)
      return
    }
    stopAll()
    process.exitCode = code ?? 0
  })
})
