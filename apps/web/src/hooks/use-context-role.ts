import { isServerMode } from '@/lib/api-client'
import { type MemberRole } from '@/lib/api/members'
import { useContextRoleStore } from '@/stores/context-role-store'

const RANK: Record<string, number> = { viewer: 0, editor: 1, owner: 2 }

export interface ContextRole {
  role: MemberRole | null
  /**
   * Whether the role has finished loading. In client mode there is nothing to
   * load, so it is always true. In server mode it is false until the `/my-role`
   * fetch resolves — a permission gate that must not flicker (or mis-route a
   * deep-link) should wait on this rather than treat "not yet loaded" as "denied".
   */
  loaded: boolean
  /** True if the effective role is at least `min` (front-only mode → always true). */
  atLeast: (min: MemberRole) => boolean
  /**
   * True if the effective role grants the exact `permission` ("resource:action",
   * e.g. "cohorts:write", "ide:execute"). Front-only mode → always true. This is
   * the preferred gate: it honours custom roles, not just the viewer/editor/owner
   * rank. Real enforcement is server-side; this is UX only.
   */
  can: (permission: string) => boolean
}

function make(role: MemberRole | null, permissions: string[]): ContextRole {
  const serverMode = isServerMode()
  return {
    role,
    loaded: !serverMode || role != null,
    atLeast: (min: MemberRole) =>
      !serverMode || (role != null && RANK[role] >= RANK[min]),
    can: (permission: string) => !serverMode || permissions.includes(permission),
  }
}

/**
 * Current user's effective role on the active workspace, read from the shared
 * store (loaded once by WorkspaceGuard). The `workspaceId` arg is kept for call
 * sites that pass it, but the store is the single source of truth.
 */
export function useMyWorkspaceRole(_workspaceId?: string | undefined): ContextRole {
  const role = useContextRoleStore((s) => s.workspaceRole)
  const permissions = useContextRoleStore((s) => s.workspacePermissions)
  return make(role, permissions)
}

/** Current user's effective role on the active project (from the shared store). */
export function useMyProjectRole(_projectUid?: string | undefined): ContextRole {
  const role = useContextRoleStore((s) => s.projectRole)
  const permissions = useContextRoleStore((s) => s.projectPermissions)
  return make(role, permissions)
}
