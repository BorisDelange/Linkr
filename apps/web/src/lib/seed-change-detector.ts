/**
 * Seed change detector — compares per-entity seed hashes between builds.
 *
 * At first seed, hashes from `seed-hashes.json` are stored in localStorage.
 * On subsequent builds, this module compares stored vs. current hashes to
 * produce a detailed list of what changed (added / modified / removed).
 */

import type { SeedHashesManifest, SeedEntityHashes } from '../../vite-plugin-seed-hashes'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SeedChangeType = 'added' | 'modified' | 'removed'

export type SeedEntityType =
  | 'workspace'
  | 'database'
  | 'conceptMapping'
  | 'etlScript'
  | 'dataset'
  | 'dashboard'
  | 'project'
  | 'mappingProject'
  | 'dqRuleSet'
  | 'catalog'

export interface SeedChange {
  workspaceFolder: string
  workspaceName?: string
  entityType: SeedEntityType
  entityId: string
  entityLabel: string
  changeType: SeedChangeType
}

export interface SeedDiffResult {
  hasChanges: boolean
  changes: SeedChange[]
}

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

const SEED_HASHES_KEY = 'linkr-seed-hashes'

export function getStoredSeedHashes(): SeedHashesManifest | null {
  const raw = localStorage.getItem(SEED_HASHES_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SeedHashesManifest
  } catch {
    return null
  }
}

export function storeSeedHashes(hashes: SeedHashesManifest): void {
  localStorage.setItem(SEED_HASHES_KEY, JSON.stringify(hashes))
}

// ---------------------------------------------------------------------------
// Fetch hashes from build artifact
// ---------------------------------------------------------------------------

const SEED_HASHES_URL = `${import.meta.env.BASE_URL}data/seed/seed-hashes.json`.replace(/\/\//g, '/')

export async function fetchSeedHashes(): Promise<SeedHashesManifest | null> {
  try {
    const res = await fetch(SEED_HASHES_URL)
    if (!res.ok) return null
    return await res.json() as SeedHashesManifest
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Diff logic
// ---------------------------------------------------------------------------

/** Compare two Record<string, string> hash maps and emit changes. */
function diffHashMap(
  oldMap: Record<string, string> | undefined,
  newMap: Record<string, string> | undefined,
  entityType: SeedEntityType,
  workspaceFolder: string,
  workspaceName: string | undefined,
  changes: SeedChange[],
): void {
  const prev = oldMap ?? {}
  const next = newMap ?? {}

  // Added or modified
  for (const [id, hash] of Object.entries(next)) {
    if (!(id in prev)) {
      changes.push({ workspaceFolder, workspaceName, entityType, entityId: id, entityLabel: id, changeType: 'added' })
    } else if (prev[id] !== hash) {
      changes.push({ workspaceFolder, workspaceName, entityType, entityId: id, entityLabel: id, changeType: 'modified' })
    }
  }

  // Removed
  for (const id of Object.keys(prev)) {
    if (!(id in next)) {
      changes.push({ workspaceFolder, workspaceName, entityType, entityId: id, entityLabel: id, changeType: 'removed' })
    }
  }
}

/** All hash map keys on a SeedEntityHashes that should be diffed. */
const ENTITY_KEYS: Array<{ key: keyof SeedEntityHashes; type: SeedEntityType }> = [
  { key: 'databases', type: 'database' },
  { key: 'conceptMappings', type: 'conceptMapping' },
  { key: 'etlScripts', type: 'etlScript' },
  { key: 'datasets', type: 'dataset' },
  { key: 'dashboards', type: 'dashboard' },
  { key: 'projects', type: 'project' },
  { key: 'mappingProjects', type: 'mappingProject' },
  { key: 'dqRuleSets', type: 'dqRuleSet' },
  { key: 'catalogs', type: 'catalog' },
]

/**
 * Detect seed data changes between the stored hashes and the current build.
 * Returns a detailed diff. If hashes cannot be fetched, returns no changes.
 */
export async function detectSeedChanges(): Promise<SeedDiffResult> {
  const current = await fetchSeedHashes()
  if (!current) return { hasChanges: false, changes: [] }

  const stored = getStoredSeedHashes()
  if (!stored) {
    // No stored hashes — first visit or pre-feature build.
    // Store current and report no changes (will be seeded fresh).
    storeSeedHashes(current)
    return { hasChanges: false, changes: [] }
  }

  const changes: SeedChange[] = []

  const allFolders = new Set([
    ...Object.keys(stored.workspaces),
    ...Object.keys(current.workspaces),
  ])

  for (const folder of allFolders) {
    const oldWs = stored.workspaces[folder]
    const newWs = current.workspaces[folder]

    // Entire workspace added
    if (!oldWs && newWs) {
      changes.push({
        workspaceFolder: folder,
        entityType: 'workspace',
        entityId: folder,
        entityLabel: folder,
        changeType: 'added',
      })
      continue
    }

    // Entire workspace removed
    if (oldWs && !newWs) {
      changes.push({
        workspaceFolder: folder,
        entityType: 'workspace',
        entityId: folder,
        entityLabel: folder,
        changeType: 'removed',
      })
      continue
    }

    // Both exist — check workspace metadata
    if (oldWs!.workspace !== newWs!.workspace) {
      changes.push({
        workspaceFolder: folder,
        entityType: 'workspace',
        entityId: folder,
        entityLabel: folder,
        changeType: 'modified',
      })
    }

    // Diff each entity type
    for (const { key, type } of ENTITY_KEYS) {
      diffHashMap(
        oldWs![key] as Record<string, string>,
        newWs![key] as Record<string, string>,
        type,
        folder,
        undefined,
        changes,
      )
    }
  }

  return { hasChanges: changes.length > 0, changes }
}
