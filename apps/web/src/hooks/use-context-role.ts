import { isServerMode } from '@/lib/api-client'
import { type MemberRole } from '@/lib/api/members'
import { useContextRoleStore } from '@/stores/context-role-store'

const RANK: Record<string, number> = { viewer: 0, editor: 1, owner: 2 }

export interface ContextRole {
  role: MemberRole | null
  /** True if the effective role is at least `min` (front-only mode → always true). */
  atLeast: (min: MemberRole) => boolean
}

function make(role: MemberRole | null): ContextRole {
  const serverMode = isServerMode()
  return {
    role,
    atLeast: (min: MemberRole) =>
      !serverMode || (role != null && RANK[role] >= RANK[min]),
  }
}

/**
 * Current user's effective role on the active workspace, read from the shared
 * store (loaded once by WorkspaceGuard). The `workspaceId` arg is kept for call
 * sites that pass it, but the store is the single source of truth.
 */
export function useMyWorkspaceRole(_workspaceId?: string | undefined): ContextRole {
  const role = useContextRoleStore((s) => s.workspaceRole)
  return make(role)
}

/** Current user's effective role on the active project (from the shared store). */
export function useMyProjectRole(_projectUid?: string | undefined): ContextRole {
  const role = useContextRoleStore((s) => s.projectRole)
  return make(role)
}
