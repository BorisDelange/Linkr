import { localized } from '@/lib/localized'
import type { LlmProvider } from '@/lib/api/llm'

/** Ollama's default. Local, so it needs no acknowledgement. */
export const DEFAULT_BASE_URL = 'http://localhost:11434/v1'

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
 * The label an admin gave a provider ("Ollama Gemma 4B"), or the model id when
 * they gave none.
 *
 * Stored under `en` and not translated: it names a specific deployment, so a
 * per-language variant would be a different endpoint, not a translation.
 */
export function providerName(provider: LlmProvider | null): string {
  if (!provider) return ''
  return localized(provider.name, 'en') || provider.model
}
