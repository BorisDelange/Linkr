/**
 * The whole pull of one entity, from the server's 3-way preview to the moved
 * cursors — what the versioning panel runs on finalize, and what the end-to-end
 * journeys run directly against every kind of entity.
 */
import JSZip from 'jszip'
import { gitMergedTree, gitSetSyncState, gitThreeWay, type GitScope } from '@/lib/api/git'
import { isCompletePull, itemIdFor, type PullDecision, type PullPlan } from '@/lib/pull-plan'
import { useAuthStore } from '@/stores/auth-store'
import { applyEntityPull, applyWorkspacePull, splitUnwritable } from './apply'
import { buildThreeWayPlan, itemsOf, overridesFor, prepareThreeWay, type PreparedFile, type ThreeWayPreview } from './three-way'

export async function finalizePull(args: {
  scope: GitScope
  id: string
  workspaceId?: string
  branch: string
  preview: ThreeWayPreview
  prepared: PreparedFile[]
  plan: PullPlan
  decisions: Map<string, PullDecision>
  /** Changes this version cannot write: they keep the pull partial. */
  unsupported?: string[]
  /** Results written by hand, by path: taken as they stand. */
  edits?: ReadonlyMap<string, string>
}): Promise<void> {
  const { scope, id, workspaceId, branch, preview, prepared, plan, decisions, unsupported = [], edits } = args
  if (!preview.remoteHead) throw new Error('the remote branch has no commit')
  const overrides = overridesFor(prepared, decisions, edits)
  if (Object.keys(overrides).length) {
    const blob = await gitMergedTree(scope, id, branch, preview.remoteHead, overrides)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    if (scope === 'workspaces') await applyWorkspacePull(id, zip, overrides, undefined, preview)
    else await applyEntityPull(scope, id, zip, overrides, workspaceId)
  }
  // Only taking everything on offer moves the content anchor; a partial pull
  // moves the decision cursor alone, which is what unblocks the push.
  const complete = isCompletePull(plan, decisions) && unsupported.length === 0
  await gitSetSyncState(scope, id, branch, preview.remoteHead, !complete)
}

/** Take everything the remote brought, conflicts settled on the remote side. */
export async function pullEverything(scope: GitScope, id: string, branch: string, workspaceId?: string): Promise<string[]> {
  const preview = await gitThreeWay(scope, id, branch)
  const { prepared, unsupported } = splitUnwritable(scope, prepareThreeWay(preview), useAuthStore.getState().user?.username)
  const labels = { file: 'file', field: (k: string) => k, element: (k: string) => k, merged: 'merged' }
  const plan = buildThreeWayPlan(scope, preview, prepared, labels)
  const decisions = new Map<string, PullDecision>()
  for (const p of prepared) for (const item of itemsOf(p, labels)) decisions.set(itemIdFor(p.file.path, item.key), 'accept')
  await finalizePull({ scope, id, workspaceId, branch, preview, prepared, plan, decisions, unsupported })
  return prepared.map((p) => p.file.path)
}
