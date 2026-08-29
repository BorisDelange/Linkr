/**
 * Vite plugin that generates per-entity SHA-256 hashes for seed data.
 *
 * At build time (and dev server start, and on HMR), it reads the root
 * `public/data/seed/seed.json` (the list of workspace folders), then each workspace's
 * unified `<folder>/manifest.json`, and writes `public/data/seed/seed-hashes.json` with
 * one hash per logical entity. The frontend compares these hashes against localStorage to
 * detect seed data updates between deployments.
 *
 * The plugin iterates the SAME `manifest.entities` list the seed loader consumes, so the
 * change-detection baseline can't drift from what actually gets loaded.
 */

import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { Plugin, ViteDevServer } from 'vite'
import { SEED_HASHES_SCHEMA_VERSION } from './src/lib/seed-schema-version'

// ---------------------------------------------------------------------------
// Types (mirror the relevant parts of seed-loader.ts's WorkspaceManifest)
// ---------------------------------------------------------------------------

type SeedEntityKind =
  | 'database' | 'conceptMapping' | 'etlScript' | 'dataset' | 'dashboard'
  | 'project' | 'mappingProject' | 'dqRuleSet' | 'catalog' | 'etlPipeline'

interface ManifestEntity {
  type: SeedEntityKind
  id: string
  // database
  name?: string
  // conceptMapping / etlScript / dataset / dashboard
  file?: string
  fileName?: string
  customMappingsFile?: string
  // project / mappingProject
  folder?: string
  // dqRuleSet / catalog
  path?: string
  [key: string]: unknown
}

interface WorkspaceManifest {
  schemaVersion?: number
  entities?: ManifestEntity[]
}

interface SeedRoot {
  schemaVersion?: number
  workspaces?: string[]
}

// ---------------------------------------------------------------------------
// Hash output shape
// ---------------------------------------------------------------------------

export interface SeedEntityHashes {
  workspace: string
  databases: Record<string, string>
  conceptMappings: Record<string, string>
  etlScripts: Record<string, string>
  datasets: Record<string, string>
  dashboards: Record<string, string>
  projects: Record<string, string>
  mappingProjects: Record<string, string>
  dqRuleSets: Record<string, string>
  catalogs: Record<string, string>
  /** Optional so pre-existing baselines (persisted before ETL pipelines were a
   *  first-class seed entity) still satisfy the type — they diff as "no etl". */
  etlPipelines?: Record<string, string>
  /**
   * Human-readable names per entity, keyed like the hash maps above. Purely additive
   * and display-only — never compared — so old baselines (without it) still diff fine.
   */
  names?: SeedEntityNames
  /** Readable workspace name (the workspace hash is opaque). */
  workspaceName?: string
  /**
   * Stable identity of the workspace occupying this folder (its lineageId, else its
   * id). A folder is a location, not an identity: replacing the bundled workspace
   * with a different one reuses `default/`, and comparing hashes alone read that as
   * "the same workspace changed" — so the old one was updated in place, never
   * removed, and its now-orphaned row sat beside the newly created one.
   *
   * Optional: a baseline stored before this field existed has none, and a workspace
   * that declares neither id yields none, so the diff falls back to hash comparison.
   */
  workspaceIdentity?: string
}

export interface SeedEntityNames {
  databases: Record<string, string>
  conceptMappings: Record<string, string>
  etlScripts: Record<string, string>
  datasets: Record<string, string>
  dashboards: Record<string, string>
  projects: Record<string, string>
  mappingProjects: Record<string, string>
  dqRuleSets: Record<string, string>
  catalogs: Record<string, string>
  etlPipelines?: Record<string, string>
}

export interface SeedHashesManifest {
  /** Bumped when the baseline schema changes; an old/absent value triggers a silent reset. */
  schemaVersion: number
  workspaces: Record<string, SeedEntityHashes>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16)
}

