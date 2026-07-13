import { create } from 'zustand'
import { isServerMode } from '@/lib/api-client'
import { membersApi, type DirectoryUser } from '@/lib/api/members'
import { useAppStore } from '@/stores/app-store'

interface UserDirectoryState {
  byId: Record<number, DirectoryUser>
  loaded: boolean
  loadDirectory: () => Promise<void>
  /** Resolve a user id to a current display name, or '' if unknown. */
  resolveName: (id: number) => string
}

function displayName(u: { firstName?: string; lastName?: string; username: string }): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
  return full || u.username
}

/**
 * Small cache of the user directory (id → name), so author names on cards reflect
 * the *current* profile of the creator rather than the snapshot taken at creation.
 * Server mode only; front-only has a single user resolved via the app store.
 */
export const useUserDirectoryStore = create<UserDirectoryState>((set, get) => ({
  byId: {},
  loaded: false,

  loadDirectory: async () => {
    if (!isServerMode()) { set({ loaded: true }); return }
    try {
      const users = await membersApi.directory()
      const byId: Record<number, DirectoryUser> = {}
      for (const u of users) byId[u.id] = u
      set({ byId, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  resolveName: (id) => {
    const u = get().byId[id]
    if (u) return displayName(u)
    // Front-only (or directory not loaded): fall back to the current user.
    const me = useAppStore.getState().user
    if (me && me.id === id) {
      const full = [me.firstName, me.lastName].filter(Boolean).join(' ').trim()
      return full || me.username
    }
    return ''
  },
}))
