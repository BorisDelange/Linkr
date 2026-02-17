import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { Workspace, GitRemoteConfig, Language, ProjectBadge } from '@/types'
import { useAppStore, registerWorkspaceStore } from './app-store'
import { useOrganizationStore } from './organization-store'

export interface WorkspaceItem {
  id: string
  name: string
  description: string
  organizationName: string
  createdAt: string
  updatedAt: string
}

function resolveOrgName(ws: Workspace): string {
  if (ws.organizationId) {
    const org = useOrganizationStore.getState().getOrganization(ws.organizationId)
    if (org) return org.name
  }
  // Fallback to embedded org (legacy data)
  return ws.organization?.name ?? ''
}

function workspaceToItem(ws: Workspace, lang: string): WorkspaceItem {
  return {
    id: ws.id,
    name: ws.name[lang] ?? ws.name['en'] ?? Object.values(ws.name)[0] ?? '',
    description: ws.description[lang] ?? ws.description['en'] ?? Object.values(ws.description)[0] ?? '',
    organizationName: resolveOrgName(ws),
    createdAt: ws.createdAt.split('T')[0],
    updatedAt: ws.updatedAt,
  }
}

interface WorkspaceState {
  // Data
  _workspacesRaw: Workspace[]
  workspaces: WorkspaceItem[]
  workspacesLoaded: boolean

  // Active workspace
  activeWorkspaceId: string | null
  activeWorkspaceName: string | null

  // CRUD
  loadWorkspaces: () => Promise<void>
  addWorkspace: (params: {
    name: string
    description: string
    organizationId?: string
    gitRemoteConfig?: GitRemoteConfig
  }) => Promise<string>
  updateWorkspace: (id: string, changes: Partial<Workspace>) => Promise<void>
  updateWorkspaceBadges: (id: string, badges: ProjectBadge[]) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>

  // Navigation
  openWorkspace: (id: string, name: string) => void
  closeWorkspace: () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, _get) => ({
  _workspacesRaw: [],
  workspaces: [],
  workspacesLoaded: false,

  activeWorkspaceId: null,
  activeWorkspaceName: null,

  loadWorkspaces: async () => {
    const storage = getStorage()
    const workspaces = await storage.workspaces.getAll()
    const lang = useAppStore.getState().language
    set({
      _workspacesRaw: workspaces,
      workspaces: workspaces.map((ws) => workspaceToItem(ws, lang)),
      workspacesLoaded: true,
    })
  },

  addWorkspace: async ({ name, description, organizationId, gitRemoteConfig }) => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const lang = useAppStore.getState().language
    const workspace: Workspace = {
      id,
      name: { [lang]: name },
      description: { [lang]: description },
      organizationId,
      gitRemoteConfig,
      createdAt: now,
      updatedAt: now,
    }
    await getStorage().workspaces.create(workspace)
    set((s) => ({
      _workspacesRaw: [...s._workspacesRaw, workspace],
      workspaces: [...s.workspaces, workspaceToItem(workspace, lang)],
    }))
    return id
  },

  updateWorkspace: async (id, changes) => {
    await getStorage().workspaces.update(id, changes)
    const lang = useAppStore.getState().language
    set((s) => {
      const newRaw = s._workspacesRaw.map((ws) =>
        ws.id === id ? { ...ws, ...changes, updatedAt: new Date().toISOString() } : ws,
      )
      return {
        _workspacesRaw: newRaw,
        workspaces: newRaw.map((ws) => workspaceToItem(ws, lang)),
        activeWorkspaceName:
          s.activeWorkspaceId === id
            ? (changes.name
                ? (changes.name[lang] ?? changes.name['en'] ?? Object.values(changes.name)[0] ?? s.activeWorkspaceName)
                : s.activeWorkspaceName)
            : s.activeWorkspaceName,
      }
    })
  },

  updateWorkspaceBadges: async (id, badges) => {
    await getStorage().workspaces.update(id, { badges })
    const lang = useAppStore.getState().language
    set((s) => {
      const newRaw = s._workspacesRaw.map((ws) =>
        ws.id === id ? { ...ws, badges, updatedAt: new Date().toISOString() } : ws,
      )
      return {
        _workspacesRaw: newRaw,
        workspaces: newRaw.map((ws) => workspaceToItem(ws, lang)),
      }
    })
  },

  deleteWorkspace: async (id) => {
    await getStorage().workspaces.delete(id)
    set((s) => ({
      _workspacesRaw: s._workspacesRaw.filter((ws) => ws.id !== id),
      workspaces: s.workspaces.filter((ws) => ws.id !== id),
      activeWorkspaceId: s.activeWorkspaceId === id ? null : s.activeWorkspaceId,
      activeWorkspaceName: s.activeWorkspaceId === id ? null : s.activeWorkspaceName,
    }))
  },

  openWorkspace: (id, name) => {
    // Close any active project when switching workspaces
    useAppStore.getState().closeProject()
    set({ activeWorkspaceId: id, activeWorkspaceName: name })
  },

  closeWorkspace: () => {
    // Close any active project too
    useAppStore.getState().closeProject()
    set({ activeWorkspaceId: null, activeWorkspaceName: null })
  },
}))

// Register with app-store to break circular dependency
registerWorkspaceStore(useWorkspaceStore)

// Re-derive display items when language changes
useAppStore.subscribe((state, prevState) => {
  if (state.language !== (prevState as { language: Language }).language) {
    const wsState = useWorkspaceStore.getState()
    if (wsState._workspacesRaw.length > 0) {
      useWorkspaceStore.setState({
        workspaces: wsState._workspacesRaw.map((ws) => workspaceToItem(ws, state.language)),
      })
    }
  }
})

// Re-derive display items when organization data changes (org name updated, etc.)
useOrganizationStore.subscribe((state, prevState) => {
  if (state._organizationsRaw !== prevState._organizationsRaw) {
    const wsState = useWorkspaceStore.getState()
    if (wsState._workspacesRaw.length > 0) {
      const lang = useAppStore.getState().language
      useWorkspaceStore.setState({
        workspaces: wsState._workspacesRaw.map((ws) => workspaceToItem(ws, lang)),
      })
    }
  }
})
