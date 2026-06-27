/**
 * Seed change detector — compares per-entity seed hashes between builds.
 *
 * At first seed, hashes from `seed-hashes.json` are stored in localStorage.
 * On subsequent builds, this module compares stored vs. current hashes to
 * produce a detailed list of what changed (added / modified / removed).
 */

import { SEED_HASHES_SCHEMA_VERSION } from './seed-schema-version'
import type { SeedHashesManifest, SeedEntityHashes, SeedEntityNames } from '../../vite-plugin-seed-hashes'

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

/**
 * Advance the stored baseline to `current` for ONLY the given entities, leaving every
 * other entity's stored hash untouched. Used after a targeted re-seed so the entities
 * the user refreshed stop notifying, while the ones they skipped still notify next time.
 */
export function mergeSeedHashesFor(
  stored: SeedHashesManifest | null,
  current: SeedHashesManifest,
  entities: Array<{ workspaceFolder: string; entityType: SeedEntityType; entityId: string }>,
): SeedHashesManifest {
  // Deep clone the stored baseline (or start from empty) so we never mutate inputs.
  const merged: SeedHashesManifest = stored
    ? JSON.parse(JSON.stringify(stored)) as SeedHashesManifest
    : { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: {} }

  const keyForType = new Map<SeedEntityType, keyof SeedEntityHashes>(
    ENTITY_KEYS.map(({ key, type }) => [type, key]),
  )

  for (const { workspaceFolder, entityType, entityId } of entities) {
    const curWs = current.workspaces[workspaceFolder]
    if (!curWs) continue
    if (!merged.workspaces[workspaceFolder]) {
      // Whole workspace is new in the baseline — copy its current hashes wholesale.
      merged.workspaces[workspaceFolder] = JSON.parse(JSON.stringify(curWs)) as SeedEntityHashes
      continue
    }
    const mergedWs = merged.workspaces[workspaceFolder]

    if (entityType === 'workspace') {
      mergedWs.workspace = curWs.workspace
      continue
    }

    const mapKey = keyForType.get(entityType)
    if (!mapKey) continue
    const curMap = curWs[mapKey] as Record<string, string>
    const mergedMap = mergedWs[mapKey] as Record<string, string>
    if (entityId in curMap) {
      mergedMap[entityId] = curMap[entityId]
    } else {
      // Entity was removed from the seed — drop it from the baseline too.
      delete mergedMap[entityId]
    }
  }

  return merged
}

/**
 * Remove the given entities from the stored baseline (independent of the current build), so a
 * deleted 'removed' entity stops being reported. Unlike mergeSeedHashesFor (which advances
 * toward the current build), this is for deletions: a removed entity is absent from the current
 * build, so there's nothing to advance to — we just drop it. Deleting a 'workspace' entity drops
 * the whole workspace from the baseline (its children go with it).
 */
