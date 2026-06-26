/**
 * Targeted re-seed: re-import a chosen subset of seed entities from the bundled data,
 * overwriting the local copy of just those, while keeping all other local data intact.
 *
 * Strategy (works for every entity type without exposing the seed-loader internals):
 *   1. delete the selected entity's rows from IndexedDB (+ children),
 *   2. clear its uniform `linkr-seed-<type>-<id>` guard flag,
 *   3. re-run the idempotent top-level seeders (seedWorkspaces / seedDatabases) — they
 *      only re-create what was deleted/unflagged and skip everything still present,
 *   4. advance the stored seed-hash baseline for the re-seeded entities only.
 *
 * "removed" changes are never re-seeded here — the entity is gone from the seed, so the
 * user is only notified and decides whether to delete the local copy manually.
 */
import { getStorage } from '@/lib/storage'
import { deleteProjectData } from '@/lib/entity-io'
import {
  seedWorkspaces, seedDatabases, clearSeedFlag, clearGlobalSeedFlag,
  fetchProjectChildEntities,
} from '@/lib/seed-loader'
import {
  fetchSeedHashes, getStoredSeedHashes, storeSeedHashes, mergeSeedHashesFor,
  type SeedChange, type SeedEntityType,
} from '@/lib/seed-change-detector'

/**
 * Entity types recreated by seedWorkspaces() (the structural phase, gated by the global
 * SEED_KEY). Re-seeding any of these requires clearing that global flag.
 */
const STRUCTURAL: Set<SeedEntityType> = new Set([
  'workspace', 'project', 'mappingProject', 'dqRuleSet', 'catalog',
])

/** Delete one selected entity's rows (+ children) from IndexedDB and clear its guard flag. */
async function deleteEntity(change: SeedChange): Promise<void> {
  const storage = getStorage()
  const { entityType, entityId } = change

  switch (entityType) {
    case 'workspace':
      // A workspace 'added'/'modified' change only touches workspace.json metadata — its
      // components diff individually. loadSeedWorkspace() updates the existing row in place,
      // so nothing needs deleting; the re-seed below refreshes the metadata.
      break
    case 'project': {
      const proj = (await storage.projects.getAll()).find((p) => p.projectId === entityId)
      if (proj) {
        // deleteProjectData also drops the project's datasets and dashboards, which are
        // separate manifest entities guarded by their own flags. Derive those children from
        // the seed manifest and clear their flags so the re-seed re-imports them too
        // (otherwise the re-seeded project comes back empty).
        const children = await fetchProjectChildEntities(proj.uid)
        for (const child of children) clearSeedFlag(`${child.type}-${child.id}`)
        await deleteProjectData(storage, proj.uid)
        await storage.projects.delete(proj.uid).catch(() => {})
      }
      clearSeedFlag(`project-${entityId}`)
      break
    }
    case 'dataset': {
      await storage.datasetData.delete(entityId).catch(() => {})
      await storage.datasetRawFiles.delete(entityId).catch(() => {})
      await storage.datasetAnalyses.deleteByDataset(entityId).catch(() => {})
      await storage.datasetFiles.delete(entityId).catch(() => {})
      clearSeedFlag(`dataset-${entityId}`)
      break
    }
    case 'dashboard': {
      // entityId is the dashboard id; drop it and its tabs/widgets.
      const tabs = await storage.dashboardTabs.getByDashboard(entityId)
      for (const tab of tabs) await storage.dashboardWidgets.deleteByTab(tab.id).catch(() => {})
      await storage.dashboardTabs.deleteByDashboard(entityId).catch(() => {})
      await storage.dashboards.delete(entityId).catch(() => {})
      clearSeedFlag(`dashboard-${entityId}`)
      break
    }
    case 'database': {
      await storage.files.deleteByDataSource(entityId).catch(() => {})
      await storage.fileHandles.deleteByDataSource(entityId).catch(() => {})
      await storage.databaseStatsCache.delete(entityId).catch(() => {})
      await storage.dataSources.delete(entityId).catch(() => {})
      clearSeedFlag(`database-${entityId}`)
      break
    }
    case 'conceptMapping': {
      // entityId is the mapping-project id whose mappings are re-seeded as a unit.
      await storage.conceptMappings.deleteByProject(entityId).catch(() => {})
      clearSeedFlag(`conceptMapping-${entityId}`)
      break
    }
    case 'etlScript': {
      // entityId is the pipeline id; drop its files (the pipeline row is recreated by seedWorkspaces).
      await storage.etlFiles.deleteByPipeline(entityId).catch(() => {})
      clearSeedFlag(`etlScript-${entityId}`)
      break
    }
    case 'mappingProject': {
      await storage.conceptMappings.deleteByProject(entityId).catch(() => {})
      await storage.mappingProjects.delete(entityId).catch(() => {})
      clearSeedFlag(`mappingProject-${entityId}`)
      break
    }
    case 'dqRuleSet': {
      await storage.dqCustomChecks.deleteByRuleSet(entityId).catch(() => {})
      await storage.dqRuleSets.delete(entityId).catch(() => {})
      clearSeedFlag(`dqRuleSet-${entityId}`)
      break
    }
    case 'catalog': {
      await storage.catalogResults.delete(entityId).catch(() => {})
      await storage.dataCatalogs.delete(entityId).catch(() => {})
      clearSeedFlag(`catalog-${entityId}`)
      break
    }
  }
}

