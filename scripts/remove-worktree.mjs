#!/usr/bin/env node
// Remove a worktree created by scripts/new-worktree.mjs.
//
//   npm run worktree:remove -- agent-a            # keeps the branch
//   npm run worktree:remove -- agent-a --branch   # deletes it too
//
// `git worktree remove` refuses a directory holding untracked files, and every
// worktree here has a copied node_modules — so the directory is removed
// outright, then the stale administrative entry is pruned.

import { execFileSync } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const name = argv.find((a) => !a.startsWith('-'))
if (!name) {
  console.error('Usage: npm run worktree:remove -- <name> [--branch]')
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim()

const worktreePath = path.resolve(repoRoot, '..', `${path.basename(repoRoot)}-${name}`)
if (!existsSync(worktreePath)) {
  console.error(`✗ ${worktreePath} does not exist`)
  process.exit(1)
}

const branch = git('-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')

const dirty = git('-C', worktreePath, 'status', '--porcelain')
if (dirty) {
  console.error(`✗ ${path.basename(worktreePath)} has uncommitted changes:\n${dirty}`)
  console.error('\n  Commit or discard them first.')
  process.exit(1)
}

// Its data dir lives outside it (config.local.json `worktrees.dataRoot`): read
// where its .env points before the directory goes. Only a data dir named after
// this worktree is removed — never the main one, whatever the .env says.
const envPath = path.join(worktreePath, 'apps/api/.env')
const dataDir = existsSync(envPath)
  ? readFileSync(envPath, 'utf-8').match(/^\s*LINKR_DATA_DIR\s*=\s*(.+)$/m)?.[1]?.trim()
  : undefined

rmSync(worktreePath, { recursive: true, force: true })
git('worktree', 'prune')
console.log(`  ✓ removed ${path.basename(worktreePath)}`)

if (dataDir && !dataDir.startsWith(worktreePath + path.sep) && path.basename(dataDir) === path.basename(worktreePath)) {
  rmSync(dataDir, { recursive: true, force: true })
  console.log(`  ✓ removed its data dir ${dataDir}`)
} else if (dataDir && !dataDir.startsWith(worktreePath + path.sep)) {
  console.log(`    data dir ${dataDir} kept: not named after this worktree`)
}

if (argv.includes('--branch')) {
  git('branch', '-D', branch)
  console.log(`  ✓ deleted branch ${branch}`)
} else {
  console.log(`    branch ${branch} kept — delete with: git branch -D ${branch}`)
}
