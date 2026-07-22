import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { gitCloneToZip, gitSetSyncState, gitClearContentStatus, gitSetContentStatus, type GitScope } from '@/lib/api/git'
import { applyClonedEntity, type GitLinkedEntity } from '@/lib/entity-io'

/**
 * Re-clone a single git-linked entity's content into its already-imported record
 * — the shared retry behind the "content not imported" card badge. Server mode
 * only (the clone runs on the backend). Mirrors WorkspacesPage.cloneEntityContent,
 * plus it updates the content-status row so the badge clears on success.
 *
 * `scope` is the GitScope (API path segment); `type` the singular GitLinkedEntity
 * type for applyClonedEntity. Returns true when the content was applied.
 */
export async function retryGitContentClone(args: {
  scope: GitScope
  type: GitLinkedEntity['type']
  id: string
  name: string
  url: string
  branch: string
  workspaceId: string
  token?: string
}): Promise<boolean> {
  if (!isServerMode()) return false
  const { scope, type, id, url, branch, workspaceId, token } = args
  try {
    const JSZip = (await import('jszip')).default
    const cloned = await gitCloneToZip(url, branch, token)
    const zip = await JSZip.loadAsync(cloned.blob)
    const ok = await applyClonedEntity(zip, type, id, getStorage(), workspaceId, { url, branch })
    if (ok && type === 'mapping-project' && cloned.oid) {
      try { await gitSetSyncState('mapping-projects', id, branch, cloned.oid) } catch { /* leave unanchored */ }
    }
    try {
      if (ok) await gitClearContentStatus(workspaceId, scope, id)
      else await gitSetContentStatus(workspaceId, scope, id, 'failed')
    } catch { /* status is advisory */ }
    return ok
  } catch {
    try { await gitSetContentStatus(workspaceId, scope, id, 'failed') } catch { /* advisory */ }
    return false
  }
}