/**
 * Resolve whether the local entity behind a change was created by the seed loader
 * (`origin === 'seed'`). Entities that predate the origin field (origin undefined) are
 * treated as user content and reported as not-seed, so we never auto-delete them.
 *
 * For aggregate types (conceptMapping, etlScript), origin is carried by the parent row
 * (the mapping project / pipeline), which is what entityId points at.
 */
export async function isSeedOrigin(change: SeedChange): Promise<boolean> {
  const storage = getStorage()
  const { entityType, entityId } = change
  const seeded = (row: { origin?: string } | undefined | null) => row?.origin === 'seed'

  switch (entityType) {
    case 'workspace': return seeded(await storage.workspaces.getById(entityId))
    case 'project': {
      const proj = (await storage.projects.getAll()).find((p) => p.projectId === entityId)
      return seeded(proj)
    }
    case 'database': return seeded(await storage.dataSources.getById(entityId))
    case 'dataset': return seeded(await storage.datasetFiles.getById(entityId))
    case 'dashboard': return seeded(await storage.dashboards.getById(entityId))
    case 'mappingProject':
    case 'conceptMapping': return seeded(await storage.mappingProjects.getById(entityId))
    case 'etlScript': return seeded(await storage.etlPipelines.getById(entityId))
    case 'dqRuleSet': return seeded(await storage.dqRuleSets.getById(entityId))
    case 'catalog': return seeded(await storage.dataCatalogs.getById(entityId))
  }
}

/**
 * Delete the local copy of entities that were removed from the seed. Only entities the seed
 * loader created (origin === 'seed') are deleted — user content is never touched, even if it
 * happens to share an id. Returns the changes that were actually deleted.
 */
export async function deleteRemovedSelection(changes: SeedChange[]): Promise<SeedChange[]> {
  const removed = changes.filter((c) => c.changeType === 'removed')
  if (removed.length === 0) return []

  const deleted: SeedChange[] = []
  for (const change of removed) {
    if (!(await isSeedOrigin(change))) continue
    await deleteEntity(change)
    deleted.push(change)
  }
  if (deleted.length === 0) return []

  // Drop the deleted entities from the baseline so they stop being reported as 'removed'.
  // mergeSeedHashesFor drops any entity that is absent from `current` (which they are).
  const current = await fetchSeedHashes()
  if (current) {
    const merged = mergeSeedHashesFor(getStoredSeedHashes(), current, deleted)
    storeSeedHashes(merged)
  }

  return deleted
}

/**
 * Re-seed the selected changes. Ignores 'removed' changes (nothing to re-import).
 * Returns the entities that were actually re-seeded (for caller feedback).
 */
export async function reseedSelection(changes: SeedChange[]): Promise<SeedChange[]> {
  const toReseed = changes.filter((c) => c.changeType !== 'removed')
  if (toReseed.length === 0) return []

  for (const change of toReseed) {
    await deleteEntity(change)
  }

  // Structural entities can only be recreated by seedWorkspaces(), which is gated by the
  // global SEED_KEY — clear it so the re-run actually re-imports them.
  const needsWorkspaceReseed = toReseed.some((c) => STRUCTURAL.has(c.entityType))
  if (needsWorkspaceReseed) {
    clearGlobalSeedFlag()
    await seedWorkspaces()
  }
  // seedDatabases() re-creates the data-phase entities (database/conceptMapping/etlScript/
  // dataset/dashboard) whose guard flags we cleared above; everything still flagged is skipped.
  await seedDatabases()

  // Advance the baseline for the re-seeded entities only, so the others still notify later.
  const current = await fetchSeedHashes()
  if (current) {
    const merged = mergeSeedHashesFor(getStoredSeedHashes(), current, toReseed)
    storeSeedHashes(merged)
  }

  return toReseed
}
