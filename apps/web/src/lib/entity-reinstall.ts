import { retryGitContentClone } from '@/lib/git-content-retry'
import type { GitScope } from '@/lib/api/git'
import type { GitLinkedEntity } from '@/lib/entity-io'
import { localized } from '@/lib/localized'
import type { GitRemoteConfig, LocalizedString } from '@/types'
import { useAppStore } from '@/stores/app-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useCohortStore } from '@/stores/cohort-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useDqStore } from '@/stores/dq-store'
import { useEtlStore } from '@/stores/etl-store'
import { useFileStore } from '@/stores/file-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'

export interface ReinstallResult {
  ok: boolean
  error?: string
}

/**
 * Rebuild a git-linked entity's content from the repository it points at,
 * discarding whatever is here now.
 *
 * The clone + wipe + re-import is `retryGitContentClone`, the same path the
 * "content not imported" badge retries with — `applyClonedEntity` deletes the
 * entity's children (through the very cascade the manual Delete uses) and
 * rebuilds them from the repo. The token is not passed: the backend resolves the
 * acting user's stored (user, host) credential, which is why a reinstall never
 * asks for one.
 *
 * The entity's own ROW survives — only its content is replaced — so the id, the
 * git link, the members and the permissions are the ones the user already had.
 * That is deliberately narrower than delete-then-import, which for a project
 * would also rmtree the on-disk working directory that no repo carries.
 *
 * `onReloaded` is where a scope repairs its own stores; what the badge's retry
 * can skip (it fires from a list where nothing is open) matters here, because
 * the entity is on screen showing content that has just been deleted.
 */
export async function reinstallEntityFromGit(args: {
  scope: GitScope
  type: GitLinkedEntity['type']
  id: string
  name: string
  url: string
  branch: string
  workspaceId: string
  onReloaded?: () => void | Promise<void>
}): Promise<ReinstallResult> {
  const { scope, type, id, name, url, branch, workspaceId, onReloaded } = args

  const result = await retryGitContentClone({ scope, type, id, name, url, branch, workspaceId })
  if (!result.ok) return result

  await onReloaded?.()
  return result
}

/**
 * Drop the in-memory content of the project stores and reload the two that gate
 * rendering.
 *
 * Mirrors what a project import does (ProjectsPage `doImport`): dashboards,
 * datasets and files are invalidated so they re-read on next open, while
 * pipelines and cohorts are RELOADED rather than invalidated — App.tsx gates
 * rendering on their `loaded` flag, so clearing it blanks the app.
 */
async function reloadProjectStores(): Promise<void> {
  useDashboardStore.setState({ activeProjectUid: null, loaded: false })
  useDatasetStore.setState({ activeProjectUid: null })
  useFileStore.setState({ activeProjectUid: null })

  await usePipelineStore.getState().loadPipelines()
  await useCohortStore.getState().loadCohorts()
  await useAppStore.getState().loadProjects()
}

/**
 * What a reinstall means for each git scope: the entity type `applyClonedEntity`
 * rebuilds, and the store reload that makes the new content visible.
 *
 * Keyed by scope rather than passed in by each caller, exactly as the pull flow
 * is (`INLINE_PULLS` / `AFTER_PULLS` in entity-actions-menu): reinstalling is a
 * property of the entity kind, and most kinds are reached from a list page, a
 * detail page AND the header badge. A scope absent from this table gets no
 * Reinstall button — that is how `workspaces`, `user-plugins` and `settings`
 * stay out, having no `applyClonedEntity` branch to rebuild them.
 */
/**
 * The `onReinstall` handler for a scope, or undefined when that scope has none
 * (or the workspace is unknown, which `applyClonedEntity` needs to re-link the
 * entity's databases).
 *
 * Resolves to null on success, or to the git error to display. An empty string
 * means "it failed with nothing to quote" — the caller shows its own wording
 * rather than this layer reaching for a translation.
 */
export function makeReinstall(
  scope: GitScope,
  item: { id: string; name: LocalizedString | string; workspaceId?: string },
  workspaceId: string | null | undefined,
): ((config: GitRemoteConfig) => Promise<string | null>) | undefined {
  const entry = REINSTALLABLE[scope]
  const ws = item.workspaceId ?? workspaceId
  if (!entry || !ws) return undefined
  return async (config) => {
    const result = await reinstallEntityFromGit({
      scope,
      type: entry.type,
      id: item.id,
      name: localized(item.name, 'en') || item.id,
      url: config.url,
      branch: config.branch,
      workspaceId: ws,
      onReloaded: () => entry.reload({ id: item.id, workspaceId: ws }),
    })
    return result.ok ? null : (result.error ?? '')
  }
}

export const REINSTALLABLE: Partial<
  Record<GitScope, { type: GitLinkedEntity['type']; reload: (item: { id: string; workspaceId?: string }) => Promise<void> }>
> = {
  projects: { type: 'project', reload: reloadProjectStores },
  'mapping-projects': {
    type: 'mapping-project',
    reload: async ({ id }) => {
      const store = useConceptMappingStore.getState()
      await store.loadMappingProjects()
      await store.loadProjectMappings(id, { force: true })
    },
  },
  'sql-script-collections': {
    type: 'sql-collection',
    reload: async ({ id }) => {
      const store = useSqlScriptsStore.getState()
      await store.loadCollections()
      await store.loadCollectionFiles(id)
    },
  },
  'etl-pipelines': {
    type: 'etl-pipeline',
    reload: async ({ id }) => {
      const store = useEtlStore.getState()
      await store.loadEtlPipelines()
      await store.loadPipelineFiles(id)
    },
  },
  'data-catalogs': {
    type: 'data-catalog',
    reload: async () => { await useCatalogStore.getState().loadCatalogs() },
  },
  'dq-rule-sets': {
    type: 'dq-rule-set',
    reload: async ({ id }) => {
      const store = useDqStore.getState()
      await store.loadDqRuleSets()
      await store.loadRuleSetChecks(id)
    },
  },
  // Reloaded in the SAME scope the page uses (per workspace) — an unscoped reload
  // would swap the list for every workspace's presets.
  'schema-presets': {
    type: 'schema-preset',
    reload: async ({ workspaceId }) => { await useSchemaPresetStore.getState().loadPresets(workspaceId) },
  },
  databases: {
    type: 'database',
    reload: async () => { await useDataSourceStore.getState().loadDataSources(true) },
  },
}
