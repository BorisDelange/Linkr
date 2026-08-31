#!/usr/bin/env node
// Create a git worktree ready to run: its own branch, its own free port pair,
// and the gitignored files a fresh checkout lacks (node_modules, .env.local,
// the baked seed).
//
//   npm run worktree:new -- agent-a
//   npm run worktree:new -- agent-a --branch feature/some-work
//
// Ports are allocated once, here, and then belong to the worktree: the app URL
// stays stable across restarts, which keeps its browser origin — and so its
// IndexedDB workspace — intact.

import { execFileSync } from 'child_process'
import { createServer } from 'net'
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const name = argv.find((a) => !a.startsWith('-'))
if (!name) {
  console.error('Usage: npm run worktree:new -- <name> [--branch <branch>]')
  process.exit(1)
}
const branchFlag = argv.indexOf('--branch')
const branch = branchFlag !== -1 ? argv[branchFlag + 1] : `feature/${name}`

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim()

const worktreePath = path.resolve(repoRoot, '..', `${path.basename(repoRoot)}-${name}`)
if (existsSync(worktreePath)) {
  console.error(`✗ ${worktreePath} already exists`)
  process.exit(1)
}

// Probing the OS alone is not enough: a worktree whose app is not running holds
// no socket, so its ports would look free and be handed out twice. The existing
// .env.local files are the reservations; the probe then rules out ports taken by
// something outside Linkr.
function reservedPorts() {
  const taken = new Set()
  for (const block of git('worktree', 'list', '--porcelain').split('\n\n')) {
    const dir = block.match(/^worktree (.+)$/m)?.[1]
    if (!dir) continue
    const envFile = path.join(dir, 'apps/web/.env.local')
    if (!existsSync(envFile)) continue
    const text = readFileSync(envFile, 'utf-8')
    for (const key of ['WEB_PORT', 'API_PORT']) {
      const value = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm'))?.[1]
      if (value) taken.add(Number(value))
    }
  }
  return taken
}

function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function findPortPair() {
  const reserved = reservedPorts()
  for (let offset = 1; offset < 100; offset++) {
    const web = 3000 + offset
    const api = 8000 + offset
    if (reserved.has(web) || reserved.has(api)) continue
    if ((await isFree(web)) && (await isFree(api))) return { web, api }
  }
  throw new Error('no free port pair found in 3001-3099 / 8001-8099')
}

const { web, api } = await findPortPair()

console.log(`\n  Creating worktree ${path.basename(worktreePath)} on ${branch}…`)
git('worktree', 'add', '-b', branch, worktreePath)

// Everything below is gitignored, so the fresh checkout does not have it.
writeFileSync(
  path.join(worktreePath, 'apps/web/.env.local'),
  [
    '# Per-worktree dev configuration (gitignored).',
    '# Ports are fixed at creation so the app URL — and its browser storage — stay stable.',
    `WEB_PORT=${web}`,
    `API_PORT=${api}`,
    `VITE_API_URL=http://localhost:${api}`,
    '',
  ].join('\n'),
)

const copyIfPresent = (relPath, label) => {
  const src = path.join(repoRoot, relPath)
  if (!existsSync(src)) return
  process.stdout.write(`  copying ${label}… `)
  mkdirSync(path.dirname(path.join(worktreePath, relPath)), { recursive: true })
  cpSync(src, path.join(worktreePath, relPath), { recursive: true })
  console.log('done')
}

copyIfPresent('node_modules', 'node_modules')
copyIfPresent('apps/web/node_modules', 'apps/web/node_modules')
copyIfPresent('apps/api/.venv', 'apps/api/.venv')
copyIfPresent('apps/web/public/data/seed', 'seed data')
copyIfPresent('config.local.json', 'config.local.json')

// The API .env carries three values that must NOT be shared between worktrees:
// LINKR_DATA_DIR (same SQLite file and Parquet blobs → two backends fighting
// over one database), and LINKR_CORS_ORIGINS (pinned to :3000, which would
// reject this worktree's frontend). Copy the rest as-is.
const apiEnvSrc = path.join(repoRoot, 'apps/api/.env')
if (existsSync(apiEnvSrc)) {
  const dataDir = path.join(worktreePath, '.linkr-data')
  mkdirSync(dataDir, { recursive: true })

  const rewritten = readFileSync(apiEnvSrc, 'utf-8')
    .split('\n')
    .map((line) => {
      if (/^\s*LINKR_DATA_DIR\s*=/.test(line)) return `LINKR_DATA_DIR=${dataDir}`
      if (/^\s*LINKR_CORS_ORIGINS\s*=/.test(line))
        return `LINKR_CORS_ORIGINS=http://localhost:${web}`
      return line
    })
    .join('\n')

  writeFileSync(path.join(worktreePath, 'apps/api/.env'), rewritten)
  console.log('  wrote apps/api/.env (own data dir + CORS origin)')
}

// The block below is what the user acts on: an agent must hand it over intact
// rather than paraphrasing it (see CLAUDE.md § Working in parallel).
console.log(`
  ✓ ${path.basename(worktreePath)}  (${branch})

  ── Run the app ── in a new VS Code terminal, front + back together:

  cd "${worktreePath}" && npm run dev:all

     Open       http://localhost:${web}
     Stop       Ctrl+C in that terminal

  ── See the files ── VS Code › File › Add Folder to Workspace… ›

     ${worktreePath}

  ── When the branch is merged ──

  npm run worktree:remove -- ${name} --branch
`)
