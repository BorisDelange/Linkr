/**
 * Where the copilot's model lives, and the record that someone accepted the risk
 * of a remote one.
 *
 * Two backings, one contract. In server mode an admin configures providers for
 * the whole workspace and approves each per surface, so a user picks from a
 * vetted list and the API key never reaches a browser. A client-only (WASM)
 * deployment has no backend, so it keeps the original localStorage settings.
 *
 * The acknowledgement rule holds in both: an unacknowledged remote endpoint
 * resolves to null rather than being used silently. That is what stands between
 * a clinical dashboard and an unnoticed data egress, so it is enforced here AND
 * server-side — neither alone is enough, since WASM has no server and a server
 * must not trust a client.
 */
import { isServerMode } from '@/lib/api-client'
import { listProviders, type AgentSurface, type LlmProvider } from '@/lib/api/llm'
import type { LlmEndpoint } from './agent-loop'
import { isLocalEndpoint } from './locality'

const STORAGE_KEY = 'linkr.agent.endpoint'

/** Ollama's default. Local, so it needs no acknowledgement. */
export const DEFAULT_BASE_URL = 'http://localhost:11434/v1'
export const DEFAULT_MODEL = 'qwen3.5:4b'

export interface AgentSettings {
  baseUrl: string
  model: string
  apiKey?: string
  /** Set only for a remote endpoint: who accepted, and when. */
  acknowledgedAt?: string
}

export interface ResolvedEndpoint {
  endpoint: LlmEndpoint | null
  isRemote: boolean
}

function parse(raw: string | null): AgentSettings | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<AgentSettings>
    if (!value.baseUrl || !value.model) return null
    return {
      baseUrl: value.baseUrl,
      model: value.model,
      apiKey: value.apiKey,
      acknowledgedAt: value.acknowledgedAt,
    }
  } catch {
    return null
  }
}

export function loadAgentSettings(): AgentSettings | null {
  try {
    return parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

export function saveAgentSettings(settings: AgentSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function clearAgentSettings(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/**
 * Models the endpoint offers, via the standard OpenAI `GET /v1/models` route —
 * implemented by Ollama, LM Studio, vLLM, OpenAI and Mistral alike, so the model
 * field can be a picker rather than a string the user has to spell correctly.
 *
 * Throws with a readable message: the caller surfaces it next to the field, since
 * "cannot list models" usually means the endpoint URL itself is wrong.
 */
export async function fetchAvailableModels(
  baseUrl: string,
  apiKey?: string
): Promise<string[]> {
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = {}
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`

  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const payload = (await response.json()) as { data?: { id?: string }[] }
  return (payload.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => Boolean(id))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * The endpoint the copilot should use, or null.
 *
 * Local (WASM) path only — see `resolveEndpointForSurface` for server mode.
 */
export function resolveAgentEndpoint(): ResolvedEndpoint {
  const settings = loadAgentSettings()
  if (!settings) return { endpoint: null, isRemote: false }

  const remote = !isLocalEndpoint(settings.baseUrl)
  if (remote && !settings.acknowledgedAt) return { endpoint: null, isRemote: true }

  return {
    endpoint: {
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey: settings.apiKey,
    },
    isRemote: remote,
  }
}

/**
 * Turn a stored provider into a usable endpoint, applying the same
 * acknowledgement rule the server applies on write.
 *
 * A provider carries no `apiKey`: the server never returns it. A remote provider
 * therefore only works through a server-side call path — which is the intent, as
 * it keeps the secret off the browser entirely.
 */
export function endpointFromProvider(provider: LlmProvider): ResolvedEndpoint {
  const remote = !provider.isLocal
  if (remote && !provider.acknowledgedAt) return { endpoint: null, isRemote: true }
  return {
    endpoint: { baseUrl: provider.baseUrl, model: provider.model },
    isRemote: remote,
  }
}

/**
 * Providers an admin approved for this surface, most recently configured first.
 * Empty in WASM mode, where there is no server to hold them.
 */
export async function listApprovedProviders(
  workspaceId: string,
  surface: AgentSurface
): Promise<LlmProvider[]> {
  if (!isServerMode() || !workspaceId) return []
  try {
    return await listProviders(workspaceId, surface)
  } catch {
    // An unreachable or forbidding server means no approved model, not a crash
    // in the page hosting the assistant.
    return []
  }
}

/**
 * The endpoint for a surface: the chosen approved provider in server mode, the
 * browser's own settings in WASM mode.
 *
 * `preferredModel` is the user's pick among the approved list; an unknown or
 * absent one falls back to the first approved provider rather than to nothing,
 * so a model being un-approved does not silently break the assistant.
 */
export async function resolveEndpointForSurface(
  workspaceId: string,
  surface: AgentSurface,
  preferredModel?: string
): Promise<ResolvedEndpoint> {
  if (!isServerMode()) return resolveAgentEndpoint()

  const providers = (await listApprovedProviders(workspaceId, surface)).filter((p) => p.enabled)
  if (!providers.length) return { endpoint: null, isRemote: false }

  const chosen = providers.find((p) => p.model === preferredModel) ?? providers[0]
  return endpointFromProvider(chosen)
}
