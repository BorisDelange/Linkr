#!/usr/bin/env node
/**
 * Bake the default data into the client-only build.
 *
 * The default data is one published workspace whose children are git links
 * (`demo-workspace`, the same entry the catalog installs). Server mode installs it
 * at runtime through the catalog; a WASM build cannot — there is no git client in
 * the browser — so its copy is assembled here, at build time, and shipped as the
 * seed under `apps/web/public/data/seed/`.
 *
 * One source of truth, two ways of reaching it. See
 * docs/planning/default-data-repos-plan.md §0.
 *
 *   clone the workspace repo
 *     → read git-links.json
 *     → clone each child at its pinned ref, splice it over its pointer folder
 *     → index the assembled tree (buildSeedManifest, shared with linkr-portal)
 *     → write seed/<workspace>/ + manifest.json + seed.json
 *
 * Usage (TypeScript, run through tsx like the rest of the monorepo's tooling —
 * it is what resolves `@linkr/format`'s `.js` specifiers back to its sources):
 *   npm run data:fetch                             # fetch and bake
 *   npm run data:fetch -- --offline                # fail unless the cache serves it
 *   LINKR_BUILD_PROFILE=lean npm run data:fetch    # bake nothing (portal builds)
 *   LINKR_DEFAULT_DATA_URL=… npm run data:fetch    # a fork's or mirror's workspace
 *
 * NOT run by `npm run dev` — local development must not need the network. CI runs
 * it before `vite build`.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Relative paths, not `@linkr/format`: the workspace link is not installed in
// every checkout (npm workspaces is declared, but CI clones and portal builds run
// without it), and this script has to work on a bare `git clone` + `npm ci`.
import { buildSeedManifest, buildSeedRoot } from '../packages/linkr-format/src/seed-manifest.js'
import { FsTree } from '../packages/linkr-format/src/node/fs-tree.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEED_DIR = join(ROOT, 'apps/web/public/data/seed')
const CACHE_DIR = join(ROOT, '.cache/default-data')

/** The published workspace that IS the default data. Overridable for a fork. */
const WORKSPACE_URL = process.env.LINKR_DEFAULT_DATA_URL
  || 'https://framagit.org/interhop/linkr/linkr-public-content/workspaces/demo-workspace'
const WORKSPACE_REF = process.env.LINKR_DEFAULT_DATA_REF || 'main'
/** Folder the workspace lands in under `seed/`; also its key in seed.json. */
const WORKSPACE_FOLDER = process.env.LINKR_DEFAULT_DATA_FOLDER || 'default'

const OFFLINE = process.argv.includes('--offline')
const PROFILE = process.env.LINKR_BUILD_PROFILE || 'demo'

/** git-links.json entity type → the folder it lives in inside a workspace tree. */
const TYPE_DIR = {
  'project': 'projects',
  'mapping-project': 'mapping-projects',
  'sql-collection': 'sql-scripts',
  'etl-pipeline': 'etl',
  'data-catalog': 'catalogs',
  'dq-rule-set': 'data-quality',
  'schema-preset': 'schemas',
  'database': 'databases',
}

const log = (msg) => process.stdout.write(`[default-data] ${msg}\n`)

function fail(msg) {
  process.stderr.write(`[default-data] ERROR: ${msg}\n`)
  process.exit(1)
}

/** A filesystem-safe cache key for one repo at one ref. */
function cacheKey(url, ref) {
  return `${url.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}@${ref}`
}

/**
 * Clone `url` at `ref` into the cache and return the path.
 *
 * Cached by `<repo>@<ref>`: pinned refs make this a perfect hit, so a build that
 * changes no data pays nothing. `--offline` refuses to reach the network at all,
 * which is what makes an offline build fail loudly instead of silently producing
 * an app with no default data.
 */
