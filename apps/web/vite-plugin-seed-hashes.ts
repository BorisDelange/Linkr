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
import { join, resolve } from 'path'
import type { Plugin } from 'vite'

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
    }

    // --- Workspace metadata ---
    const wsJson = readFileOrEmpty(join(wsDir, 'workspace.json'))
    const indexJson = readFileOrEmpty(join(wsDir, '_index.json'))
    entityHashes.workspace = sha256(wsJson + indexJson)

    // --- Databases (from seed.json entries — config only, not parquet data) ---
    for (const db of entry.databases ?? []) {
      entityHashes.databases[db.id] = sha256(JSON.stringify(db))
    }

    // --- Concept mappings (hash the referenced file) ---
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

    // --- Datasets (hash the referenced file) ---
    for (const ds of entry.datasets ?? []) {
      entityHashes.datasets[ds.id] = hashPublicFile(publicDir, ds.file)
    }

    // --- Dashboards (hash the referenced file) ---
    for (const db of entry.dashboards ?? []) {
      entityHashes.dashboards[db.projectUid] = hashPublicFile(publicDir, db.file)
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
    }

    for (const mpFolder of index.mappingProjects ?? []) {
      const mpDir = join(wsDir, 'mapping-projects', mpFolder)
      const projJson = readFileOrEmpty(join(mpDir, '_project.json'))
      entityHashes.mappingProjects[mpFolder] = sha256(projJson)
    }

    // --- DQ rule sets ---
    for (const dqPath of index.dqRuleSets ?? []) {
      const content = readFileOrEmpty(join(wsDir, dqPath))
      entityHashes.dqRuleSets[dqPath] = sha256(content)
    }

    // --- Catalogs ---
    for (const catPath of index.catalogs ?? []) {
      const content = readFileOrEmpty(join(wsDir, catPath))
      entityHashes.catalogs[catPath] = sha256(content)
    }

    result.workspaces[entry.folder] = entityHashes
  }

  return result
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
      const hashes = generateSeedHashes(publicDir)
      if (!hashes) return

      const outPath = join(publicDir, 'data/seed/seed-hashes.json')
      writeFileSync(outPath, JSON.stringify(hashes, null, 2), 'utf-8')
      console.info('[seed-hashes] Generated seed-hashes.json')
    },
  }
}
