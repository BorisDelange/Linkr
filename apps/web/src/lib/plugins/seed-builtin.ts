import { getAllPlugins } from '@/lib/plugins/registry'
import type { Storage } from '@/lib/storage'
import type { UserPlugin } from '@/types'

/**
 * Materialize the app's built-in plugins as UserPlugin records for a workspace.
 * Runs on both the default-data seed and workspace import: the workspace export
 * strips built-ins from the ZIP (they're reconstitutable from the registry), so
 * every import path must re-seed them here or the imported workspace arrives with
 * no built-in plugins. Idempotent — create failures (already present) are ignored.
 */
export async function seedBuiltinPlugins(storage: Storage, workspaceId: string, now: string): Promise<void> {
  for (const p of getAllPlugins()) {
    if (p.workspaceId) continue // skip non-built-in
    const files: Record<string, string> = { 'plugin.json': JSON.stringify(p.manifest, null, 2) }
    if (p.templates) {
      for (const [lang, content] of Object.entries(p.templates)) {
        const ext = lang === 'r' ? '.R.template' : '.py.template'
        files[`analysis${ext}`] = content
      }
    }
    const userPlugin: UserPlugin = { id: p.manifest.id, entityId: p.manifest.id, files, workspaceId, createdAt: now, updatedAt: now }
    await storage.userPlugins.create(userPlugin).catch(() => {})
  }
}