function readFileOrEmpty(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** Hash a file referenced by a path relative to `public/` (may start with `/`). */
function hashPublicFile(publicDir: string, filePath: string): string {
  const resolved = resolve(publicDir, filePath.replace(/^\//, ''))
  return sha256(readFileOrEmpty(resolved))
}

/** A name may be a plain string or a LocalizedString ({en, fr, …}); pick something readable. */
function readableName(name: unknown): string | null {
  if (typeof name === 'string') return name || null
  if (name && typeof name === 'object') {
    const m = name as Record<string, string>
    return m.en ?? m.fr ?? Object.values(m)[0] ?? null
  }
  return null
}

/** Parse a JSON file at an absolute path and return a readable name via a getter. */
function nameFromFile(absPath: string, get: (o: Record<string, unknown>) => unknown): string | null {
  try {
    const o = JSON.parse(readFileOrEmpty(absPath)) as Record<string, unknown>
    return readableName(get(o))
  } catch {
    return null
  }
}

/**
 * The workspace's stable identity: `lineageId` (which survives export/reimport across
 * instances) if present, else its `id`. Null when it declares neither.
 */
function workspaceIdentity(absPath: string): string | null {
  try {
    const o = JSON.parse(readFileOrEmpty(absPath)) as Record<string, unknown>
    for (const key of ['lineageId', 'id', 'uid']) {
      const value = o[key]
      if (typeof value === 'string' && value) return value
    }
    return null
  } catch {
    return null
  }
}

/** Empty per-type hash/name maps. */
function emptyMaps(): SeedEntityNames {
  return {
    databases: {}, conceptMappings: {}, etlScripts: {}, datasets: {},
    dashboards: {}, projects: {}, mappingProjects: {}, dqRuleSets: {}, catalogs: {},
    etlPipelines: {},
  }
}

/** Map an entity kind to the SeedEntityHashes map key it lives under. */
const KIND_TO_KEY: Record<SeedEntityKind, keyof SeedEntityNames> = {
  database: 'databases',
  conceptMapping: 'conceptMappings',
  etlScript: 'etlScripts',
  dataset: 'datasets',
  dashboard: 'dashboards',
  project: 'projects',
  mappingProject: 'mappingProjects',
  dqRuleSet: 'dqRuleSets',
  catalog: 'catalogs',
  etlPipeline: 'etlPipelines',
}

// ---------------------------------------------------------------------------
// Per-entity hashing (mirrors what the seed loader reads for each kind)
// ---------------------------------------------------------------------------

/** Returns [hash, name] for one manifest entity, or null to skip. */
function hashEntity(
  publicDir: string, wsDir: string, entity: ManifestEntity,
): { hash: string; name: string } | null {
  switch (entity.type) {
    case 'database':
      // Config only (not parquet bytes), like the old seed.json-entry hash.
      return { hash: sha256(JSON.stringify(entity)), name: readableName(entity.name) ?? entity.id }

    case 'conceptMapping':
      if (!entity.file) return null
      return { hash: hashPublicFile(publicDir, entity.file), name: entity.id }

    case 'etlScript': {
      if (!entity.file) return null
      let content = readFileOrEmpty(resolve(publicDir, entity.file.replace(/^\//, '')))
      if (entity.customMappingsFile) {
        content += readFileOrEmpty(resolve(publicDir, entity.customMappingsFile.replace(/^\//, '')))
      }
      return { hash: sha256(content), name: entity.id }
    }

    case 'dataset':
      if (!entity.file) return null
      return { hash: hashPublicFile(publicDir, entity.file), name: entity.fileName ?? entity.id }

    case 'dashboard': {
      if (!entity.file) return null
      const abs = resolve(publicDir, entity.file.replace(/^\//, ''))
      const name = nameFromFile(abs, (o) => (o.dashboard as Record<string, unknown> | undefined)?.name) ?? entity.id
      return { hash: hashPublicFile(publicDir, entity.file), name }
    }

    case 'project': {
      const projDir = join(wsDir, 'projects', entity.folder ?? entity.id)
      const projJson = readFileOrEmpty(join(projDir, 'project.json'))
      const readme = readFileOrEmpty(join(projDir, 'README.md'))
      const name = nameFromFile(join(projDir, 'project.json'), (o) => o.name) ?? (entity.folder ?? entity.id)
      return { hash: sha256(projJson + readme), name }
    }

    case 'mappingProject': {
      const mpDir = join(wsDir, 'mapping-projects', entity.folder ?? entity.id)
      const projJson = readFileOrEmpty(join(mpDir, '_project.json'))
      const name = nameFromFile(join(mpDir, '_project.json'), (o) => o.name) ?? (entity.folder ?? entity.id)
      return { hash: sha256(projJson), name }
    }

    case 'dqRuleSet': {
      if (!entity.path) return null
      const abs = join(wsDir, entity.path)
      const name = nameFromFile(abs, (o) => (o.ruleSet as Record<string, unknown> | undefined)?.name ?? o.name) ?? entity.id
      return { hash: sha256(readFileOrEmpty(abs)), name }
    }

    case 'catalog': {
      if (!entity.path) return null
      const abs = join(wsDir, entity.path)
      const name = nameFromFile(abs, (o) => o.name) ?? entity.id
      return { hash: sha256(readFileOrEmpty(abs)), name }
    }

    case 'etlPipeline': {
      // Only _pipeline.json is hashed here: the tree + scripts are seeded and
      // change-detected separately via the per-script `etlScript` entries, so their
      // content is intentionally out of scope for this pipeline-level hash.
      const etlDir = join(wsDir, 'etl', entity.folder ?? entity.id)
      const pipelineJson = readFileOrEmpty(join(etlDir, '_pipeline.json'))
      const name = nameFromFile(join(etlDir, '_pipeline.json'), (o) => o.name) ?? (entity.folder ?? entity.id)
      return { hash: sha256(pipelineJson), name }
    }
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function generateSeedHashes(publicDir: string): SeedHashesManifest | null {
  const seedJsonPath = join(publicDir, 'data/seed/seed.json')
  if (!existsSync(seedJsonPath)) return null

  const root: SeedRoot = JSON.parse(readFileSync(seedJsonPath, 'utf-8'))
  if (!root?.workspaces?.length) return null

  const result: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: {} }

  for (const folder of root.workspaces) {
    const wsDir = join(publicDir, 'data/seed', folder)
    const manifestPath = join(wsDir, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    let manifest: WorkspaceManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    } catch { continue }

    const names = emptyMaps()
    const entityHashes: SeedEntityHashes = {
      workspace: '',
      databases: {}, conceptMappings: {}, etlScripts: {}, datasets: {},
      dashboards: {}, projects: {}, mappingProjects: {}, dqRuleSets: {}, catalogs: {},
      etlPipelines: {},
      names,
    }

    // Workspace metadata: its own file + the manifest (so internals/org edits show up).
    // entity.json is where a workspace lives now that the seed is one exported tree per
    // entity; workspace.json was the name before that, and a seed baked by an older
    // build still uses it. Reading only the latter hashed an empty string here and made
    // every workspace fall back to its folder name.
    const wsPath = existsSync(join(wsDir, 'entity.json'))
      ? join(wsDir, 'entity.json')
      : join(wsDir, 'workspace.json')
    const wsJson = readFileOrEmpty(wsPath)
    const manifestJson = readFileOrEmpty(manifestPath)
    entityHashes.workspace = sha256(wsJson + manifestJson)
    entityHashes.workspaceName = nameFromFile(wsPath, (o) => o.name) ?? folder
    entityHashes.workspaceIdentity = workspaceIdentity(wsPath) ?? undefined

    for (const entity of manifest.entities ?? []) {
      const key = KIND_TO_KEY[entity.type]
      if (!key) continue
      const hashed = hashEntity(publicDir, wsDir, entity)
      if (!hashed) continue
      ;(entityHashes[key] as Record<string, string>)[entity.id] = hashed.hash
      ;(names[key] ??= {})[entity.id] = hashed.name
    }

    result.workspaces[folder] = entityHashes
  }

  return result
}

/** Generate the hashes and write seed-hashes.json. Returns true if it wrote a file. */
function writeSeedHashes(publicDir: string): boolean {
  const hashes = generateSeedHashes(publicDir)
  if (!hashes) return false
  const outPath = join(publicDir, 'data/seed/seed-hashes.json')
  writeFileSync(outPath, JSON.stringify(hashes, null, 2), 'utf-8')
  return true
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default function seedHashesPlugin(): Plugin {
  let publicDir: string

  return {
    name: 'linkr-seed-hashes',

    configResolved(config) {
      publicDir = config.publicDir
    },

    // Generate hashes at build start and dev server start
    buildStart() {
      if (writeSeedHashes(publicDir)) console.info('[seed-hashes] Generated seed-hashes.json')
    },

    // In dev, regenerate whenever a seed file changes so editing the seed no longer
    // requires a dev-server restart for the change-detection dialog to see it.
    configureServer(server: ViteDevServer) {
      const seedDir = join(publicDir, 'data', 'seed')
      const ownOutput = join(seedDir, 'seed-hashes.json')

      const regenerate = (file: string) => {
        // Watch the seed dir, plus the data/*.json files it references (datasets,
        // mappings, etl scripts live under public/data/, not under seed/).
        const inSeed = file.startsWith(seedDir + sep)
        const inData = file.startsWith(join(publicDir, 'data') + sep) && file.endsWith('.json')
        if (!inSeed && !inData) return
        if (file === ownOutput) return // ignore our own write, avoid a feedback loop
        if (writeSeedHashes(publicDir)) {
          server.config.logger.info('[seed-hashes] Regenerated seed-hashes.json', { timestamp: true })
        }
      }

      server.watcher.add(seedDir)
      server.watcher.on('add', regenerate)
      server.watcher.on('change', regenerate)
      server.watcher.on('unlink', regenerate)
    },
  }
}