export function dropFromSeedHashes(
  stored: SeedHashesManifest | null,
  entities: Array<{ workspaceFolder: string; entityType: SeedEntityType; entityId: string }>,
): SeedHashesManifest {
  const merged: SeedHashesManifest = stored
    ? JSON.parse(JSON.stringify(stored)) as SeedHashesManifest
    : { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: {} }

  const keyForType = new Map<SeedEntityType, keyof SeedEntityHashes>(
    ENTITY_KEYS.map(({ key, type }) => [type, key]),
  )

  for (const { workspaceFolder, entityType, entityId } of entities) {
    const mergedWs = merged.workspaces[workspaceFolder]
    if (!mergedWs) continue
    if (entityType === 'workspace') {
      delete merged.workspaces[workspaceFolder]
      continue
    }
    const mapKey = keyForType.get(entityType)
    if (!mapKey) continue
    delete (mergedWs[mapKey] as Record<string, string>)[entityId]
  }

  return merged
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
  nameMap?: Record<string, string>,
): void {
  const prev = oldMap ?? {}
  const next = newMap ?? {}
  const label = (id: string) => nameMap?.[id] ?? id

  // Added or modified
  for (const [id, hash] of Object.entries(next)) {
    if (!(id in prev)) {
      changes.push({ workspaceFolder, workspaceName, entityType, entityId: id, entityLabel: label(id), changeType: 'added' })
    } else if (prev[id] !== hash) {
      changes.push({ workspaceFolder, workspaceName, entityType, entityId: id, entityLabel: label(id), changeType: 'modified' })
    }
  }

  // Removed
  for (const id of Object.keys(prev)) {
    if (!(id in next)) {
      changes.push({ workspaceFolder, workspaceName, entityType, entityId: id, entityLabel: label(id), changeType: 'removed' })
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
/**
 * Whether a stored baseline must be discarded rather than diffed: absent (first visit) or in an
 * older schema (e.g. the pre-manifest format). Pure — the caller does the silent reset.
 */
export function isBaselineStale(stored: SeedHashesManifest | null): boolean {
  return !stored || stored.schemaVersion !== SEED_HASHES_SCHEMA_VERSION
}

/**
 * Pure diff of two seed-hash baselines into a change list. No I/O — `detectSeedChanges` wraps it
 * with fetch/localStorage. Either workspace side may be missing (a whole workspace added/removed),
 * in which case its children are still listed (diffHashMap treats a missing side as empty).
 */
export function diffSeedHashes(stored: SeedHashesManifest, current: SeedHashesManifest): SeedChange[] {
  const changes: SeedChange[] = []

  const allFolders = new Set([
    ...Object.keys(stored.workspaces),
    ...Object.keys(current.workspaces),
  ])

  for (const folder of allFolders) {
    const oldWs = stored.workspaces[folder]
    const newWs = current.workspaces[folder]
    // Readable workspace name comes from the current build (the new name wins on display).
    const wsName = newWs?.workspaceName ?? oldWs?.workspaceName ?? folder

    // Workspace-level row: added / removed (whole workspace) or modified (metadata only).
    // We fall through to the per-type diff in every case, so a brand-new or fully-removed
    // workspace also lists its child entities (the user sees what they'll get / lose).
    if (!oldWs && newWs) {
      changes.push({ workspaceFolder: folder, workspaceName: wsName, entityType: 'workspace', entityId: folder, entityLabel: wsName, changeType: 'added' })
    } else if (oldWs && !newWs) {
      changes.push({ workspaceFolder: folder, workspaceName: wsName, entityType: 'workspace', entityId: folder, entityLabel: wsName, changeType: 'removed' })
    } else if (oldWs!.workspace !== newWs!.workspace) {
      changes.push({ workspaceFolder: folder, workspaceName: wsName, entityType: 'workspace', entityId: folder, entityLabel: wsName, changeType: 'modified' })
    }

    // Diff each entity type, labelling entities with their readable name when available.
    // Either side may be undefined (a whole workspace added or removed) — diffHashMap and the
    // name merge below both treat a missing side as an empty map.
    for (const { key, type } of ENTITY_KEYS) {
      const nameKey = key as keyof SeedEntityNames
      // Merge stored + current names (current wins). Stored is the only source of a
      // name for a 'removed' entity — it no longer exists in the current build.
      const nameMap = { ...(oldWs?.names?.[nameKey] ?? {}), ...(newWs?.names?.[nameKey] ?? {}) }
      diffHashMap(
        oldWs?.[key] as Record<string, string> | undefined,
        newWs?.[key] as Record<string, string> | undefined,
        type,
        folder,
        wsName,
        changes,
        nameMap,
      )
    }
  }

  return changes
}

export async function detectSeedChanges(): Promise<SeedDiffResult> {
  const current = await fetchSeedHashes()
  if (!current) return { hasChanges: false, changes: [] }

  const stored = getStoredSeedHashes()
  if (isBaselineStale(stored)) {
    // First visit or an obsolete-schema baseline: treat as a fresh baseline — silently store the
    // current hashes and report no changes, so it never triggers a spurious "everything changed".
    storeSeedHashes(current)
    return { hasChanges: false, changes: [] }
  }

  const changes = diffSeedHashes(stored!, current)
  return { hasChanges: changes.length > 0, changes }
}
