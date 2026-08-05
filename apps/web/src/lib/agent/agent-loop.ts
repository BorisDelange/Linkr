/**
 * The agentic loop: prompt → tool calls → results → prompt again, until the model
 * stops calling tools.
 *
 * Written against the OpenAI-compatible `/v1/chat/completions` shape because it is
 * the common denominator of Ollama, LM Studio, llama.cpp, vLLM, Mistral and
 * OpenAI — so a local model stays a first-class citizen rather than a fallback.
 * No SDK: a vendor SDK would tie the copilot to one provider, which is the
 * opposite of the "local first" requirement.
 */
import type { ToolDefinition } from './dashboard-tools'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: RawToolCall[]
  tool_call_id?: string
}

interface RawToolCall {
  id?: string
  type?: string
  function: { name: string; arguments: string | Record<string, unknown> }
}

export interface ParsedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface AgentStep {
  /** Assistant prose for this turn, if any. */
  text: string
  calls: ParsedToolCall[]
}

export interface LlmEndpoint {
  baseUrl: string
  model: string
  apiKey?: string
}

/** A model that keeps calling tools must not loop forever. */
export const MAX_TURNS = 6

export class AgentError extends Error {}

function parseArgs(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    // A malformed arguments blob is the model's error, not a crash: surface it as
    // empty args so the tool layer rejects it and the model gets told why.
    return {}
  }
}

function chatUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions')
    ? trimmed
    : `${trimmed}/chat/completions`
}

/** One request to the model. Returns its prose plus any tool calls it wants. */
export async function requestStep(
  endpoint: LlmEndpoint,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal
): Promise<AgentStep> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`

  let response: Response
  try {
    response = await fetch(chatUrl(endpoint.baseUrl), {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: endpoint.model,
        messages,
        tools,
        // Deterministic: the same request should not sometimes move a widget.
        temperature: 0,
        stream: false,
      }),
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new AgentError(`Cannot reach the model at ${endpoint.baseUrl}.`)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new AgentError(
      `Model returned ${response.status}. ${detail.slice(0, 200)}`.trim()
    )
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string; tool_calls?: RawToolCall[] } }[]
  }
  const message = payload.choices?.[0]?.message ?? {}
  const calls = (message.tool_calls ?? []).map((call, index) => ({
    // Ollama omits tool-call ids; the protocol needs one to match results back.
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? '',
    args: parseArgs(call.function?.arguments ?? {}),
  }))
  return { text: (message.content ?? '').trim(), calls }
}

/** Assistant turn to append when the model asked for tools. */
export function assistantToolMessage(step: AgentStep): ChatMessage {
  return {
    role: 'assistant',
    content: step.text,
    tool_calls: step.calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  }
}

/** Result message for one executed (or rejected) tool call. */
export function toolResultMessage(call: ParsedToolCall, message: string): ChatMessage {
  return { role: 'tool', tool_call_id: call.id, content: message }
}
