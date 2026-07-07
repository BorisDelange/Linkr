import { apiRequest } from '@/lib/api-client'
import type { RuntimeLanguage, RuntimeOutput } from '@/lib/runtimes/types'

/**
 * Run R/Python on the server (server mode) and return the same RuntimeOutput the
 * browser engines produce — so callers (IDE, analyses, dashboards) are agnostic
 * to where the code ran. Only the rendered result crosses the wire, never the
 * underlying data (see docs/planning/fullstack-storage-plan.html §03/§06).
 */
export function executeOnServer(
  language: RuntimeLanguage,
  code: string,
  opts?: { projectUid?: string; envId?: string },
): Promise<RuntimeOutput> {
  return apiRequest<RuntimeOutput>('/execute', {
    method: 'POST',
    body: JSON.stringify({
      language,
      code,
      projectUid: opts?.projectUid ?? null,
      envId: opts?.envId ?? 'default',
    }),
  })
}

/** Kill the persistent kernel for (project, language, env) — next run starts fresh. */
export function restartServerKernel(
  language: RuntimeLanguage,
  projectUid: string,
  envId = 'default',
): Promise<void> {
  return apiRequest<void>('/execute/restart', {
    method: 'POST',
    body: JSON.stringify({ language, projectUid, envId }),
  })
}
