/**
 * Where the copilot's model lives, and the record that someone accepted the risk
 * of a remote one.
 *
 * Client-side settings for now: the LlmProvider table exists but its API does not
 * (plan batch 1), so this is the single place to swap when providers become
 * server-backed. The acknowledgement flow below is the part that must NOT move —
 * it is what stands between a clinical dashboard and an unnoticed data egress.
 */
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
 * The endpoint the copilot should use, or null.
 *
 * A remote endpoint that was never acknowledged resolves to null rather than
 * being used silently: forgetting to confirm must disable the assistant, not
 * quietly send clinical context to a third party.
 */
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
