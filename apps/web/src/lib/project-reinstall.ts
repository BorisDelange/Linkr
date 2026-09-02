import { retryGitContentClone } from '@/lib/git-content-retry'
import { useAppStore } from '@/stores/app-store'
import { useCohortStore } from '@/stores/cohort-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useFileStore } from '@/stores/file-store'
import { usePipelineStore } from '@/stores/pipeline-store'

export interface ReinstallResult {
  ok: boolean
  error?: string
}

/**
 * Rebuild a project's content from the repository it is linked to, discarding
 * whatever is here now.
 *
 * The clone + wipe + re-import is `retryGitContentClone`, the same path the
 * "content not imported" badge retries with — it deletes the project's children
 * through `deleteProjectData` (the cascade the manual Delete uses) and rebuilds
 * them from the repo. The token is not passed: the backend resolves the acting
 * user's stored (user, host) credential, which is why a reinstall never asks for
 * one.
 *
 * The project ROW survives — only its content is replaced — so the uid, the git
 * link, the members and the permissions are the ones the user already had. That
 * is deliberately narrower than delete-then-import, which in server mode also
 * rmtree's the on-disk working directory that no repo carries.
 *
 * What the badge's retry does not do, and a reinstall must: reload the stores.
 * The badge fires from a list where nothing is open; here the project is on
 * screen, so its dashboards, datasets and files would keep rendering the content
 * that was just deleted.
 */
export async function reinstallProjectFromGit(args: {
  projectUid: string
  name: string
  url: string
  branch: string
  workspaceId: string
}): Promise<ReinstallResult> {
  const { projectUid, name, url, branch, workspaceId } = args

  const result = await retryGitContentClone({
    scope: 'projects',
    type: 'project',
    id: projectUid,
    name,
    url,
    branch,
    workspaceId,
  })
  if (!result.ok) return result

  await reloadAfterProjectContentChange()
  return result
}

/**
 * Drop the in-memory content of the project stores and reload the two that
 * gate rendering.
 *
 * Mirrors what a project import does (ProjectsPage `doImport`): dashboards,
 * datasets and files are invalidated so they re-read on next open, while
 * pipelines and cohorts are RELOADED rather than invalidated — App.tsx gates
 * rendering on their `loaded` flag, so clearing it blanks the app.
 */
async function reloadAfterProjectContentChange(): Promise<void> {
  useDashboardStore.setState({ activeProjectUid: null, loaded: false })
  useDatasetStore.setState({ activeProjectUid: null })
  useFileStore.setState({ activeProjectUid: null })

  await usePipelineStore.getState().loadPipelines()
  await useCohortStore.getState().loadCohorts()
  await useAppStore.getState().loadProjects()
}
