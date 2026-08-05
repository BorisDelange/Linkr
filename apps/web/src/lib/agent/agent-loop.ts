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
  usage?: StepUsage
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

/**
 * Recover a tool call a model printed as prose instead of emitting through the
 * tool-call protocol — e.g. `{"name": "remove_tab", "parameters": {...}}`.
 *
 * Small models do this regularly, and the failure is silent and baffling: the
 * user sees the JSON echoed in the chat and nothing happens. Salvaging it is
 * safe because the call still passes the same whitelist and validation as any
 * other, and destructive tools still require confirmation.
 */
export function salvageTextToolCall(text: string): ParsedToolCall | null {
  if (!text.includes('"name"')) return null
  // Take the outermost {...} so nested argument objects survive.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      name?: string
      parameters?: Record<string, unknown>
      arguments?: Record<string, unknown>
    }
    if (typeof parsed.name !== 'string' || !parsed.name) return null
    return {
      id: 'call_salvaged',
      name: parsed.name,
      args: parsed.parameters ?? parsed.arguments ?? {},
    }
  } catch {
    return null
  }
}

function chatUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions')
    ? trimmed
    : `${trimmed}/chat/completions`
}

/** Usage counters, when the model reports them. */
export interface StepUsage {
  promptTokens: number
  completionTokens: number
}

/**
 * One request to the model. Returns its prose plus any tool calls it wants.
 *
 * `onDelta` streams assistant text as it arrives so the panel can show the reply
 * forming rather than freezing; tool calls are only assembled once the response
 * completes, since their arguments arrive in fragments that are not valid JSON
 * until the end.
 */
export async function requestStep(
  endpoint: LlmEndpoint,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
  onDelta?: (chunk: string) => void
): Promise<AgentStep> {
  if (onDelta) return streamStep(endpoint, messages, tools, signal, onDelta)
  return blockingStep(endpoint, messages, tools, signal)
}

async function blockingStep(
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
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const message = payload.choices?.[0]?.message ?? {}
  const calls = (message.tool_calls ?? []).map((call, index) => ({
    // Ollama omits tool-call ids; the protocol needs one to match results back.
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? '',
    args: parseArgs(call.function?.arguments ?? {}),
  }))
  return {
    text: (message.content ?? '').trim(),
    calls,
    usage: readUsage(payload.usage),
  }
}

function readUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
): StepUsage | undefined {
  if (!usage) return undefined
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
  }
}

/**
 * Streaming variant: emits assistant text as it arrives and accumulates tool
 * calls, whose `arguments` come in fragments that only parse once complete.
 */
async function streamStep(
  endpoint: LlmEndpoint,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal | undefined,
  onDelta: (chunk: string) => void
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
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
      }),
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new AgentError(`Cannot reach the model at ${endpoint.baseUrl}.`)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new AgentError(`Model returned ${response.status}. ${detail.slice(0, 200)}`.trim())
  }
  if (!response.body) throw new AgentError('The model returned an empty stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const partials = new Map<number, { id?: string; name: string; args: string }>()
  let text = ''
  let usage: StepUsage | undefined
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE frames are newline-delimited; keep the trailing partial line.
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue

      let chunk: {
        choices?: {
          delta?: { content?: string; tool_calls?: (RawToolCall & { index?: number })[] }
        }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      try {
        chunk = JSON.parse(data)
      } catch {
        continue // a malformed frame must not abort a working stream
      }

      if (chunk.usage) usage = readUsage(chunk.usage)
      const delta = chunk.choices?.[0]?.delta
      if (delta?.content) {
        text += delta.content
        onDelta(delta.content)
      }
      for (const [position, call] of (delta?.tool_calls ?? []).entries()) {
        const index = call.index ?? position
        const existing = partials.get(index) ?? { name: '', args: '' }
        partials.set(index, {
          id: call.id ?? existing.id,
          name: call.function?.name || existing.name,
          args:
            existing.args +
            (typeof call.function?.arguments === 'string' ? call.function.arguments : ''),
        })
      }
    }
  }

  const calls: ParsedToolCall[] = [...partials.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id ?? `call_${index}`,
      name: call.name,
      args: parseArgs(call.args),
    }))
    .filter((call) => call.name)

  return { text: text.trim(), calls, usage }
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
