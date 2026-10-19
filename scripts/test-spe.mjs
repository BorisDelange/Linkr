#!/usr/bin/env node
/**
 * SPE scenarios: the app run inside the SPE simulation (docker/spe-sim) under
 * each proxy, network and machine variant found across hospitals, checked by the
 * smoke test and, with --e2e, by the server-mode Playwright journeys.
 *
 *   npm run test:spe                                   # every scenario, machine "laptop"
 *   npm run test:spe -- default no-websockets           # some scenarios
 *   npm run test:spe -- --machine tiny --e2e default    # capped harder, + browser journeys
 *   npm run test:spe -- --keep default                  # leave it running afterwards
 *
 * Scenarios: docker/spe-sim/scenarios/*.env. Machines: docker/spe-sim/machines/*.env.
 * Each scenario starts from empty volumes (a first install), so the journeys
 * create the first account themselves.
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The builder built into the current Docker context (it bears the context's
 *  name: `default`, `desktop-linux`…). A docker-container builder selected with
 *  `docker buildx use` would ship every image back to Docker as a tarball. */
function dockerBuilder() {
  try {
    return execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim() || 'default'
  } catch {
    return 'default'
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const spe = join(root, 'docker/spe-sim')
const port = process.env.SPE_GATEWAY_PORT ?? '8443'
const appUrl = `https://localhost:${port}/docker-8743/`

function parseArgs(argv) {
  const a = { machine: 'laptop', e2e: false, keep: false, scenarios: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--machine') a.machine = argv[++i]
    else if (argv[i] === '--e2e') a.e2e = true
    else if (argv[i] === '--keep') a.keep = true
    else if (argv[i].startsWith('--')) { console.error(`unknown option ${argv[i]}`); process.exit(2) }
    else a.scenarios.push(argv[i])
  }
  const all = readdirSync(join(spe, 'scenarios')).filter((f) => f.endsWith('.env')).map((f) => f.slice(0, -4)).sort()
  if (a.scenarios.length === 0) a.scenarios = ['default', ...all.filter((s) => s !== 'default')]
  for (const s of a.scenarios) if (!all.includes(s)) { console.error(`no scenario ${s} (have: ${all.join(', ')})`); process.exit(2) }
  if (!existsSync(join(spe, `machines/${a.machine}.env`))) { console.error(`no machine ${a.machine}`); process.exit(2) }
  return a
}

/** KEY=value lines of an env file; its first comment lines are its description. */
function readEnv(path) {
  const text = readFileSync(path, 'utf8')
  const vars = Object.fromEntries(text.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const about = text.split('\n').filter((l) => l.startsWith('#')).map((l) => l.replace(/^#\s?/, '')).join(' ')
  return { vars, about }
}

function waitForApp(seconds = 240) {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const r = spawnSync('curl', ['-ksf', '-o', '/dev/null', '-w', '%{content_type}', `${appUrl}api/v1/health`], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.includes('json')) return true
    spawnSync('sleep', ['3'])
  }
  return false
}

function main() {
  const a = parseArgs(process.argv.slice(2))
  const machine = readEnv(join(spe, `machines/${a.machine}.env`))
  const results = []
  let built = false

  for (const name of a.scenarios) {
    const scenario = readEnv(join(spe, `scenarios/${name}.env`))
    console.log(`\n━━ scenario ${name} — ${scenario.about}`)
    const env = {
      // Docker's own builder: a docker-container builder (buildx) would ship each
      // 2 GB image back to Docker as a tarball, minutes per build.
      BUILDX_BUILDER: dockerBuilder(),
      ...process.env, ...machine.vars, ...scenario.vars,
      LINKR_SECRET_KEY: process.env.LINKR_SECRET_KEY ?? `spe-scenario-${Date.now()}-not-a-real-secret-key`,
    }
    const dc = (args) => spawnSync('docker', ['compose', '-f', join(spe, 'docker-compose.yml'), ...args], { stdio: 'inherit', cwd: root, env })
    const t0 = Date.now()
    const row = { scenario: name, machine: a.machine, smoke: 'not run', e2e: a.e2e ? 'not run' : 'off' }
    results.push(row)

    if (!built) {
      if (dc(['build', 'gateway', 'web-8743', 'api-8743']).status !== 0) { row.smoke = 'build failed'; break }
      built = true
    }
    // A first install every time: only Linkr's own volume goes, the mirror's
    // cache and the datamarts stay.
    const fresh = () => {
      dc(['rm', '-sf', 'gateway', 'web-8743', 'api-8743'])
      spawnSync('docker', ['volume', 'rm', '-f', 'linkr-spe-sim_linkr-8743'], { stdio: 'ignore' })
    }
    fresh()
    const services = ['gateway', 'web-8743', 'api-8743', ...(env.SPE_MIRROR === 'off' ? [] : ['mirror'])]
    // The previous scenario's mirror would still be serving.
    if (env.SPE_MIRROR === 'off') dc(['stop', 'mirror'])
    if (dc(['up', '-d', ...services]).status !== 0) { row.smoke = 'did not start'; continue }
    if (!waitForApp()) {
      row.smoke = 'API never healthy'
      dc(['logs', '--tail', '60', 'api-8743'])
    } else {
      row.ready = `${Math.round((Date.now() - t0) / 1000)} s`
      row.smoke = spawnSync('bash', [join(spe, 'smoke-test.sh')], { stdio: 'inherit', cwd: root, env }).status === 0 ? 'pass' : 'FAIL'
      if (a.e2e) {
        const pw = spawnSync('npx', ['playwright', 'test', '--project', 'server'], {
          stdio: 'inherit', cwd: join(root, 'apps/web'),
          env: { ...env, E2E_SERVER_URL: appUrl, E2E_BASE_URL: appUrl, E2E_SCENARIO: name },
        })
        row.e2e = pw.status === 0 ? 'pass' : 'FAIL'
      }
    }
    if (!a.keep || name !== a.scenarios.at(-1)) fresh()
  }

  const lines = [`# SPE scenarios — machine ${a.machine}`, '', '| Scenario | Ready in | Smoke test | Journeys |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.scenario} | ${r.ready ?? '—'} | ${r.smoke} | ${r.e2e} |`)]
  mkdirSync(join(root, '.cache/spe'), { recursive: true })
  const out = join(root, `.cache/spe/report-${a.machine}.md`)
  writeFileSync(out, lines.join('\n') + '\n')
  console.log('\n' + lines.join('\n') + `\n\n  report: ${out}`)
  if (a.keep) console.log(`  left running: ${appUrl}  (stop: docker compose -f docker/spe-sim/docker-compose.yml down)`)
  process.exit(results.every((r) => r.smoke === 'pass' && (r.e2e === 'pass' || r.e2e === 'off')) ? 0 : 1)
}

main()
