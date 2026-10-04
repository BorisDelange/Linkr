import { create } from 'zustand'
import { isServerMode } from '@/lib/api-client'
import { membersApi, type MemberRole } from '@/lib/api/members'
import { useAuthStore } from '@/stores/auth-store'

/**
 * The current user's effective role on the active workspace and project, loaded
 * once when the context is entered (by WorkspaceGuard / ProjectGuard) so every
 * gated control reads it from here instead of each firing its own /my-role call.
 *
 * In front-only mode there is no server authorization, so roles resolve to
 * "owner" (everything permitted) — see the gating helpers.
 *
 * Roles belong to the signed-in account: the store is emptied whenever the
 * account changes, otherwise a sign-in on another account in the same tab keeps
 * the previous account's permissions until the page is reloaded.
 */
interface ContextRoleState {
  workspaceId: string | null
  workspaceRole: MemberRole | null
  workspacePermissions: string[]
  projectUid: string | null
  projectRole: MemberRole | null
  projectPermissions: string[]

  loadWorkspaceRole: (workspaceId: string) => Promise<void>
  loadProjectRole: (projectUid: string) => Promise<void>
  reset: () => void
}

const EMPTY = {
  workspaceId: null,
  workspaceRole: null,
  workspacePermissions: [],
  projectUid: null,
  projectRole: null,
  projectPermissions: [],
}

// Bumped by reset(), so a /my-role answer requested for the previous account is dropped.
let generation = 0

export const useContextRoleStore = create<ContextRoleState>((set, get) => ({
  ...EMPTY,

  loadWorkspaceRole: async (workspaceId) => {
    if (!isServerMode()) {
      set({ workspaceId, workspaceRole: 'owner', workspacePermissions: [] })
      return
    }
    // Already loaded for this workspace — don't refetch.
    if (get().workspaceId === workspaceId && get().workspaceRole !== null) return
    // Switching to a different workspace: drop the previous role first so gated
    // controls stay denied during the fetch instead of showing the old role.
    if (get().workspaceId !== workspaceId) {
      set({ workspaceId, workspaceRole: null, workspacePermissions: [] })
    }
    const requested = generation
    try {
      const { role, permissions } = await membersApi.myWorkspaceRole(workspaceId)
      if (requested !== generation) return
      set({ workspaceId, workspaceRole: role, workspacePermissions: permissions ?? [] })
    } catch {
      if (requested !== generation) return
      set({ workspaceId, workspaceRole: null, workspacePermissions: [] })
    }
  },

  loadProjectRole: async (projectUid) => {
    if (!isServerMode()) {
      set({ projectUid, projectRole: 'owner', projectPermissions: [] })
      return
    }
    if (get().projectUid === projectUid && get().projectRole !== null) return
    if (get().projectUid !== projectUid) {
      set({ projectUid, projectRole: null, projectPermissions: [] })
    }
    const requested = generation
    try {
      const { role, permissions } = await membersApi.myProjectRole(projectUid)
      if (requested !== generation) return
      set({ projectUid, projectRole: role, projectPermissions: permissions ?? [] })
    } catch {
      if (requested !== generation) return
      set({ projectUid, projectRole: null, projectPermissions: [] })
    }
  },

  reset: () => {
    generation++
    set(EMPTY)
  },
}))

useAuthStore.subscribe((state, prev) => {
  if (state.user?.id !== prev.user?.id) useContextRoleStore.getState().reset()
})
