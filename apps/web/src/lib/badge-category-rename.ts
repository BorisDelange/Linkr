import { renameCategoryInBadges } from '@/lib/badge-categories'
import { localized } from '@/lib/localized'
import type { Storage } from '@/lib/storage'
import type { ProjectBadge } from '@/types'

/**
 * Rewrite `Old::value` to `New::value` on every badge in a workspace.
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
  from: string,
  to: string,
  lang: string,
): Promise<number> {
  if (!from.trim() || !to.trim() || from === to) return 0

  /** Rewrites one entity's badges, returning the new array only when it changed. */
  const rewrite = (badges: ProjectBadge[] | undefined): ProjectBadge[] | null => {
    if (!badges?.length) return null
    const next = renameCategoryInBadges(badges, from, to, lang)
    return next.some((b, i) => b !== badges[i]) ? next : null
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

/** How many badges in `badges` belong to the category named `name`. */
export function countForCategory(badges: ProjectBadge[], name: string, lang: string): number {
  const prefix = `${name.trim().toLowerCase()}::`
  return badges.filter((b) => localized(b.label, lang).toLowerCase().startsWith(prefix)).length
}
