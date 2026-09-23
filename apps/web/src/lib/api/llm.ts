/**
 * Server-mode client for the workspace's LLM providers.
 *
 * The API key is write-only across this boundary: it can be sent, never read
 * back. `hasApiKey` is what the UI shows instead, so a browser never holds the
 * secret. Likewise `isLocal` is whatever the server derived from the URL, not
 * something the client gets to assert.
 */
import { apiRequest } from '@/lib/api-client'

const PROVIDERS = '/llm-providers'

/** Where a model may be offered. Approval is per surface: a model can drive a
 *  dashboard well and be poor in the IDE. */
export type AgentSurface = 'dashboard' | 'ide'

export interface LlmProvider {
  id: string
  workspaceId: string
  name: Record<string, string>
  kind: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  isLocal: boolean
  enabled: boolean
  surfaces: AgentSurface[]
  acknowledgedById: number | null
  acknowledgedAt: string | null
  createdById: number | null
  createdAt: string
  updatedAt: string
}

export interface LlmProviderInput {
  workspaceId: string
  name?: Record<string, string>
  kind?: string
  baseUrl: string
  model: string
  /** Sent once; stored encrypted and never returned. "" clears a stored key. */
  apiKey?: string
  enabled?: boolean
  surfaces?: AgentSurface[]
  /** Required by the server for a remote endpoint — it refuses without one. */
  acknowledgementText?: string
}

export function listProviders(
  workspaceId: string,
  surface?: AgentSurface
): Promise<LlmProvider[]> {
  const query = new URLSearchParams({ workspaceId })
  if (surface) query.set('surface', surface)
  return apiRequest<LlmProvider[]>(`${PROVIDERS}?${query}`)
}

export function createProvider(input: LlmProviderInput): Promise<LlmProvider> {
  return apiRequest<LlmProvider>(PROVIDERS, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateProvider(
  id: string,
  changes: Partial<Omit<LlmProviderInput, 'workspaceId'>>
): Promise<LlmProvider> {
  return apiRequest<LlmProvider>(`${PROVIDERS}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(changes),
  })
}

export async function deleteProvider(id: string): Promise<void> {
  await apiRequest(`${PROVIDERS}/${id}`, { method: 'DELETE' })
}
