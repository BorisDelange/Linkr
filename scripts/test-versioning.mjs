#!/usr/bin/env node
/**
 * The git versioning journeys (docs/testing.md § End-to-end, `server`) on a
 * disposable full stack of their own: an API on its own data folder and a Vite
 * dev server (the journeys import app modules from /src), on free ports, never
 * the user's dev server.
 *
 *   npm run test:versioning                     # round trip, matrix, workspace pull
 *   npm run test:versioning -- --forge          # + merge requests on docker/forge-sim
 *   npm run test:versioning -- --refresh-demo   # reinstall the demo snapshot first
 *   npm run test:versioning -- matrix           # some journeys only
 *
 * The first run installs the demo workspace from the public catalog (network) and
 * keeps the instance in .cache/versioning-e2e/demo-snapshot; every journey then
 * starts from a fresh copy of it, since they rewire its git links. The API's
 * output goes to .cache/versioning-e2e/api.log. With --forge
 * the local GitLab is started and seeded, then stopped (its data kept) unless
 * --keep-forge.
 */

import { cpSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const web = join(root, 'apps/web')
const api = join(root, 'apps/api')
const forge = join(root, 'docker/forge-sim')
const cache = join(root, '.cache/versioning-e2e')
const dataDir = join(cache, 'data')
const snapshot = join(cache, 'demo-snapshot')
// The bin link of a worktree points into the main checkout: call the CLI by path.
const playwright = join(root, 'node_modules/@playwright/test/cli.js')

const JOURNEYS = {
  roundtrip: 'e2e/server/versioning-roundtrip.spec.ts',
  matrix: 'e2e/server/versioning-matrix.spec.ts',
  'workspace-pull': 'e2e/server/workspace-pull.spec.ts',
}

function parseArgs(argv) {
  const a = { forge: false, keepForge: false, refreshDemo: false, journeys: [] }
  for (const arg of argv) {
    if (arg === '--forge') a.forge = true
    else if (arg === '--keep-forge') a.forge = a.keepForge = true
    else if (arg === '--refresh-demo') a.refreshDemo = true
    else if (arg.startsWith('--')) { console.error(`unknown option ${arg}`); process.exit(2) }
    else if (!JOURNEYS[arg]) { console.error(`no journey ${arg} (have: ${Object.keys(JOURNEYS).join(', ')})`); process.exit(2) }
    else a.journeys.push(arg)
  }
  if (a.journeys.length === 0) a.journeys = Object.keys(JOURNEYS)
  return a
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })
}

async function waitFor(url, seconds) {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    try { await fetch(url); return } catch { await new Promise((r) => setTimeout(r, 1000)) }
  }
  throw new Error(`${url} did not answer in ${seconds}s`)
}

/** A child in its own process group, so stopping it also stops what it spawned. */
function start(cmd, args, opts, log) {
  const out = log ? openSync(join(cache, log), 'a') : 'ignore'
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', out, out] })
  children.add(child)
  return child
}
const children = new Set()
function stop(child) {
  if (!child || child.exitCode !== null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
  children.delete(child)
}
process.on('exit', () => { for (const c of children) stop(c) })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))

function startApi(apiPort, webPort) {
  const env = {
    ...process.env,
    LINKR_DATA_DIR: dataDir,
    LINKR_DATABASE_URL: '',
    LINKR_CORS_ORIGINS: `http://localhost:${webPort}`,
    LINKR_SECRET_KEY: 'versioning-e2e-only-secret',
    LINKR_GIT_ALLOW_LOCAL_REMOTES: 'true',
    LINKR_GIT_ALLOWED_HOSTS: 'localhost:8929',
  }
  const migrated = spawnSync(join(api, '.venv/bin/alembic'), ['upgrade', 'head'], { cwd: api, env, encoding: 'utf8' })
  if (migrated.status !== 0) throw new Error(`alembic upgrade failed:\n${migrated.stderr}`)
  return start(join(api, '.venv/bin/uvicorn'), ['app.main:app', '--port', String(apiPort)], { cwd: api, env }, 'api.log')
}

function playwrightRun(args, env) {
  return spawnSync(process.execPath, [playwright, 'test', ...args], { cwd: web, env: { ...process.env, ...env }, stdio: 'inherit' }).status === 0
}

function forgeUp() {
  console.log('\n━━ forge-sim: starting the local GitLab (first boot: a few minutes)')
  if (spawnSync('docker', ['compose', '-p', 'linkr-forge-sim', 'up', '-d'], { cwd: forge, stdio: 'inherit' }).status !== 0) throw new Error('forge-sim did not start')
  if (spawnSync('./seed.sh', [], { cwd: forge, stdio: 'inherit' }).status !== 0) throw new Error('forge-sim seeding failed')
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const [webPort, apiPort] = [await freePort(), await freePort()]
  const serverUrl = `http://localhost:${webPort}`
  const apiUrl = `http://localhost:${apiPort}`
  const e2eEnv = {
    E2E_SERVER_URL: serverUrl,
    E2E_BASE_URL: serverUrl,
    E2E_API_URL: apiUrl,
    E2E_GIT_LOCAL_REMOTES: '1',
    E2E_DEMO: '1',
    ...(a.forge ? { E2E_FORGE: '1' } : {}),
  }
  mkdirSync(cache, { recursive: true })
  rmSync(join(cache, 'api.log'), { force: true })

  // process.env wins over apps/web/.env.local, which names the worktree's own API.
  start(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--port', String(webPort), '--strictPort'], {
    cwd: web, env: { ...process.env, VITE_API_URL: apiUrl },
  })
  await waitFor(serverUrl, 120)

  if (a.refreshDemo || !existsSync(snapshot)) {
    console.log('\n━━ demo snapshot: first run with the default data (needs the public catalog)')
    rmSync(dataDir, { recursive: true, force: true })
    const apiProc = startApi(apiPort, webPort)
    await waitFor(`${apiUrl}/api/v1/auth/me`, 120)
    const ok = playwrightRun(['--project=server-demo-setup', 'e2e/server/demo-install.setup.ts'], e2eEnv)
    stop(apiProc)
    if (!ok) throw new Error('the demo install failed')
    rmSync(snapshot, { recursive: true, force: true })
    cpSync(dataDir, snapshot, { recursive: true })
  }

  if (a.forge) forgeUp()
  const results = []
  try {
    for (const name of a.journeys) {
      console.log(`\n━━ ${name}`)
      rmSync(dataDir, { recursive: true, force: true })
      cpSync(snapshot, dataDir, { recursive: true })
      const apiProc = startApi(apiPort, webPort)
      await waitFor(`${apiUrl}/api/v1/auth/me`, 120)
      const t0 = Date.now()
      const ok = playwrightRun(['--project=server', '--no-deps', JOURNEYS[name]], e2eEnv)
      results.push({ name, ok, seconds: Math.round((Date.now() - t0) / 1000) })
      stop(apiProc)
    }
  } finally {
    if (a.forge && !a.keepForge) spawnSync('docker', ['compose', '-p', 'linkr-forge-sim', 'down'], { cwd: forge, stdio: 'ignore' })
  }

  console.log('\n━━ versioning journeys')
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✘'} ${r.name} (${r.seconds}s)`)
  if (!a.forge) console.log('  (merge requests skipped: --forge runs them on docker/forge-sim)')
  process.exitCode = results.every((r) => r.ok) ? 0 : 1
}

main()
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1 })
  .finally(() => process.exit())
