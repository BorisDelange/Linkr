#!/usr/bin/env node
// Show every worktree, its port pair, and whether those ports answer right now.
//
//   npm run worktree:status
//
// Liveness is probed against the OS rather than read from a registry file, so a
// crashed dev server never shows as running.

import { execFileSync } from 'child_process'
import { createConnection } from 'net'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
  cwd: repoRoot,
  encoding: 'utf-8',
})

const worktrees = []
for (const block of porcelain.trim().split('\n\n')) {
  const dir = block.match(/^worktree (.+)$/m)?.[1]
  const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? '(detached)'
  if (dir) worktrees.push({ dir, branch })
}

function readPorts(dir) {
  const envFile = path.join(dir, 'apps/web/.env.local')
  if (!existsSync(envFile)) return { web: 3000, api: 8000, implicit: true }
  const text = readFileSync(envFile, 'utf-8')
  const get = (key) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm'))?.[1]
  return {
    web: Number(get('WEB_PORT')) || 3000,
    api: Number(get('API_PORT')) || 8000,
    implicit: !get('WEB_PORT'),
  }
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const done = (result) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(300)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

console.log()
for (const { dir, branch } of worktrees) {
  const { web, api, implicit } = readPorts(dir)
  const [webUp, apiUp] = await Promise.all([isListening(web), isListening(api)])
  const mark = (up) => (up ? '●' : '○')
  const suffix = implicit ? '  (no .env.local — defaults)' : ''
  console.log(`  ${path.basename(dir)}  —  ${branch}${suffix}`)
  console.log(`    ${mark(webUp)} front  http://localhost:${web}`)
  console.log(`    ${mark(apiUp)} api    http://localhost:${api}`)
  console.log()
}
