import { create } from 'zustand'
import type { RuntimeLanguage } from '@/lib/runtimes/types'

/**
 * Code waiting for the person's acceptance before its first run. A dashboard with
 * several stored widgets opens one dialog listing them all: requests arriving while
 * it is open join it, and every waiting run goes on (or stops) with the one answer.
 */
export interface PendingCode {
  code: string
  language: RuntimeLanguage | 'sql'
  /** The stored template this text was resolved from, accepted along with it. */
  source?: string
  label?: string
}

interface CodeAcceptancePromptState {
  pending: PendingCode[]
  settle: (accepted: boolean) => void
}

const waiters = new Map<string, Promise<boolean>>()
let resolveAll: ((accepted: boolean) => void) | null = null
let answer: Promise<boolean> | null = null

// Declined code stays declined until the person retries: a patient board re-runs on
// every patient, and asking again each time would wear the answer down to a reflex.
const declined = new Set<string>()

export const useCodeAcceptancePrompt = create<CodeAcceptancePromptState>((set, get) => ({
  pending: [],
  settle: (accepted) => {
    if (!accepted) for (const { code } of get().pending) declined.add(code)
    const resolve = resolveAll
    resolveAll = null
    answer = null
    waiters.clear()
    set({ pending: [] })
    resolve?.(accepted)
  },
}))

export function requestCodeAcceptance(item: PendingCode): Promise<boolean> {
  if (declined.has(item.code)) return Promise.resolve(false)
  const waiting = waiters.get(item.code)
  if (waiting) return waiting
  answer ??= new Promise<boolean>((resolve) => { resolveAll = resolve })
  waiters.set(item.code, answer)
  useCodeAcceptancePrompt.setState((s) => ({ pending: [...s.pending, item] }))
  return answer
}

/** The person asked for a run: declined code may ask again. */
export function forgetDeclinedCode(): void {
  declined.clear()
}
