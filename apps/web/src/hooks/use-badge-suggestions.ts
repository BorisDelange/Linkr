import { useMemo } from 'react'
import type { ProjectBadge } from '@/types'

/**
 * Anything badge-carrying and workspace-scoped — the shape every entity list
 * shares. The primary key is `id` on most entities and `uid` on a project, so
 * both are optional here and `excludeId` is compared against whichever exists.
 */
interface BadgeCarrier {
  id?: string
  uid?: string
  workspaceId?: string
  badges?: ProjectBadge[]
}

/**
 * Badges already in use on sibling entities of the same kind, for the create/edit
 * dialog's suggestion row.
 *
 * Scoped to the active workspace and excluding the entity being edited, so the list is
 * "what my colleagues tagged things with here" rather than every badge ever created.
 * Deduping and sorting happen in BadgeEditor.
 */
export function useBadgeSuggestions(
  items: BadgeCarrier[],
  workspaceId: string | null | undefined,
  excludeId?: string,
): ProjectBadge[] {
  return useMemo(() => {
    if (!workspaceId) return []
    return items
      .filter((i) => i.workspaceId === workspaceId && (i.id ?? i.uid) !== excludeId)
      .flatMap((i) => i.badges ?? [])
  }, [items, workspaceId, excludeId])
}
