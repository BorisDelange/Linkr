/**
 * Vite plugin that generates per-entity SHA-256 hashes for seed data.
 *
 * At build time (and dev server start), it reads `public/data/seed/seed.json`,
 * traverses every referenced file, and writes `public/data/seed/seed-hashes.json`
 * with one hash per logical entity. The frontend then compares these hashes
 * against localStorage to detect seed data updates between deployments.
 */

import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { Plugin, ViteDevServer } from 'vite'

// ---------------------------------------------------------------------------
// Types (mirror the relevant parts of seed-loader.ts)
// ---------------------------------------------------------------------------

interface SeedDatabase {
  id: string
  [key: string]: unknown
}

interface SeedConceptMappings {
  file: string
  projectId: string
}

interface SeedEtlScripts {
  file: string
  pipelineId: string
  customMappingsFile?: string
}

interface SeedDataset {
  file: string
  id: string
  fileName?: string
}

interface SeedDashboard {
  file: string
  projectUid: string
}

interface SeedWorkspaceEntry {
  folder: string
  organization?: unknown
  databases?: SeedDatabase[]
  conceptMappings?: SeedConceptMappings[]
  etlScripts?: SeedEtlScripts[]
  datasets?: SeedDataset[]
  dashboards?: SeedDashboard[]
}

interface SeedManifest {
  workspaces: SeedWorkspaceEntry[]
}

interface WorkspaceIndex {
  projects?: string[]
  mappingProjects?: string[]
  etlPipelines?: string[]
  dqRuleSets?: string[]
  catalogs?: string[]
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
  /**
   * Human-readable names per entity, keyed like the hash maps above. Purely additive
   * and display-only — never compared — so old baselines (without it) still diff fine.
   */
  names?: SeedEntityNames
  /** Readable workspace name (the workspace hash is opaque). */
  workspaceName?: string
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
}

