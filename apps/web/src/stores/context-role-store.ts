import { create } from 'zustand'
import { isServerMode } from '@/lib/api-client'
import { membersApi, type MemberRole } from '@/lib/api/members'

/**
 * The current user's effective role on the active workspace and project, loaded
 * once when the context is entered (by WorkspaceGuard / ProjectGuard) so every
 * gated control reads it from here instead of each firing its own /my-role call.
 *
 * In front-only mode there is no server authorization, so roles resolve to
 * "owner" (everything permitted) — see the gating helpers.
 */
interface ContextRoleState {
  workspaceId: string | null
  workspaceRole: MemberRole | null
  projectUid: string | null
  projectRole: MemberRole | null

  loadWorkspaceRole: (workspaceId: string) => Promise<void>
  loadProjectRole: (projectUid: string) => Promise<void>
  clearProjectRole: () => void
}

export const useContextRoleStore = create<ContextRoleState>((set, get) => ({
  workspaceId: null,
  workspaceRole: null,
  projectUid: null,
  projectRole: null,

  loadWorkspaceRole: async (workspaceId) => {
    if (!isServerMode()) {
      set({ workspaceId, workspaceRole: 'owner' })
      return
    }
    // Already loaded for this workspace — don't refetch.
    if (get().workspaceId === workspaceId && get().workspaceRole !== null) return
    // Switching to a different workspace: drop the previous role first so gated
    // controls stay denied during the fetch instead of showing the old role.
    if (get().workspaceId !== workspaceId) set({ workspaceId, workspaceRole: null })
    try {
      const { role } = await membersApi.myWorkspaceRole(workspaceId)
      set({ workspaceId, workspaceRole: role })
    } catch {
      set({ workspaceId, workspaceRole: null })
    }
  },

  loadProjectRole: async (projectUid) => {
    if (!isServerMode()) {
      set({ projectUid, projectRole: 'owner' })
      return
    }
    if (get().projectUid === projectUid && get().projectRole !== null) return
    if (get().projectUid !== projectUid) set({ projectUid, projectRole: null })
    try {
      const { role } = await membersApi.myProjectRole(projectUid)
      set({ projectUid, projectRole: role })
    } catch {
      set({ projectUid, projectRole: null })
    }
  },

  clearProjectRole: () => set({ projectUid: null, projectRole: null }),
}))
