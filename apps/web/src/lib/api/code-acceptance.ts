import { apiRequest, ApiError } from '@/lib/api-client'
import i18n from '@/lib/i18n'
import type { RuntimeLanguage, RuntimeOutput } from '@/lib/runtimes/types'
import { requestCodeAcceptance } from '@/stores/code-acceptance-prompt'

/**
 * What the client knows about code it is about to run, for the server's refusal of
 * code this user has not accepted (`code_acceptance_service`). The server decides;
 * this only settles how the person is asked.
 */
export interface CodeReview {
  /** The person is writing this code or has it on screen as they press Run. */
  authored?: boolean
  /** The stored template this text resolves. Its config values are serialised as
   *  literals (`resolveTemplate`), so accepting the template covers them all. */
  source?: string
  /** What the dialog calls this code: the widget's or analysis's name. */
  label?: string
}

const ACCEPT_BATCH = 100

export async function acceptCode(codes: string[]): Promise<void> {
  for (let i = 0; i < codes.length; i += ACCEPT_BATCH) {
    await apiRequest<void>('/code-acceptances', {
      method: 'POST',
      body: JSON.stringify({ codes: codes.slice(i, i + ACCEPT_BATCH) }),
    })
  }
}

function isCodeAccepted(code: string): Promise<boolean> {
  return apiRequest<{ accepted: boolean }>('/code-acceptances/check', {
    method: 'POST',
    body: JSON.stringify({ code }),
  }).then((r) => r.accepted)
}

function isAcceptanceRefusal(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 428) return false
  try {
    return JSON.parse(err.message)?.detail?.code === 'code_acceptance_required'
  } catch {
    return false
  }
}

async function obtainAcceptance(code: string, language: RuntimeLanguage, review?: CodeReview): Promise<boolean> {
  if (review?.authored || (review?.source && await isCodeAccepted(review.source))) {
    await acceptCode([code])
    return true
  }
  return requestCodeAcceptance({ code, language, source: review?.source, label: review?.label })
}

/** Run `send`; when the server asks for an acceptance, get it, then run once more. */
export async function withCodeAcceptance(
  code: string,
  language: RuntimeLanguage,
  review: CodeReview | undefined,
  send: () => Promise<RuntimeOutput>,
): Promise<RuntimeOutput> {
  // More than one round: code that joined the dialog as its answer was being saved
  // is refused once more, and asks again rather than failing.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await send()
    } catch (err) {
      if (!isAcceptanceRefusal(err) || attempt === 2) throw err
    }
    if (!await obtainAcceptance(code, language, review)) break
  }
  return {
    stdout: '',
    stderr: i18n.t('code_acceptance.not_run'),
    figures: [],
    table: null,
    html: null,
    notAccepted: true,
  }
}
