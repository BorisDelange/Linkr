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

/** The server builds a project's environment before a run only once this user has
 *  accepted its spec, which names the package code the build runs. */
export interface EnvironmentRefusal {
  language: 'python' | 'r'
  spec: string
}

/** `detail`: a 428's detail, or a terminal's error message. */
export function environmentRefusal(detail: unknown): EnvironmentRefusal | null {
  const d = detail as { code?: unknown; language?: unknown; spec?: unknown } | null | undefined
  if (d?.code !== 'environment_acceptance_required' || typeof d.spec !== 'string') return null
  return { language: d.language === 'r' ? 'r' : 'python', spec: d.spec }
}

function environmentRefusalOf(err: unknown): EnvironmentRefusal | null {
  if (!(err instanceof ApiError) || err.status !== 428) return null
  try {
    return environmentRefusal(JSON.parse(err.message)?.detail)
  } catch {
    return null
  }
}

export function requestEnvironmentAcceptance(refusal: EnvironmentRefusal): Promise<boolean> {
  return requestCodeAcceptance({
    code: refusal.spec,
    language: refusal.language,
    label: i18n.t('code_acceptance.environment', { language: refusal.language === 'r' ? 'R' : 'Python' }),
  })
}

/** Run `send`; when the server asks for the environment's acceptance, get it, then
 *  run once more. Declined: the refusal is thrown as it came. */
export async function withEnvironmentAcceptance<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send()
  } catch (err) {
    const refusal = environmentRefusalOf(err)
    if (!refusal || !await requestEnvironmentAcceptance(refusal)) throw err
  }
  return send()
}

async function obtainAcceptance(code: string, language: RuntimeLanguage, review?: CodeReview): Promise<boolean> {
  if (review?.authored || (review?.source && await isCodeAccepted(review.source))) {
    await acceptCode([code])
    return true
  }
  return requestCodeAcceptance({ code, language, source: review?.source, label: review?.label })
}

/** Run `send`; when the server asks for an acceptance, get it, then run once more.
 *  Null when the person declines. */
async function retryOnAcceptance<T>(send: () => Promise<T>, obtain: () => Promise<boolean>): Promise<T | null> {
  // More than one round: code that joined the dialog as its answer was being saved
  // is refused once more, and asks again rather than failing.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await send()
    } catch (err) {
      if (!isAcceptanceRefusal(err) || attempt === 2) throw err
    }
    if (!await obtain()) break
  }
  return null
}

export async function withCodeAcceptance(
  code: string,
  language: RuntimeLanguage,
  review: CodeReview | undefined,
  send: () => Promise<RuntimeOutput>,
): Promise<RuntimeOutput> {
  let output: RuntimeOutput | null = null
  try {
    output = await retryOnAcceptance(() => withEnvironmentAcceptance(send), () => obtainAcceptance(code, language, review))
  } catch (err) {
    if (!environmentRefusalOf(err)) throw err
  }
  return output ?? {
    stdout: '',
    stderr: i18n.t('code_acceptance.not_run'),
    figures: [],
    table: null,
    html: null,
    notAccepted: true,
  }
}

/** Run a request the server holds until the person accepts the stored SQL it runs
 *  (a cohort's custom SQL on an external database). Null when they decline. */
export function withSqlAcceptance<T>(code: string, label: string | undefined, send: () => Promise<T>): Promise<T | null> {
  return retryOnAcceptance(send, () => requestCodeAcceptance({ code, language: 'sql', label }))
}
