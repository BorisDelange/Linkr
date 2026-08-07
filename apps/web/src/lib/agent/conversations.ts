/**
 * Persisting a conversation, subject to the user's consent.
 *
 * A prompt can quote clinical context from the dashboard it was typed on, so
 * saving is opt-out and the choice travels with the user (server-side
 * preference) rather than being re-defaulted to "on" in each new browser. When
 * saving is off nothing is written at all — not a stub, not a title.
 *
 * Only the transcript is stored: the raw exchanges (full request payloads,
 * token counts) are a debugging aid for the current session and would multiply
 * the amount of clinical text at rest for no benefit.
 */
import { isServerMode } from '@/lib/api-client'
import {
  clearConversations,
  createConversation,
  deleteConversation,
  listConversations,
  updateConversation,
  type ConversationSummary,
} from '@/lib/api/llm'
import type { TranscriptEntry } from '@/stores/agent-session-store'

export const SAVE_CONVERSATIONS_KEY = 'saveConversations'

/** Consent defaults to ON: the feature is what the user asked for, and it is
 *  one toggle away. The safety guarantee is privacy (author-only), not absence. */
export function savingEnabled(preferences: Record<string, unknown> | undefined): boolean {
  return preferences?.[SAVE_CONVERSATIONS_KEY] !== false
}

/** First user turn, trimmed — enough to recognise a thread in a list. */
export function conversationTitle(transcript: TranscriptEntry[]): string {
  const first = transcript.find((entry) => entry.kind === 'user')
  const text = (first?.text ?? '').trim().replace(/\s+/g, ' ')
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

export interface ConversationScopeArgs {
  workspaceId: string
  projectUid: string
  dashboardId: string
}

function scope(args: ConversationScopeArgs) {
  return {
    workspaceId: args.workspaceId,
    projectUid: args.projectUid,
    surface: 'dashboard' as const,
    entityId: args.dashboardId,
  }
}

/**
 * Create or update the stored thread, returning its id.
 *
 * Returns null when saving is off, when there is no server, or when the write
 * fails — a failure to persist must never interrupt a conversation in progress,
 * so callers treat null as "carry on unsaved".
 */
export async function persistConversation(
  args: ConversationScopeArgs & {
    conversationId: string | null
    transcript: TranscriptEntry[]
    enabled: boolean
  }
): Promise<string | null> {
  if (!args.enabled || !isServerMode() || !args.workspaceId) return null
  if (!args.transcript.length) return null

  const payload = {
    title: conversationTitle(args.transcript),
    messages: args.transcript as unknown as Record<string, unknown>[],
  }

  try {
    if (args.conversationId) {
      await updateConversation(args.conversationId, payload)
      return args.conversationId
    }
    const created = await createConversation({ ...scope(args), ...payload })
    return created.id
  } catch {
    return null
  }
}

export async function listOwnConversations(
  args: ConversationScopeArgs
): Promise<ConversationSummary[]> {
  if (!isServerMode() || !args.workspaceId) return []
  try {
    return await listConversations(scope(args))
  } catch {
    return []
  }
}

export async function removeConversation(id: string): Promise<void> {
  await deleteConversation(id)
}

export async function clearOwnConversations(args: ConversationScopeArgs): Promise<void> {
  await clearConversations(scope(args))
}
