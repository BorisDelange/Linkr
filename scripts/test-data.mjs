#!/usr/bin/env node
/**
 * The OMOP test datasets, built once and kept between runs (tests/test-data/README.md).
 *
 *   npm run test-data                      # build every dataset missing
 *   npm run test-data -- synthea-100k      # just this one
 *   npm run test-data -- --list            # where they are, what is built
 *
 * They live in the folder `testData.dir` of the gitignored config.local.json
 * names (tens of GB: never inside the checkout), or `.cache/test-data/` without it.
 * The database matrix reads them by name: `npm run test:matrix -- --dataset synthea-100k`.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const python = join(root, 'apps/api/.venv/bin/python')
const DEMO_REPO = 'https://framagit.org/interhop/linkr/linkr-public-content/databases/mimic-iv-demo-omop.git'
const SYNTHEA = 'https://synthea-omop.s3.amazonaws.com/synthea100k'
const SYNTHEA_TABLES = ['person', 'observation_period', 'visit_occurrence', 'condition_occurrence', 'drug_exposure',
  'procedure_occurrence', 'measurement', 'observation', 'condition_era', 'drug_era']
const EUNOMIA = 'https://github.com/OHDSI/EunomiaDatasets/raw/main/datasets/Synthea27NjParquet/Synthea27NjParquet_5.4.zip'
const ASCLEPIUS = 'https://huggingface.co/api/datasets/starmpcc/Asclepius-Synthetic-Clinical-Notes/parquet/default/train/0.parquet'

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })

export function testDataDir() {
  let dir
  try {
    dir = JSON.parse(readFileSync(join(root, 'config.local.json'), 'utf8'))?.testData?.dir
  } catch {
    dir = undefined
  }
  if (typeof dir !== 'string' || !dir.trim()) return join(root, '.cache/test-data')
  return dir.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '~')
}

/** The folder of Parquet tables of a dataset (the demo keeps them under data/). */
export const tablesOf = (dir) => (existsSync(join(dir, 'data/person.parquet')) ? join(dir, 'data') : dir)

function demo(dir) {
  if (existsSync(join(dir, 'data/person.parquet'))) return
  console.log('▶ mimic-iv-demo-omop: cloning the public MIMIC-IV demo in OMOP (~12 MB)')
  mkdirSync(dirname(dir), { recursive: true })
  run('git', ['clone', '--depth', '1', DEMO_REPO, dir])
  run('git', ['lfs', 'pull'], { cwd: dir })
}

function upsampled(base, factor) {
  return (dir) => {
    if (existsSync(join(dir, 'person.parquet'))) return
    const from = join(testDataDir(), base)
    DATASETS[base].build(from)
    console.log(`▶ ${base}-x${factor}: ${factor} copies of every patient`)
    run(python, ['tests/db-matrix/matrix.py', 'upsample', tablesOf(from), dir, '--factor', String(factor)])
  }
}

function download(url, to) {
  if (existsSync(to)) return
  mkdirSync(dirname(to), { recursive: true })
  console.log(`  ↓ ${url}`)
  run('curl', ['-fSL', '--retry', '3', '-C', '-', '-o', `${to}.part`, url])
  run('mv', [`${to}.part`, to])
}

function synthea(dir) {
  if (existsSync(join(dir, 'note.parquet')) && existsSync(join(dir, 'cdm_source.parquet'))) return
  try {
    execFileSync('lzop', ['--version'], { stdio: 'ignore' })
  } catch {
    console.error('✗ synthea-100k needs lzop to unpack the Synthea export: brew install lzop (or apt install lzop)')
    process.exit(2)
  }
  const ref = join(testDataDir(), 'mimic-iv-demo-omop')
  demo(ref)
  const downloads = join(testDataDir(), '_downloads')
  console.log('▶ synthea-100k: Synthea 100k OMOP (~1.5 GB), Eunomia vocabulary, Asclepius notes (~200 MB)')
  for (const t of SYNTHEA_TABLES) download(`${SYNTHEA}/${t}.csv.lzo`, join(downloads, 'synthea100k', `${t}.csv.lzo`))
  download(EUNOMIA, join(downloads, 'eunomia', 'Synthea27NjParquet_5.4.zip'))
  download(ASCLEPIUS, join(downloads, 'asclepius', 'asclepius.parquet'))
  run(python, ['-I', 'tests/test-data/build.py', 'synthea', downloads, tablesOf(ref), dir])
}

