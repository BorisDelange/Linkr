/**
 * Server-mode client for the assistant's configuration and history.
 *
 * The API key is write-only across this boundary: it can be sent, never read
 * back. `hasApiKey` is what the UI shows instead, so a browser never holds the
 * secret. Likewise `isLocal` is whatever the server derived from the URL, not
 * something the client gets to assert.
 */
import { apiRequest } from '@/lib/api-client'

const PROVIDERS = '/llm-providers'
const REPORTS = '/llm-bench-reports'
const CONVERSATIONS = '/agent-conversations'

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

// --- Bench reports ---------------------------------------------------------

export interface BenchCaseResult {
  id: string
  label: string
  lang: string
  ok: boolean
  detail?: string | null
  ms: number
  promptTokens: number
  completionTokens: number
  calls: string[]
}

export interface ServerBenchReport {
  id: string
  workspaceId: string
  model: string
  mode: string
  lang: string
  surfaces: string[]
  passed: number
  total: number
  totalMs: number
  promptTokens: number
  completionTokens: number
  tokensPerSecond: number
  cases: BenchCaseResult[]
  ranById: number | null
  ranAt: string
}

export type BenchReportInput = Omit<ServerBenchReport, 'id' | 'ranById' | 'ranAt'>

export function listReports(workspaceId: string): Promise<ServerBenchReport[]> {
  return apiRequest<ServerBenchReport[]>(
    `${REPORTS}?workspaceId=${encodeURIComponent(workspaceId)}`
  )
}

/** Posting replaces any previous report for the same model in the workspace. */
export function saveReport(input: BenchReportInput): Promise<ServerBenchReport> {
  return apiRequest<ServerBenchReport>(REPORTS, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function deleteReport(id: string): Promise<void> {
  await apiRequest(`${REPORTS}/${id}`, { method: 'DELETE' })
}

// --- Conversations ---------------------------------------------------------

export interface ConversationScope {
  workspaceId: string
  projectUid?: string
  surface?: AgentSurface
  entityId?: string
}

/** List view: no messages, so browsing history does not ship every past prompt. */
export interface ConversationSummary {
  id: string
  workspaceId: string
  projectUid: string | null
  surface: string
  entityId: string | null
  title: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

export interface Conversation extends ConversationSummary {
  messages: Record<string, unknown>[]
}

function scopeQuery(scope: ConversationScope): URLSearchParams {
  const query = new URLSearchParams({ workspaceId: scope.workspaceId })
  if (scope.projectUid) query.set('projectUid', scope.projectUid)
  if (scope.surface) query.set('surface', scope.surface)
  if (scope.entityId) query.set('entityId', scope.entityId)
  return query
}

/** The caller's own threads — the server has no route to anyone else's. */
export function listConversations(scope: ConversationScope): Promise<ConversationSummary[]> {
  return apiRequest<ConversationSummary[]>(`${CONVERSATIONS}?${scopeQuery(scope)}`)
}

export function getConversation(id: string): Promise<Conversation> {
  return apiRequest<Conversation>(`${CONVERSATIONS}/${id}`)
}

export function createConversation(
  input: ConversationScope & { title?: string; messages?: Record<string, unknown>[] }
): Promise<Conversation> {
  return apiRequest<Conversation>(CONVERSATIONS, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateConversation(
  id: string,
  changes: { title?: string; messages?: Record<string, unknown>[] }
): Promise<Conversation> {
  return apiRequest<Conversation>(`${CONVERSATIONS}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(changes),
  })
}

export async function deleteConversation(id: string): Promise<void> {
  await apiRequest(`${CONVERSATIONS}/${id}`, { method: 'DELETE' })
}

/** Clear all — scoped to the caller's own threads. */
export async function clearConversations(scope: ConversationScope): Promise<void> {
  await apiRequest(`${CONVERSATIONS}?${scopeQuery(scope)}`, { method: 'DELETE' })
}