export interface SeedHashesManifest {
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

/**
 * Hash a file referenced by a path relative to `public/`.
 * The path may start with `/` (e.g. `/data/mimic-iv-concept-mappings.json`).
 */
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

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function generateSeedHashes(publicDir: string): SeedHashesManifest | null {
  const seedJsonPath = join(publicDir, 'data/seed/seed.json')
  if (!existsSync(seedJsonPath)) return null

  const manifest: SeedManifest = JSON.parse(readFileSync(seedJsonPath, 'utf-8'))
  if (!manifest?.workspaces?.length) return null

  const result: SeedHashesManifest = { workspaces: {} }

  for (const entry of manifest.workspaces) {
    const wsDir = join(publicDir, 'data/seed', entry.folder)
    const names: SeedEntityNames = {
      databases: {}, conceptMappings: {}, etlScripts: {}, datasets: {},
      dashboards: {}, projects: {}, mappingProjects: {}, dqRuleSets: {}, catalogs: {},
    }
    const entityHashes: SeedEntityHashes = {
      workspace: '',
      databases: {},
      conceptMappings: {},
      etlScripts: {},
      datasets: {},
      dashboards: {},
      projects: {},
      mappingProjects: {},
      dqRuleSets: {},
      catalogs: {},
      names,
    }

    // --- Workspace metadata ---
    const wsJson = readFileOrEmpty(join(wsDir, 'workspace.json'))
    const indexJson = readFileOrEmpty(join(wsDir, '_index.json'))
    entityHashes.workspace = sha256(wsJson + indexJson)
    entityHashes.workspaceName = nameFromFile(join(wsDir, 'workspace.json'), (o) => o.name) ?? entry.folder

    // --- Databases (from seed.json entries — config only, not parquet data) ---
    for (const db of entry.databases ?? []) {
      entityHashes.databases[db.id] = sha256(JSON.stringify(db))
      names.databases[db.id] = readableName(db.name) ?? db.id
    }

    // --- Concept mappings (hash the referenced file; name = its mapping project) ---
    for (const cm of entry.conceptMappings ?? []) {
      entityHashes.conceptMappings[cm.projectId] = hashPublicFile(publicDir, cm.file)
    }

    // --- ETL scripts (hash file + optional custom mappings file) ---
    for (const etl of entry.etlScripts ?? []) {
      let content = readFileOrEmpty(resolve(publicDir, etl.file.replace(/^\//, '')))
      if (etl.customMappingsFile) {
        content += readFileOrEmpty(resolve(publicDir, etl.customMappingsFile.replace(/^\//, '')))
      }
      entityHashes.etlScripts[etl.pipelineId] = sha256(content)
    }

    // --- Datasets (hash the referenced file; name = its fileName) ---
    for (const ds of entry.datasets ?? []) {
      entityHashes.datasets[ds.id] = hashPublicFile(publicDir, ds.file)
      names.datasets[ds.id] = ds.fileName ?? ds.id
    }

    // --- Dashboards (hash the referenced file; name from the bundle's dashboard.name) ---
    for (const db of entry.dashboards ?? []) {
      entityHashes.dashboards[db.projectUid] = hashPublicFile(publicDir, db.file)
      const n = nameFromFile(resolve(publicDir, db.file.replace(/^\//, "")), (o) => (o.dashboard as Record<string, unknown> | undefined)?.name)
      if (n) names.dashboards[db.projectUid] = n
    }

    // --- Projects & mapping projects from _index.json ---
    let index: WorkspaceIndex = {}
    try {
      index = JSON.parse(indexJson) as WorkspaceIndex
    } catch { /* empty */ }

    for (const projFolder of index.projects ?? []) {
      const projDir = join(wsDir, 'projects', projFolder)
      const projJson = readFileOrEmpty(join(projDir, 'project.json'))
      const readme = readFileOrEmpty(join(projDir, 'README.md'))
      entityHashes.projects[projFolder] = sha256(projJson + readme)
      names.projects[projFolder] = nameFromFile(join(projDir, 'project.json'), (o) => o.name) ?? projFolder
    }

    for (const mpFolder of index.mappingProjects ?? []) {
      const mpDir = join(wsDir, 'mapping-projects', mpFolder)
      const projJson = readFileOrEmpty(join(mpDir, '_project.json'))
      entityHashes.mappingProjects[mpFolder] = sha256(projJson)
      names.mappingProjects[mpFolder] = nameFromFile(join(mpDir, '_project.json'), (o) => o.name) ?? mpFolder
    }

    // Concept-mapping names mirror their mapping project (matched by id). Done after the
    // mapping-projects loop so the lookup map is complete; falls back to the id.
    const mpNameById = new Map<string, string>()
    for (const mpFolder of index.mappingProjects ?? []) {
      const id = nameFromFile(join(wsDir, 'mapping-projects', mpFolder, '_project.json'), (o) => o.id)
      const nm = names.mappingProjects[mpFolder]
      if (id && nm) mpNameById.set(id, nm)
    }
    for (const cm of entry.conceptMappings ?? []) {
      names.conceptMappings[cm.projectId] = mpNameById.get(cm.projectId) ?? cm.projectId
    }

    // ETL names come from each pipeline's _pipeline.json (matched by id == pipelineId).
    for (const pFolder of index.etlPipelines ?? []) {
      const pj = join(wsDir, 'etl', pFolder, '_pipeline.json')
      const id = nameFromFile(pj, (o) => o.id)
      const nm = nameFromFile(pj, (o) => o.name)
      if (id && nm) names.etlScripts[id] = nm
    }

    // --- DQ rule sets ---
    for (const dqPath of index.dqRuleSets ?? []) {
      const content = readFileOrEmpty(join(wsDir, dqPath))
      entityHashes.dqRuleSets[dqPath] = sha256(content)
      names.dqRuleSets[dqPath] = nameFromFile(join(wsDir, dqPath), (o) => (o.ruleSet as Record<string, unknown> | undefined)?.name ?? o.name) ?? dqPath
    }

    // --- Catalogs ---
    for (const catPath of index.catalogs ?? []) {
      const content = readFileOrEmpty(join(wsDir, catPath))
      entityHashes.catalogs[catPath] = sha256(content)
      names.catalogs[catPath] = nameFromFile(join(wsDir, catPath), (o) => o.name) ?? catPath
    }

    result.workspaces[entry.folder] = entityHashes
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
