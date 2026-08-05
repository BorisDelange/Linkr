/**
 * Where the copilot's model lives.
 *
 * MVP stopgap: the LlmProvider table and its API exist as a model but are not
 * wired to routes yet (plan batch 1), so this reads a localStorage override to
 * make the sidebar testable against a local Ollama. Once providers are served by
 * the API, this resolves from the workspace's active provider instead and the
 * override is dropped.
 *
 * Deliberately explicit rather than a silent default: nothing points at a model
 * unless someone set it, so the copilot button stays hidden on a fresh install.
 */
import type { LlmEndpoint } from './agent-loop'
import { isLocalEndpoint } from './locality'

const STORAGE_KEY = 'linkr.agent.endpoint'

export interface ResolvedEndpoint {
  endpoint: LlmEndpoint | null
  isRemote: boolean
}

export function readAgentEndpoint(): ResolvedEndpoint {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { endpoint: null, isRemote: false }
    const parsed = JSON.parse(raw) as Partial<LlmEndpoint>
    if (!parsed.baseUrl || !parsed.model) return { endpoint: null, isRemote: false }
    const endpoint: LlmEndpoint = {
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      apiKey: parsed.apiKey,
    }
    return { endpoint, isRemote: !isLocalEndpoint(endpoint.baseUrl) }
  } catch {
    return { endpoint: null, isRemote: false }
  }
}
