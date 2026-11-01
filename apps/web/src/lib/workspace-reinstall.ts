import i18n from '@/lib/i18n'
import { isServerMode } from '@/lib/api-client'
import { gitCloneToZip, gitSetSyncState } from '@/lib/api/git'
import { cloneWorkspaceChildren, describeUnreadableTree } from '@/lib/catalog/install'
import { refreshStoresAfterInstall } from '@/lib/catalog/refresh'
import { deleteProjectData, parseWorkspaceZip } from '@/lib/entity-io'
import { toGitError } from '@/lib/git-error-message'
import { seedBuiltinPluginsForWorkspace } from '@/lib/plugins/default-plugins'
import { getStorage, type Storage } from '@/lib/storage'
import { importWorkspaceTree, type LandedChildren } from '@/lib/workspace-import'
import type { GitRemoteConfig } from '@/types'

/** The rows of `rows` this import did not write: what a mirror deletes. */
export function unlandedIds(rows: readonly { id: string }[], landed: ReadonlySet<string>): string[] {
  return rows.map((r) => r.id).filter((id) => !landed.has(id))
}

/**
 * Delete the workspace's children the repository does not carry, each through
 * the same cascade the workspace delete uses (workspace-store `deleteWorkspace`).
 * Data dictionaries are left alone: the workspace import does not write them, so
 * deleting them here could never be undone by the repo.
 */
async function deleteUnlanded(storage: Storage, wsId: string, landed: LandedChildren, hasWiki: boolean, hasRegistry: boolean) {
  const projects = (await storage.projects.getAll()).filter((p) => p.workspaceId === wsId)
  for (const uid of unlandedIds(projects.map((p) => ({ id: p.uid })), landed.projects)) {
    await deleteProjectData(storage, uid)
    await storage.projects.delete(uid).catch(() => {})
  }
  for (const id of unlandedIds(await storage.dataSources.getByWorkspace(wsId), landed.dataSources)) {
    await storage.files.deleteByDataSource(id).catch(() => {})
    await storage.fileHandles.deleteByDataSource(id).catch(() => {})
    await storage.databaseStatsCache.delete(id).catch(() => {})
    await storage.dataSources.delete(id).catch(() => {})
  }
  for (const id of unlandedIds(await storage.sqlScriptCollections.getByWorkspace(wsId), landed.sqlScriptCollections)) {
    await storage.sqlScriptFiles.deleteByCollection(id).catch(() => {})
    await storage.sqlScriptCollections.delete(id).catch(() => {})
  }
  for (const id of unlandedIds(await storage.etlPipelines.getByWorkspace(wsId), landed.etlPipelines)) {
    await storage.etlFiles.deleteByPipeline(id).catch(() => {})
    await storage.etlPipelines.delete(id).catch(() => {})
  }
  for (const id of unlandedIds(await storage.dqRuleSets.getByWorkspace(wsId), landed.dqRuleSets)) {
    await storage.dqCustomChecks.deleteByRuleSet(id).catch(() => {})
    await storage.dqRuleSets.delete(id).catch(() => {})
  }
  const staleMappingProjects = unlandedIds(await storage.mappingProjects.getByWorkspace(wsId), landed.mappingProjects)
  if (staleMappingProjects.length) {
    await storage.conceptMappings.deleteByProjectIds(staleMappingProjects).catch(() => {})
    const { useSuggestionScoresStore } = await import('@/stores/suggestion-scores-store')
    for (const id of staleMappingProjects) {
      await useSuggestionScoresStore.getState().deleteProjectScores(id).catch(() => {})
      await storage.mappingProjects.delete(id).catch(() => {})
    }
  }
  for (const id of unlandedIds(await storage.conceptSets.getByWorkspace(wsId), landed.conceptSets)) {
    await storage.conceptSets.delete(id).catch(() => {})
  }
  for (const id of unlandedIds(await storage.dataCatalogs.getByWorkspace(wsId), landed.dataCatalogs)) {
    await storage.dataCatalogs.delete(id).catch(() => {})
  }
  for (const id of unlandedIds(await storage.serviceMappings.getByWorkspace(wsId), landed.serviceMappings)) {
    await storage.serviceMappings.delete(id).catch(() => {})
  }
  for (const id of unlandedIds(await storage.schemaPresets.getByWorkspace(wsId), landed.schemaPresets)) {
    await storage.schemaPresets.delete(id).catch(() => {})
  }
  // Built-in plugins never travel (the export strips them), so they are not
  // "landed" either: delete, then re-seed, the same way the import itself does.
  for (const id of unlandedIds(await storage.userPlugins.getByWorkspace(wsId), landed.userPlugins)) {
    await storage.userPlugins.delete(id).catch(() => {})
  }
  await seedBuiltinPluginsForWorkspace(wsId)
  // The import only replaces these when the repo carries some; a repo with none
  // means the workspace has none.
  if (!hasWiki) {
    await storage.wikiAttachments.deleteByWorkspace(wsId).catch(() => {})
    await storage.wikiPages.deleteByWorkspace(wsId).catch(() => {})
  }
  if (!hasRegistry) {
    await storage.sourceConceptIdEntries.deleteByWorkspace(wsId).catch(() => {})
    await storage.sourceConceptIdRanges.deleteByWorkspace(wsId).catch(() => {})
  }
}

