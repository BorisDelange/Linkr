import { gitSetSyncState, scopeForLinkedType } from '@/lib/api/git'
import type { CatalogEntryType } from '@/lib/catalog/types'

/**
 * Anchor a freshly-cloned git-linked entity to the commit it came from, so a
 * later push elsewhere reads as "behind" on its Versioning page.
 *
 * Shared by every clone path that reconstitutes content under an already-imported
 * record (workspace import, content-retry badge). Without it the entity has no
 * baseline and `sync-state` reports `behind: false` forever — the server refuses
 * to infer one, since the scratch repo's HEAD tracks the remote, not what was
 * actually applied to the database (see git_service.sync_state).
 *
 * Best-effort by design: a failure leaves the entity unanchored, which costs a
 * banner, not data. Types with no GitScope of their own (`database`, and
 * `workspace`, which its installer anchors directly) are skipped.
 */
export async function anchorClonedEntity(
  type: CatalogEntryType,
  id: string,
  branch: string,
  clonedOid: string | null | undefined,
): Promise<void> {
  const scope = scopeForLinkedType[type]
  if (!scope || !clonedOid) return
  try {
    await gitSetSyncState(scope, id, branch, clonedOid)
  } catch { /* leave unanchored — the entity is still usable, just without a banner */ }
}
