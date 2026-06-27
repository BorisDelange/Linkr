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
  fetchSeedHashes, getStoredSeedHashes, storeSeedHashes, mergeSeedHashesFor, dropFromSeedHashes,
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
/**
 * Disposition of a removed entity's local copy:
 *  - 'seed' : a seed-created row exists locally → safe to delete.
 *  - 'gone' : no local row (already deleted, or never imported) → nothing to delete, just drop
 *             it from the baseline so the notification stops.
 *  - 'user' : a row exists but isn't seed-origin (user content / pre-origin data) → never touch.
 * The checkbox is offered for 'seed' and 'gone'; only 'seed' triggers an actual delete.
 */
export type RemovedDisposition = 'seed' | 'gone' | 'user'

/**
 * Classify a local row's disposition: no row → 'gone' (just drop from baseline); seed-origin →
 * 'seed' (safe to delete); anything else (user content / pre-origin data) → 'user' (never touch).
 * The safety-critical rule: only an explicit origin === 'seed' is ever deletable.
 */
export function classifyDisposition(row: { origin?: string } | undefined | null): RemovedDisposition {
  if (!row) return 'gone'
  return row.origin === 'seed' ? 'seed' : 'user'
}

export async function removedDisposition(change: SeedChange): Promise<RemovedDisposition> {
  const storage = getStorage()
  const { entityType, entityId } = change
  const disp = classifyDisposition

  switch (entityType) {
    case 'workspace':
      // A workspace change's entityId is the seed FOLDER, not the local workspace id, and a
      // removed workspace has no folder→id mapping left. Workspace deletability is derived from
      // its children (see deleteRemovedSelection / the dialog), not from here.
      return 'gone'
    case 'project': {
      const proj = (await storage.projects.getAll()).find((p) => p.projectId === entityId)
      return disp(proj)
    }
    case 'database': return disp(await storage.dataSources.getById(entityId))
    case 'dataset': return disp(await storage.datasetFiles.getById(entityId))
    case 'dashboard': return disp(await storage.dashboards.getById(entityId))
    case 'mappingProject':
    case 'conceptMapping': return disp(await storage.mappingProjects.getById(entityId))
    case 'etlScript': return disp(await storage.etlPipelines.getById(entityId))
    case 'dqRuleSet': return disp(await storage.dqRuleSets.getById(entityId))
    case 'catalog': return disp(await storage.dataCatalogs.getById(entityId))
  }
}

/** Resolve the workspaceId of the local row behind a (non-workspace) change, if any. */
async function resolveWorkspaceIdOf(change: SeedChange): Promise<string | undefined> {
  const storage = getStorage()
  const { entityType, entityId } = change
  const wsOf = (row: { workspaceId?: string } | undefined | null) => row?.workspaceId

  switch (entityType) {
    case 'project': {
      const proj = (await storage.projects.getAll()).find((p) => p.projectId === entityId)
      return wsOf(proj)
    }
    case 'database': return wsOf(await storage.dataSources.getById(entityId))
    case 'mappingProject':
    case 'conceptMapping': return wsOf(await storage.mappingProjects.getById(entityId))
    case 'etlScript': return wsOf(await storage.etlPipelines.getById(entityId))
    case 'dqRuleSet': return wsOf(await storage.dqRuleSets.getById(entityId))
    case 'catalog': return wsOf(await storage.dataCatalogs.getById(entityId))
    case 'dataset': {
      const df = await storage.datasetFiles.getById(entityId)
      if (!df) return undefined
      const proj = await storage.projects.getById(df.projectUid)
      return proj?.workspaceId
    }
    case 'dashboard': {
      const dash = await storage.dashboards.getById(entityId)
      if (!dash) return undefined
      const proj = await storage.projects.getById(dash.projectUid)
      return proj?.workspaceId
    }
    default: return undefined
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

  const storage = getStorage()
  const handled: SeedChange[] = []
  // workspaceFolder → a local workspace id resolved from one of its children, captured before
  // the child is deleted so we can delete the workspace shell afterwards.
  const wsIdByFolder = new Map<string, string>()
  // Folders with at least one user-origin child: their workspace shell must NOT be dropped from
  // the baseline (it still holds that user content — we never touch it).
  const foldersWithUserContent = new Set<string>()

  // Non-workspace entities. 'seed' → delete the local row; 'gone' → already absent, just drop it
  // from the baseline; 'user' → never touch. Record the parent workspace id along the way (the
  // removed seed folder no longer carries the folder→id mapping a workspace row would need).
  for (const change of removed) {
    if (change.entityType === 'workspace') continue
    const disp = await removedDisposition(change)
    if (disp === 'user') {
      foldersWithUserContent.add(change.workspaceFolder)
      continue
    }
    if (!wsIdByFolder.has(change.workspaceFolder)) {
      const wsId = await resolveWorkspaceIdOf(change)
      if (wsId) wsIdByFolder.set(change.workspaceFolder, wsId)
    }
    if (disp === 'seed') await deleteEntity(change)
    handled.push(change) // both 'seed' and 'gone' clear from the baseline below
  }

  // Whole-workspace row: its seed folder is gone, so resolve the local id from a child (if any).
  // Delete the shell if it still exists and is seed-origin. Keep it in the baseline (don't push
  // to handled) when it still holds user content, so that content is never silently forgotten.
  for (const ws of removed) {
    if (ws.entityType !== 'workspace') continue
    if (foldersWithUserContent.has(ws.workspaceFolder)) continue
    const wsId = wsIdByFolder.get(ws.workspaceFolder)
    if (wsId) {
      const local = await storage.workspaces.getById(wsId)
      if (local?.origin === 'seed') await storage.workspaces.delete(wsId).catch(() => {})
    }
    handled.push(ws)
  }

  if (handled.length === 0) return []

  // Drop the handled entities from the baseline so they stop being reported as 'removed'.
  // (They're gone from the current build, so there's nothing to advance to — just drop them.)
  storeSeedHashes(dropFromSeedHashes(getStoredSeedHashes(), handled))

  return handled
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
