#!/usr/bin/env node
/**
 * The database matrix: every query the app sends to a database, run on every
 * engine Linkr reads, compared with DuckDB's answer on the Parquet. Details and
 * how to read the report: tests/db-matrix/README.md.
 *
 *   npm run test:matrix                                  # file engines, on this machine
 *   npm run test:matrix -- --spe                         # + PostgreSQL & MySQL, inside the SPE simulation
 *   npm run test:matrix -- --spe --machine tiny --scale 50
 *   npm run test:matrix -- --engines parquet,postgresql --spe --keep
 *
 * --engines   comma list (parquet, duckdb, sqlite, postgresql, mysql, doris, oracle, sqlserver)
 * --spe       run inside docker/spe-sim, capped by --machine (default laptop), with the datamarts
 * --machine   a profile of docker/spe-sim/machines/ (tiny, laptop, small-server, unlimited)
 * --scale N   N copies of every patient (tests/db-matrix/matrix.py upsample), cached under .cache/;
 *             above 1, MySQL is left out unless --engines names it
 * --data DIR  a Parquet OMOP folder, instead of the MIMIC-IV demo (LINKR_TEST_OMOP_DIR works too)
 * --keep      leave the datamarts running after an --spe run
 *
 * Exits non-zero when an engine answers a query differently or refuses it.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const DEMO_REPO = 'https://framagit.org/interhop/linkr/linkr-public-content/databases/mimic-iv-demo-omop.git'
const python = join(root, 'apps/api/.venv/bin/python')
const compose = ['compose', '-f', join(root, 'docker/spe-sim/docker-compose.yml')]

function parseArgs(argv) {
  const a = { engines: null, spe: false, machine: 'laptop', scale: 1, data: process.env.LINKR_TEST_OMOP_DIR ?? null, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--spe') a.spe = true
    else if (k === '--keep') a.keep = true
    else if (k === '--engines') a.engines = argv[++i]
    else if (k === '--machine') a.machine = argv[++i]
    else if (k === '--scale') a.scale = Number(argv[++i])
    else if (k === '--data') a.data = resolve(argv[++i])
    else { console.error(`unknown option ${k}`); process.exit(2) }
  }
  // MySQL checks the app's SQL dialect, which the ×1 base already proves; loading
  // an upsampled base into a capped MySQL takes longer than the rest of the run.
  a.engines ??= a.spe ? `parquet,duckdb,sqlite,postgresql${a.scale > 1 ? '' : ',mysql'}` : 'parquet,duckdb,sqlite'
  if (!Number.isInteger(a.scale) || a.scale < 1) { console.error('--scale takes a whole number ≥ 1'); process.exit(2) }
  return a
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })

/** The demo database: a shallow clone of its public repo, Parquet through git LFS. */
function demoData() {
  const dir = join(root, '.cache/test-data/mimic-iv-demo-omop')
  if (!existsSync(join(dir, 'data/person.parquet'))) {
    console.log(`▶ cloning the MIMIC-IV demo OMOP database (public, ~12 MB)`)
    mkdirSync(dirname(dir), { recursive: true })
    run('git', ['clone', '--depth', '1', DEMO_REPO, dir])
    run('git', ['lfs', 'pull'], { cwd: dir })
  }
  return dir
}