/**
 * Rebuild a workspace from its repository: an exact mirror.
 *
 * The other kinds rebuild one entity (`reinstallEntityFromGit`); a workspace is
 * a container, so this runs the workspace import over the cloned tree, forced
 * onto THIS workspace, then deletes every child the repository does not carry,
 * and re-clones each git-linked child from its own repository. The workspace
 * row survives — id, members, git link — as an entity's does.
 *
 * The clone and the parse come first: a repo that cannot be read changes
 * nothing. Resolves to null on success, else the message to show ('' = no
 * detail worth quoting). Children whose own repo could not be cloned are
 * reported, the rest of the workspace being rebuilt all the same.
 */
export async function reinstallWorkspaceFromGit(
  workspaceId: string,
  config: GitRemoteConfig,
  language: string,
): Promise<string | null> {
  if (!isServerMode()) return ''
  const branch = config.branch || 'main'
  let cloned: Awaited<ReturnType<typeof gitCloneToZip>>
  try {
    cloned = await gitCloneToZip(config.url, branch, undefined, workspaceId)
  } catch (e) {
    return toGitError(e).raw
  }
  const parsed = await parseWorkspaceZip(new File([cloned.blob], 'workspace.zip', { type: 'application/zip' }))
  if (!parsed) {
    const JSZip = (await import('jszip')).default
    return describeUnreadableTree(await JSZip.loadAsync(cloned.blob), 'workspace')
  }
  // workspace.json never carries the link (export strips it); the workspace's
  // own stays as it is.
  delete parsed.workspace.gitRemoteConfig

  const storage = getStorage()
  const { idMap, landed } = await importWorkspaceTree(parsed, { duplicate: false, language, targetWorkspaceId: workspaceId })
  await deleteUnlanded(
    storage,
    workspaceId,
    landed,
    parsed.wikiPages.length > 0,
    parsed.sourceConceptIdRanges.length + parsed.sourceConceptIdEntries.length > 0,
  )
  const failed = await cloneWorkspaceChildren(parsed, workspaceId, idMap)
  if (cloned.oid) {
    try {
      await gitSetSyncState('workspaces', workspaceId, branch, cloned.oid)
    } catch { /* leave unanchored — Versioning adopts lazily */ }
  }
  await refreshStoresAfterInstall('workspace', workspaceId)

  if (failed.length === 0) return null
  return `${i18n.t('versioning.reinstall_children_failed')}\n\n${failed.map((f) => `${f.name}: ${f.reason}`).join('\n')}`
}