function subsetOf(base, patients) {
  return (dir) => {
    if (existsSync(join(dir, 'note.parquet'))) return
    const from = join(testDataDir(), base)
    DATASETS[base].build(from)
    console.log(`▶ the first ${patients.toLocaleString('en')} patients of ${base}`)
    run(python, ['-I', 'tests/test-data/build.py', 'subset', from, dir, '--patients', String(patients)])
  }
}

function densified(base, events) {
  return (dir) => {
    if (existsSync(join(dir, 'measurement.parquet'))) return
    const from = join(testDataDir(), base)
    DATASETS[base].build(from)
    console.log(`▶ ${base} with patients of ${events.map((n) => n.toLocaleString('en')).join(', ')} events`)
    run(python, ['-I', 'tests/test-data/build.py', 'dense', tablesOf(from), dir, '--events', ...events.map(String)])
  }
}

export const DATASETS = {
  'mimic-iv-demo-omop': { about: 'MIMIC-IV demo, 100 patients, ~12 MB', build: demo },
  'mimic-iv-demo-omop-x100': { about: 'the demo ×100: 10,000 patients', build: upsampled('mimic-iv-demo-omop', 100) },
  'synthea-100k': { about: 'Synthea "100k": 235,000 patients, 118 M rows, 158k notes with edge-case texts, 2 GB', build: synthea },
  'synthea-25k': { about: 'its first 25,000 patients, ~12 M rows: fits Oracle Free (12 GB)', build: subsetOf('synthea-100k', 25_000) },
  'mimic-iv-demo-dense-5m': {
    about: 'the demo + patients 990000001-3 with 100k, 1 M and 5 M events: small enough to import in a browser',
    build: densified('mimic-iv-demo-omop', [100_000, 1_000_000, 5_000_000]),
  },
  'mimic-iv-demo-dense': {
    about: 'the demo + patients 990000001-4 with 100k, 1 M, 5 M and 20 M events over a year: the patient views at scale',
    build: densified('mimic-iv-demo-omop', [100_000, 1_000_000, 5_000_000, 20_000_000]),
  },
}

/** The dataset's folder, built first if missing. */
export function dataset(name) {
  const spec = DATASETS[name]
  if (!spec) {
    console.error(`✗ no dataset ${name}: ${Object.keys(DATASETS).join(', ')}`)
    process.exit(2)
  }
  const dir = join(testDataDir(), name)
  spec.build(dir)
  return dir
}

function size(dir) {
  let total = 0
  for (const f of readdirSync(dir, { recursive: true })) {
    const s = statSync(join(dir, f.toString()))
    if (s.isFile()) total += s.size
  }
  return `${(total / 1e9).toFixed(2)} GB`
}

function main() {
  const args = process.argv.slice(2)
  if (!existsSync(python)) {
    console.error(`No API virtualenv at ${python}: create it first (apps/api, uv venv + uv pip install -e ".[dev]").`)
    process.exit(2)
  }
  if (args.includes('--list')) {
    console.log(`Test datasets in ${testDataDir()}${testDataDir().startsWith(root) ? ' (set testData.dir in config.local.json to keep them elsewhere)' : ''}`)
    for (const [name, spec] of Object.entries(DATASETS)) {
      const dir = join(testDataDir(), name)
      console.log(`  ${existsSync(dir) ? '✓' : '·'} ${name.padEnd(26)} ${spec.about}${existsSync(dir) ? `  [${size(dir)}]` : ''}`)
    }
    return
  }
  for (const name of args.length ? args : Object.keys(DATASETS)) console.log(`✓ ${name}: ${dataset(name)}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
