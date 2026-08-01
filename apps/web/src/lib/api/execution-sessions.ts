import { apiRequest } from '@/lib/api-client'

export type SessionLanguage = 'python' | 'r'

/** A named kernel namespace (session) for the current user in a project. Scoped
 * to one language: it only appears on scripts of that language. */
export interface ExecutionSession {
  id: string
  projectUid: string
  language: SessionLanguage
  name: string
}

export function listSessions(
  projectUid: string,
  language: SessionLanguage,
): Promise<ExecutionSession[]> {
  return apiRequest<ExecutionSession[]>(
    `/execute/sessions?projectUid=${encodeURIComponent(projectUid)}&language=${language}`,
  )
}

export function createSession(
  projectUid: string,
  id: string,
  language: SessionLanguage,
  name: string,
): Promise<ExecutionSession> {
  return apiRequest<ExecutionSession>('/execute/sessions', {
    method: 'POST',
    body: JSON.stringify({ id, projectUid, language, name }),
  })
}

export function deleteSession(sessionId: string): Promise<void> {
  return apiRequest(`/execute/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  }).then(() => undefined)
}