function main() {
  const a = parseArgs(process.argv.slice(2))
  if (!existsSync(python)) {
    console.error(`No API virtualenv at ${python}: create it first (apps/api, uv venv + uv pip install -e ".[dev]").`)
    process.exit(2)
  }
  const engines = a.engines.split(',')
  const base = a.data ? resolve(a.data) : demoData()
  const mapping = existsSync(join(base, 'mapping.json')) ? join(base, 'mapping.json') : join(demoData(), 'mapping.json')
  let data = existsSync(join(base, 'data')) ? join(base, 'data') : base

  if (a.scale > 1) {
    const scaled = join(root, `.cache/test-data/${base.split('/').pop()}-x${a.scale}`)
    if (!existsSync(join(scaled, 'person.parquet'))) run(python, ['tests/db-matrix/matrix.py', 'upsample', data, scaled, '--factor', String(a.scale)])
    data = scaled
  }

  const work = join(root, `.cache/db-matrix/${a.spe ? a.machine : 'host'}-x${a.scale}`)
  mkdirSync(work, { recursive: true })
  console.log(`▶ corpus: the app's SQL for this mapping`)
  run(python, ['tests/db-matrix/matrix.py', 'facts', data, join(work, 'facts.json')])
  run('npx', ['tsx', '--tsconfig', 'tests/db-matrix/tsconfig.json', 'tests/db-matrix/build-corpus.ts', mapping, join(work, 'facts.json'), join(work, 'corpus.json')])

  const env = {
    ...process.env,
    MATRIX_CORPUS: join(work, 'corpus.json'), MATRIX_DATA: data, MATRIX_WORK: work,
    MATRIX_ENGINES: engines.join(','), MATRIX_REPORT: join(work, 'report.json'),
  }
  let status
  if (a.spe) {
    status = runInSpe(a, engines, data, work, env)
  } else {
    for (const e of engines.filter((x) => x === 'duckdb' || x === 'sqlite')) {
      run(python, ['tests/db-matrix/matrix.py', 'load', data, e, '--target', join(work, `omop.${e}`)])
    }
    status = spawnSync(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests/db-matrix'], { stdio: 'inherit', cwd: root, env }).status
  }
  summarize(join(work, 'report.json'), join(work, 'report.md'), a)
  process.exit(status ?? 1)
}

function runInSpe(a, engines, data, work, env) {
  const machine = join(root, `docker/spe-sim/machines/${a.machine}.env`)
  if (!existsSync(machine)) { console.error(`no machine profile ${machine}`); process.exit(2) }
  const profiles = ['--profile', 'matrix']
  const services = ['mirror']
  if (engines.includes('postgresql')) { profiles.push('--profile', 'datamart'); services.push('datamart-postgres') }
  if (engines.includes('mysql')) { profiles.push('--profile', 'mysql'); services.push('datamart-mysql') }
  const speEnv = {
    // Docker's own builder: a docker-container builder (buildx) would ship the
    // 2 GB API image back to Docker as a tarball, minutes per build.
    BUILDX_BUILDER: dockerBuilder(),
    ...env,
    // The API service refuses to start without one; the matrix never starts it.
    LINKR_SECRET_KEY: process.env.LINKR_SECRET_KEY ?? 'unused-by-the-matrix',
    MATRIX_DATA_DIR: data, MATRIX_WORK_DIR: work,
  }
  const dc = (args, extra = {}) => spawnSync('docker', [...compose, '--env-file', machine, ...profiles, ...args], { stdio: 'inherit', cwd: root, env: speEnv, ...extra })
  console.log(`▶ SPE simulation, machine "${a.machine}": ${readFileSync(machine, 'utf8').split('\n').filter((l) => /^[A-Z]/.test(l)).join(' ')}`)
  if (dc(['build', 'api-8743']).status !== 0) return 1
  if (dc(['up', '-d', ...services]).status !== 0) return 1
  try {
    return dc(['run', '--rm', 'matrix-runner']).status
  } finally {
    if (!a.keep) dc(['stop', ...services.filter((s) => s !== 'mirror')])
  }
}

function summarize(reportPath, mdPath, a) {
  if (!existsSync(reportPath)) return
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const engines = [...new Set(report.map((r) => r.engine))]
  const lines = [`# Database matrix — ${a.spe ? `SPE, machine ${a.machine}` : 'this machine'}, scale ×${a.scale}`, '',
    '| Engine | Same | Different | Error | Capped | Skipped | Total ms | Slowest |', '|---|---:|---:|---:|---:|---:|---:|---|']
  for (const e of engines) {
    const rows = report.filter((r) => r.engine === e)
    const n = (s) => rows.filter((r) => r.status === s).length
    const timed = rows.filter((r) => r.ms != null).sort((x, y) => y.ms - x.ms)
    const total = Math.round(timed.reduce((s, r) => s + r.ms, 0))
    lines.push(`| ${e} | ${n('same')} | ${n('different')} | ${n('error')} | ${n('capped')} | ${n('skipped')} | ${total} | ${timed[0] ? `${timed[0].key} (${Math.round(timed[0].ms)} ms)` : ''} |`)
  }
  const problems = report.filter((r) => r.status === 'error' || r.status === 'different')
  if (problems.length) {
    lines.push('', '## Problems', '')
    for (const p of problems) lines.push(`- **${p.engine}** \`${p.key}\` (${p.source}): ${p.error ?? `answers differently — ${JSON.stringify(p.first_difference)}`}`.replace(/\s+/g, " ").slice(0, 600))
  }
  const skipped = [...new Set(report.filter((r) => r.status === 'skipped').map((r) => `${r.engine}: ${r.reason}`))]
  if (skipped.length) lines.push('', '## Skipped', '', ...skipped.map((s) => `- ${s}`))
  writeFileSync(mdPath, lines.join('\n') + '\n')
  console.log('\n' + lines.join('\n') + `\n\n  report: ${mdPath}`)
}

main()
