import { apiRequest } from '@/lib/api-client'

export type MemberRole = 'viewer' | 'editor' | 'owner'

export interface MemberUser {
  id: number
  username: string
  email: string | null
}

export interface WorkspaceMember {
  workspaceId: string
  userId: number
  role: MemberRole
  user?: MemberUser
  createdAt?: string
}

export interface ProjectMember {
  projectUid: string
  userId: number
  role: MemberRole
  user?: MemberUser
  createdAt?: string
}

/** Add a member by username, or change an existing member's role. */
export interface MemberWrite {
  userId?: number
  username?: string
  role: MemberRole
}

export const membersApi = {
  listWorkspace: (workspaceId: string) =>
    apiRequest<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`),

  upsertWorkspace: (workspaceId: string, body: MemberWrite) =>
    apiRequest<WorkspaceMember>(`/workspaces/${workspaceId}/members`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  removeWorkspace: (workspaceId: string, userId: number) =>
    apiRequest<void>(`/workspaces/${workspaceId}/members/${userId}`, {
      method: 'DELETE',
    }),

  listProject: (projectUid: string) =>
    apiRequest<ProjectMember[]>(`/projects/${projectUid}/members`),

  upsertProject: (projectUid: string, body: MemberWrite) =>
    apiRequest<ProjectMember>(`/projects/${projectUid}/members`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  removeProject: (projectUid: string, userId: number) =>
    apiRequest<void>(`/projects/${projectUid}/members/${userId}`, {
      method: 'DELETE',
    }),
}
