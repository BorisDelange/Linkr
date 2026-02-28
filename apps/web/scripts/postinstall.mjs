/**
 * Post-install script: copies DuckDB WASM files and coi-serviceworker to public/.
 * Works in both monorepo (hoisted node_modules) and standalone installs.
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(__dirname, '..')

function findPkg(name) {
  // Try local node_modules first, then monorepo root
  const local = resolve(webRoot, 'node_modules', name)
  if (existsSync(local)) return local
  const root = resolve(webRoot, '..', '..', 'node_modules', name)
  if (existsSync(root)) return root
  throw new Error(`Cannot find package "${name}" in node_modules`)
}

const duckdb = findPkg('@duckdb/duckdb-wasm')
const coi = findPkg('coi-serviceworker')

const publicDir = resolve(webRoot, 'public')
const duckdbDir = resolve(publicDir, 'duckdb')
mkdirSync(duckdbDir, { recursive: true })

const duckdbFiles = [
  'duckdb-mvp.wasm',
  'duckdb-eh.wasm',
  'duckdb-browser-mvp.worker.js',
  'duckdb-browser-eh.worker.js',
]

for (const file of duckdbFiles) {
  copyFileSync(resolve(duckdb, 'dist', file), resolve(duckdbDir, file))
}

copyFileSync(resolve(coi, 'coi-serviceworker.js'), resolve(publicDir, 'coi-serviceworker.js'))

console.log('postinstall: copied DuckDB WASM + coi-serviceworker to public/')
