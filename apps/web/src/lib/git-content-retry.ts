import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { gitCloneToZip, gitClearContentStatus, gitSetContentStatus, type GitScope } from '@/lib/api/git'
import { toGitError } from '@/lib/git-error-message'
import { anchorClonedEntity } from '@/lib/git-clone-anchor'
import { applyClonedEntity, type ApplyClonedResult, type GitLinkedEntity } from '@/lib/entity-io'
import { validateClonedEntity } from '@/lib/import-validation'
import type { Issue } from '@linkr/format'

/** Outcome of a content re-clone. On failure, `error` holds the underlying git
 *  message so the badge can surface *why* (volatile, not persisted). A tree the
 *  reader refused carries `reason`/`context` instead, for the UI to translate. */
export interface RetryContentResult {
  ok: boolean
  error?: string
  reason?: ApplyClonedResult['reason']
  context?: string
  /** Format issues found in the cloned tree — reported even on success. */
  issues?: Issue[]
}

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
}): Promise<RetryContentResult> {
  if (!isServerMode()) return { ok: false }
  const { scope, type, id, url, branch, workspaceId, token } = args
  try {
    const JSZip = (await import('jszip')).default
    const cloned = await gitCloneToZip(url, branch, token)
    const zip = await JSZip.loadAsync(cloned.blob)
    const applied = await applyClonedEntity(zip, type, id, getStorage(), workspaceId, { url, branch })
    const { ok, reason, context } = applied
    if (ok) await anchorClonedEntity(type, id, branch, cloned.oid)
    try {
      if (ok) await gitClearContentStatus(workspaceId, scope, id)
      else await gitSetContentStatus(workspaceId, scope, id, 'failed')
    } catch { /* status is advisory */ }
    // Warn, never block — same contract as the ZIP path: the reader is tolerant,
    // so a tree it accepted can still be subtly wrong, and saying so is the only
    // way that reaches the user before an empty screen does.
    const validation = await validateClonedEntity(zip, type).catch(() => null)
    return { ok, reason, context, issues: validation?.issues }
  } catch (e) {
    try { await gitSetContentStatus(workspaceId, scope, id, 'failed') } catch { /* advisory */ }
    return { ok: false, error: toGitError(e).raw }
  }
}
