import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { Organization, OrganizationInfo } from '@/types'

interface OrganizationState {
  // Data
  _organizationsRaw: Organization[]
  organizationsLoaded: boolean

  // CRUD
  loadOrganizations: () => Promise<void>
  addOrganization: (info: OrganizationInfo) => Promise<string>
  updateOrganization: (id: string, changes: Partial<OrganizationInfo>) => Promise<void>
  deleteOrganization: (id: string) => Promise<void>

  // Helpers
  getOrganization: (id: string) => Organization | undefined
}

export const useOrganizationStore = create<OrganizationState>((set, get) => ({
  _organizationsRaw: [],
  organizationsLoaded: false,

  loadOrganizations: async () => {
    const storage = getStorage()
    try {
      const organizations = await storage.organizations.getAll()
      set({ _organizationsRaw: organizations, organizationsLoaded: true })
    } catch {
      // Organizations are a global-tier resource (organizations:read); a user
      // without that permission gets a 403. That's expected — treat it as "no
      // organizations visible" rather than crashing the app at boot.
      set({ _organizationsRaw: [], organizationsLoaded: true })
    }
  },

  addOrganization: async (info) => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const org: Organization = {
      ...info,
      id,
      createdAt: now,
      updatedAt: now,
    }
    await getStorage().organizations.create(org)
    set((s) => ({ _organizationsRaw: [...s._organizationsRaw, org] }))
    return id
  },

  updateOrganization: async (id, changes) => {
    await getStorage().organizations.update(id, changes)
    set((s) => ({
      _organizationsRaw: s._organizationsRaw.map((o) =>
        o.id === id ? { ...o, ...changes, updatedAt: new Date().toISOString() } : o,
      ),
    }))
  },

  deleteOrganization: async (id) => {
    await getStorage().organizations.delete(id)
    // Clear organizationId on all workspaces that referenced this org
    const storage = getStorage()
    const workspaces = await storage.workspaces.getAll()
    for (const ws of workspaces) {
      if (ws.organizationId === id) {
        await storage.workspaces.update(ws.id, { organizationId: undefined })
      }
    }
    set((s) => ({ _organizationsRaw: s._organizationsRaw.filter((o) => o.id !== id) }))
    // Trigger workspace store refresh
    const { useWorkspaceStore } = await import('./workspace-store')
    await useWorkspaceStore.getState().loadWorkspaces()
  },

  getOrganization: (id) => {
    return get()._organizationsRaw.find((o) => o.id === id)
  },
}))