function cloneCached(url, ref, label) {
  const dest = join(CACHE_DIR, cacheKey(url, ref))
  if (existsSync(join(dest, '.git'))) {
    log(`${label}: cached`)
    return dest
  }
  if (OFFLINE) fail(`--offline, and ${label} is not in the cache (${url}@${ref})`)

  log(`${label}: cloning ${url}@${ref}`)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', ref, url, dest], { stdio: 'pipe' })
  } catch (e) {
    fail(`could not clone ${label} (${url}@${ref})\n${e.stderr?.toString() ?? e.message}`)
  }
  // LFS-tracked Parquet would otherwise land as 3-line pointer files, and the
  // seeded database would mount nothing. Only when the repo actually declares it.
  if (existsSync(join(dest, '.gitattributes'))
    && readFileSync(join(dest, '.gitattributes'), 'utf-8').includes('filter=lfs')) {
    try {
      execFileSync('git', ['lfs', 'pull'], { cwd: dest, stdio: 'pipe' })
    } catch (e) {
      fail(`${label} tracks files with git-lfs, but \`git lfs pull\` failed. `
        + `Install git-lfs, or its Parquet will be pointer files.\n${e.stderr?.toString() ?? e.message}`)
    }
  }
  return dest
}

/** Copy a cloned tree, minus its own git metadata. */
function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true, filter: (src) => !/(^|[/\\])\.git([/\\]|$)/.test(src) })
}

function main() {
  if (PROFILE === 'lean') {
    // A portal starts from an empty instance and brings its own content, so it
    // bakes nothing. Clear any previous build's seed rather than leaving a stale one.
    log('profile=lean — no default data will be bundled')
    rmSync(SEED_DIR, { recursive: true, force: true })
    mkdirSync(SEED_DIR, { recursive: true })
    writeFileSync(join(SEED_DIR, 'seed.json'), `${JSON.stringify(buildSeedRoot([]), null, 2)}\n`)
    return
  }

  const wsRepo = cloneCached(WORKSPACE_URL, WORKSPACE_REF, 'workspace')
  const target = join(SEED_DIR, WORKSPACE_FOLDER)
  copyTree(wsRepo, target)

  // Splice each git-linked child's repo over the pointer folder the workspace
  // exported. The pointer carries identity + the remote; the content lives in the
  // linked repo, exactly as `cloneWorkspaceChildren` resolves it at runtime.
  const linksFile = join(target, 'git-links.json')
  const links = existsSync(linksFile)
    ? (JSON.parse(readFileSync(linksFile, 'utf-8')).links ?? [])
    : []
  log(`${links.length} git-linked ${links.length === 1 ? 'child' : 'children'}`)

  for (const link of links) {
    const dir = TYPE_DIR[link.type]
    if (!dir) {
      // A type this build does not know how to place. Say so — a silent skip
      // would ship a workspace missing an entity nobody noticed was gone.
      log(`SKIP ${link.type}/${link.folder}: unknown entity type`)
      continue
    }
    const child = cloneCached(link.url, link.branch || 'main', `${link.type}/${link.folder}`)
    copyTree(child, join(target, dir, link.folder))
  }

  // Index the assembled tree. The generator is shared with linkr-portal's build,
  // so both produce the same manifest from the same tree.
  const manifest = buildSeedManifest(new FsTree(target), {
    organization: readJsonIfPresent(join(target, 'organization.json')),
    // Where the browser will fetch the baked tree from — `public/` is served at
    // the site root, and BASE_URL is prepended by the loader itself.
    seedBaseUrl: `/data/seed/${WORKSPACE_FOLDER}`,
    // `linkToProject` per database: the one seed-only link, since the export
    // strips linkedDataSourceIds. Absent = the databases seed unlinked, which is
    // exactly what a plain import does.
    databases: readJsonIfPresent(join(ROOT, 'scripts/default-data-links.json')) ?? {},
  })
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(
    join(SEED_DIR, 'seed.json'),
    `${JSON.stringify(buildSeedRoot([WORKSPACE_FOLDER]), null, 2)}\n`,
  )

  // A `demo` build that fetched nothing must fail rather than ship looking like a
  // `lean` one — an app silently missing its default data is far worse than a
  // build that stops and says so.
  if (!manifest.entities.length && !manifest.internals) {
    fail('the workspace was fetched but indexed to nothing — refusing to ship an empty seed')
  }
  log(`${manifest.entities.length} entities indexed → ${target}`)
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    fail(`${path} is not valid JSON: ${e.message}`)
  }
}

main()
