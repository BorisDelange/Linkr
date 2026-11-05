#!/usr/bin/env node
/**
 * The demo ETL pipeline (MIMIC-IV demo → OMOP CDM 5.4) run whole on the server
 * and its OMOP result checked: apps/api/tests/test_etl_demo_pipeline.py, with
 * the vocabulary fill script the Vocabulary tab generates today.
 *
 *   npm run test:etl
 *
 * Needs the demo seed (`npm run data:fetch`) and the API virtualenv. The fill
 * script is written to .cache/etl-demo/89_fill_vocabulary.sql, the run's
 * figures (rows per CDM table, 90_tests.sql, concepts kept) to report.json there.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const python = join(root, 'apps/api/.venv/bin/python')
const seed = join(root, 'apps/web/public/data/seed/default')
const vocabData = join(seed, 'databases/mimic-iv-demo-omop/data')
const work = join(root, '.cache/etl-demo')

if (!existsSync(join(seed, 'etl/mimic-iv-demo-omop-cdm/scripts/_tree.json')) || !existsSync(vocabData)) {
  console.error('No demo seed: run `npm run data:fetch` first.')
  process.exit(2)
}
if (!existsSync(python)) {
  console.error(`No API virtualenv at ${python}: create it first (apps/api, uv venv + uv pip install -e ".[dev]").`)
  process.exit(2)
}

const started = Date.now()
mkdirSync(work, { recursive: true })
// The tables the vocabulary database holds, as the Vocabulary tab passes them.
const vocabTables = readdirSync(vocabData).filter((f) => f.endsWith('.parquet')).map((f) => f.slice(0, -'.parquet'.length))
const fill = join(work, '89_fill_vocabulary.sql')
const report = join(work, 'report.json')
// A run that fails before the figures must not print the previous run's.
rmSync(report, { force: true })
writeFileSync(fill, execFileSync(
  'npx', ['tsx', '--tsconfig', 'apps/web/tsconfig.app.json', 'tests/etl-demo/fill-vocabulary-script.ts', ...vocabTables],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
))

const { status } = spawnSync(python, [
  '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-m', 'slow', 'tests/test_etl_demo_pipeline.py',
], { stdio: 'inherit', cwd: join(root, 'apps/api'), env: { ...process.env, LINKR_ETL_DEMO_FILL_SCRIPT: fill, LINKR_ETL_DEMO_REPORT: report } })
if (existsSync(report)) console.log(`\n${readFileSync(report, 'utf8')}`)
console.log(`\ntest:etl ${status === 0 ? 'passed' : 'FAILED'} in ${Math.round((Date.now() - started) / 1000)} s`)
process.exit(status ?? 1)
