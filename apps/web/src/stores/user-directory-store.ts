import { create } from 'zustand'
import { isServerMode } from '@/lib/api-client'
import { membersApi, type DirectoryUser } from '@/lib/api/members'
import { useAppStore } from '@/stores/app-store'
import { hasLocalizedContent } from '@/lib/localized'
import type { AuthorDetails } from '@/types/author'
import type { LocalizedString } from '@/types'

interface UserDirectoryState {
  byId: Record<number, DirectoryUser>
  loaded: boolean
  loadDirectory: () => Promise<void>
  /** Resolve a user id to a current display name, or '' if unknown. */
  resolveName: (id: number) => string
}

/** Build an AuthorDetails from any user-like record, dropping empty fields.
 *  Exported so components can derive details from a raw store record inside a
 *  useMemo — calling this straight from a zustand selector returns a fresh object
 *  each render and loops the render (Maximum update depth). */
export function toDetails(u: {
  firstName?: string; lastName?: string; email?: string
  affiliation?: LocalizedString | string; profession?: LocalizedString | string; orcid?: string
}): AuthorDetails {
  const d: AuthorDetails = {}
  if (u.firstName?.trim()) d.firstName = u.firstName.trim()
  if (u.lastName?.trim()) d.lastName = u.lastName.trim()
  if (u.email?.trim()) d.email = u.email.trim()
  if (hasLocalizedContent(u.affiliation)) d.affiliation = u.affiliation
  if (hasLocalizedContent(u.profession)) d.profession = u.profession
  if (u.orcid?.trim()) d.orcid = u.orcid.trim()
  return d
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
    // The current user is the freshest source for their own name: the directory
    // is a boot-time snapshot, so a profile rename wouldn't show on their own
    // cards until reload. Prefer the live app-store value for id === me.id.
    const me = useAppStore.getState().user
    if (me && me.id === id) {
      const full = [me.firstName, me.lastName].filter(Boolean).join(' ').trim()
      return full || me.username
    }
    const u = get().byId[id]
    if (u) return displayName(u)
    return ''
  },
}))
