import { useCallback, useEffect, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { gitContentStatusList, type GitContentStatus, type GitScope } from '@/lib/api/git'

// Front-only mode has no backend to hold the "content not reconstituted" rows, so
// they live in localStorage per workspace. Advisory only (like the server rows):
// a stale entry for a deleted entity is harmless — no card, no badge.
const localKey = (workspaceId: string) => `linkr-git-content-status:${workspaceId}`

function readLocalStatuses(workspaceId: string): Map<string, GitContentStatus['status']> {
  try {
    const raw = JSON.parse(localStorage.getItem(localKey(workspaceId)) ?? '{}') as Record<string, GitContentStatus['status']>
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

/** Record (or clear with `null`) a content status in front-only mode — the local
 *  twin of gitSetContentStatus/gitClearContentStatus. */
export function setLocalGitContentStatus(
  workspaceId: string,
  scope: GitScope,
  entityId: string,
  status: GitContentStatus['status'] | null,
): void {
  try {
    const key = localKey(workspaceId)
    const map = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, GitContentStatus['status']>
    if (status === null) delete map[`${scope}:${entityId}`]
    else map[`${scope}:${entityId}`] = status
    localStorage.setItem(key, JSON.stringify(map))
  } catch { /* advisory */ }
}

/** Load the "content not reconstituted" statuses for a workspace, keyed by
 *  `${scope}:${entityId}`. Returns a map + a refetch. Server rows in server mode,
 *  localStorage in front-only. */
export function useGitContentStatuses(workspaceId: string | null | undefined): {
  statuses: Map<string, GitContentStatus['status']>
  refetch: () => Promise<void>
} {
  const [statuses, setStatuses] = useState<Map<string, GitContentStatus['status']>>(new Map())
  const load = useCallback(() => {
    if (!workspaceId) return Promise.resolve()
    if (!isServerMode()) {
      setStatuses(readLocalStatuses(workspaceId))
      return Promise.resolve()
    }
    return gitContentStatusList(workspaceId)
      .then((rows) => setStatuses(new Map(rows.map((r) => [`${r.scope}:${r.entityId}`, r.status]))))
      .catch(() => { /* advisory — no badge on error */ })
  }, [workspaceId])
  useEffect(() => { void load() }, [load])
  return { statuses, refetch: load }
}
