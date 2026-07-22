import { useCallback, useEffect, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { gitContentStatusList, type GitContentStatus } from '@/lib/api/git'

/** Load the "content not reconstituted" statuses for a workspace, keyed by
 *  `${scope}:${entityId}`. Returns a map + a refetch. Empty in front-only mode. */
export function useGitContentStatuses(workspaceId: string | null | undefined): {
  statuses: Map<string, GitContentStatus['status']>
  refetch: () => Promise<void>
} {
  const [statuses, setStatuses] = useState<Map<string, GitContentStatus['status']>>(new Map())
  const load = useCallback(() => {
    if (!workspaceId || !isServerMode()) return Promise.resolve()
    return gitContentStatusList(workspaceId)
      .then((rows) => setStatuses(new Map(rows.map((r) => [`${r.scope}:${r.entityId}`, r.status]))))
      .catch(() => { /* advisory — no badge on error */ })
  }, [workspaceId])
  useEffect(() => { void load() }, [load])
  return { statuses, refetch: load }
}
