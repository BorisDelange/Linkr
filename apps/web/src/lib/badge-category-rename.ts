import { renameCategoryInBadges } from '@/lib/badge-categories'
import type { Storage } from '@/lib/storage'
import type { BadgeCategory, ProjectBadge } from '@/types'

/**
 * Rewrite `Old::value` to `New::value` on every badge in a workspace, in every
 * language the category is named in.
 *
 * The category name lives inside each badge's label (see `badge-categories.ts`),
 * so renaming the category alone would leave every badge carrying the old prefix
 * and matching nothing. Deleting a category deliberately does the opposite —
 * labels stay verbatim — because there is no new name to migrate them to.
 *
 * Runs against storage rather than through the seven owning stores: the entities
 * live in seven different ones, and a rename is rare enough that reloading them
 * afterwards costs less than teaching each store about categories.
 *
 * Returns how many entities were rewritten, so the caller can say so.
 */
export async function renameBadgeCategory(
  storage: Storage,
  workspaceId: string,
  previous: BadgeCategory,
  next: BadgeCategory,
): Promise<number> {
  /** Rewrites one entity's badges, returning the new array only when it changed. */
  const rewrite = (badges: ProjectBadge[] | undefined): ProjectBadge[] | null => {
    if (!badges?.length) return null
    const updated = renameCategoryInBadges(badges, previous, next)
    return updated.some((b, i) => b !== badges[i]) ? updated : null
  }

  let changed = 0

  const workspace = await storage.workspaces.getById(workspaceId)
  const wsBadges = rewrite(workspace?.badges)
  if (wsBadges) {
    await storage.workspaces.update(workspaceId, { badges: wsBadges })
    changed++
  }

  // Projects have no getByWorkspace — filter the full list, as the app does.
  for (const project of (await storage.projects.getAll()).filter((p) => p.workspaceId === workspaceId)) {
    const badges = rewrite(project.badges)
    if (badges) { await storage.projects.update(project.uid, { badges }); changed++ }
  }

  for (const source of await storage.dataSources.getByWorkspace(workspaceId)) {
    const badges = rewrite(source.badges)
    if (badges) { await storage.dataSources.update(source.id, { badges }); changed++ }
  }

  for (const pipeline of await storage.etlPipelines.getByWorkspace(workspaceId)) {
    const badges = rewrite(pipeline.badges)
    if (badges) { await storage.etlPipelines.update(pipeline.id, { badges }); changed++ }
  }

  for (const collection of await storage.sqlScriptCollections.getByWorkspace(workspaceId)) {
    const badges = rewrite(collection.badges)
    if (badges) { await storage.sqlScriptCollections.update(collection.id, { badges }); changed++ }
  }

  for (const ruleSet of await storage.dqRuleSets.getByWorkspace(workspaceId)) {
    const badges = rewrite(ruleSet.badges)
    if (badges) { await storage.dqRuleSets.update(ruleSet.id, { badges }); changed++ }
  }

  // Schema presets have no update() — they upsert through save().
  for (const preset of await storage.schemaPresets.getByWorkspace(workspaceId)) {
    const badges = rewrite(preset.badges)
    if (badges) {
      await storage.schemaPresets.save({ ...preset, badges })
      changed++
    }
  }

  return changed
}

/**
 * Reload the seven stores a rename wrote through, so pages already open show the
 * new prefix.
 *
 * The cascade above writes straight to storage; without this the Projects page
 * (and its siblings) keep the badges they loaded on mount, which renders as the
 * OLD category name on the chip and the new one inside the value half. Same
 * shape as `refreshStoresAfterInstall`, which fixes the same staleness after a
 * catalog clone.
 */
export async function refreshStoresAfterBadgeRename(workspaceId: string): Promise<void> {
  const [
    { useAppStore },
    { useWorkspaceStore },
    { useDataSourceStore },
    { useEtlStore },
    { useSqlScriptsStore },
    { useDqStore },
    { useSchemaPresetStore },
  ] = await Promise.all([
    import('@/stores/app-store'),
    import('@/stores/workspace-store'),
    import('@/stores/data-source-store'),
    import('@/stores/etl-store'),
    import('@/stores/sql-scripts-store'),
    import('@/stores/dq-store'),
    import('@/stores/schema-preset-store'),
  ])

  await Promise.all([
    useAppStore.getState().loadProjects(),
    useWorkspaceStore.getState().loadWorkspaces(),
    useDataSourceStore.getState().loadDataSources(),
    useEtlStore.getState().loadEtlPipelines(),
    useSqlScriptsStore.getState().loadCollections(),
    useDqStore.getState().loadDqRuleSets(),
    // Scoped: an unscoped reload would list every workspace's presets.
    useSchemaPresetStore.getState().loadPresets(workspaceId),
  ])
}

/** Every badge in a workspace, for the category screen's usage counts. */
export async function collectWorkspaceBadges(
  storage: Storage,
  workspaceId: string,
): Promise<ProjectBadge[]> {
  const [workspace, projects, sources, pipelines, collections, ruleSets, presets] = await Promise.all([
    storage.workspaces.getById(workspaceId),
    storage.projects.getAll(),
    storage.dataSources.getByWorkspace(workspaceId),
    storage.etlPipelines.getByWorkspace(workspaceId),
    storage.sqlScriptCollections.getByWorkspace(workspaceId),
    storage.dqRuleSets.getByWorkspace(workspaceId),
    storage.schemaPresets.getByWorkspace(workspaceId),
  ])

  return [
    ...(workspace?.badges ?? []),
    ...projects.filter((p) => p.workspaceId === workspaceId).flatMap((p) => p.badges ?? []),
    ...sources.flatMap((s) => s.badges ?? []),
    ...pipelines.flatMap((p) => p.badges ?? []),
    ...collections.flatMap((c) => c.badges ?? []),
    ...ruleSets.flatMap((r) => r.badges ?? []),
    ...presets.flatMap((p) => p.badges ?? []),
  ]
}

/**
 * How many badges belong to `category`, counting a prefix written in ANY of its
 * languages: a badge created before the prefix was localized carries one
 * spelling only, and still belongs to the category.
 */
export function countForCategory(badges: ProjectBadge[], category: BadgeCategory): number {
  const prefixes = Object.values(category.name)
    .filter((n) => n?.trim())
    .map((n) => `${n.trim().toLowerCase()}::`)
  if (!prefixes.length) return 0

  return badges.filter((b) => {
    const label = b.label
    const values = typeof label === 'string' ? [label] : Object.values(label)
    return values.some((v) => prefixes.some((p) => v?.trim().toLowerCase().startsWith(p)))
  }).length
}
