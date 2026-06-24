/**
 * Post-install script: copies DuckDB WASM files and coi-serviceworker to public/.
 * Works in both monorepo (hoisted node_modules) and standalone installs.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
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

const coiDest = resolve(publicDir, 'coi-serviceworker.js')
copyFileSync(resolve(coi, 'coi-serviceworker.js'), coiDest)

// Firefox fix: the vanilla coi-serviceworker fetch handler's `.catch` returns
// undefined, so respondWith() resolves with a non-Response and Firefox breaks.
// Patch the copied file to return a fallback Response. Idempotent; fails loudly
// if a package upgrade changes the code so we re-check the patch.
const PATCH_TARGET = '.catch((e) => console.error(e))'
const PATCH_REPLACEMENT = '.catch((e) => { console.error(e); return fetch(request); })'
let coiSource = readFileSync(coiDest, 'utf8')
if (!coiSource.includes(PATCH_REPLACEMENT)) {
  if (!coiSource.includes(PATCH_TARGET)) {
    throw new Error(
      `postinstall: cannot apply Firefox patch to coi-serviceworker.js — expected pattern ${JSON.stringify(PATCH_TARGET)} not found (did coi-serviceworker change version?)`
    )
  }
  coiSource = coiSource.replace(PATCH_TARGET, PATCH_REPLACEMENT)
  writeFileSync(coiDest, coiSource)
}

console.log('postinstall: copied DuckDB WASM + coi-serviceworker (Firefox-patched) to public/')
