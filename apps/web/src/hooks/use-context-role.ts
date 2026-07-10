import { useEffect, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { membersApi, type MemberRole } from '@/lib/api/members'

const RANK: Record<string, number> = { viewer: 0, editor: 1, owner: 2 }

export interface ContextRole {
  role: MemberRole | null
  loading: boolean
  /** True if the effective role is at least `min` (front-only mode → always true). */
  atLeast: (min: MemberRole) => boolean
}

function useRole(
  fetcher: (() => Promise<{ role: MemberRole | null }>) | null,
  deps: unknown[],
): ContextRole {
  const serverMode = isServerMode()
  const [role, setRole] = useState<MemberRole | null>(serverMode ? null : 'owner')
  const [loading, setLoading] = useState(serverMode)

  useEffect(() => {
    if (!serverMode || !fetcher) return
    let cancelled = false
    setLoading(true)
    fetcher()
      .then((r) => { if (!cancelled) setRole(r.role) })
      .catch(() => { if (!cancelled) setRole(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // Front-only mode has no server-side authorization: permit everything.
  const atLeast = (min: MemberRole) =>
    !serverMode || (role != null && RANK[role] >= RANK[min])

  return { role, loading, atLeast }
}

/** Current user's effective role on a workspace, for UI gating. */
export function useMyWorkspaceRole(workspaceId: string | undefined): ContextRole {
  return useRole(
    workspaceId ? () => membersApi.myWorkspaceRole(workspaceId) : null,
    [workspaceId],
  )
}

/** Current user's effective role on a project, for UI gating. */
export function useMyProjectRole(projectUid: string | undefined): ContextRole {
  return useRole(
    projectUid ? () => membersApi.myProjectRole(projectUid) : null,
    [projectUid],
  )
}
