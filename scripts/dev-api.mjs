#!/usr/bin/env node
// Launch uvicorn on this worktree's API port.
//
// The port comes from apps/web/.env.local (API_PORT), written by
// scripts/new-worktree.mjs, so several worktrees can run side by side without
// anyone remembering which pair belongs to which. Extra CLI args win, so
// `npm run dev:api -- --port 8123` still overrides.
//
// Uses apps/api/.venv/bin/uvicorn by path rather than the one on PATH: the
// venv is per-worktree and usually not activated in the shell.

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

const port = process.env.API_PORT || readEnvValue('API_PORT') || '8000'

const venvUvicorn = path.join(repoRoot, 'apps/api/.venv/bin/uvicorn')
const uvicorn = existsSync(venvUvicorn) ? venvUvicorn : 'uvicorn'
if (uvicorn === 'uvicorn') {
  console.warn('⚠  apps/api/.venv not found — falling back to uvicorn on PATH')
}

// Run from apps/api so --reload-dir resolves the same way it did when this was
// a `cd apps/api && uvicorn …` shell script.
const apiDir = path.join(repoRoot, 'apps/api')

const args = [
  'app.main:app',
  '--reload',
  '--reload-dir',
  'app',
  '--port',
  port,
  ...process.argv.slice(2),
]

console.log(`\n  API  →  http://localhost:${port}\n`)

const child = spawn(uvicorn, args, { cwd: apiDir, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
