import { apiRequest } from '@/lib/api-client'

/** A named kernel namespace (session) for the current user in a project. */
export interface ExecutionSession {
  id: string
  projectUid: string
  name: string
}

export function listSessions(projectUid: string): Promise<ExecutionSession[]> {
  return apiRequest<ExecutionSession[]>(
    `/execute/sessions?projectUid=${encodeURIComponent(projectUid)}`,
  )
}

export function createSession(
  projectUid: string,
  id: string,
  name: string,
): Promise<ExecutionSession> {
  return apiRequest<ExecutionSession>('/execute/sessions', {
    method: 'POST',
    body: JSON.stringify({ id, projectUid, name }),
  })
}

export function deleteSession(sessionId: string): Promise<void> {
  return apiRequest(`/execute/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  }).then(() => undefined)
}
