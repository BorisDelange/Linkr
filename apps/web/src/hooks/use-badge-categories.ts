import { useWorkspaceStore } from '@/stores/workspace-store'
import type { BadgeCategory } from '@/types'

const NONE: BadgeCategory[] = []

/**
 * The badge categories declared by a workspace, for `BadgeEditor` and the badge
 * filters. Defaults to the active workspace, which is what every create/edit
 * dialog wants.
 *
 * Returns a stable empty array when the workspace declares none, so a caller can
 * pass it straight into a memo dependency without re-running each render.
 */
export function useBadgeCategories(workspaceId?: string | null): BadgeCategory[] {
  return useWorkspaceStore((s) => {
    const id = workspaceId ?? s.activeWorkspaceId
    if (!id) return NONE
    return s._workspacesRaw.find((w) => w.id === id)?.badgeCategories ?? NONE
  })
}
