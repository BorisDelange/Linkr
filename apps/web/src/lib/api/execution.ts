import { apiRequest } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
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
  opts?: {
    projectUid?: string
    envId?: string
    datasetFileId?: string
    connectionId?: string
    datasetFilters?: unknown[]
  },
): Promise<RuntimeOutput> {
  // The backend resolves a disk-source dataset (datasetFileId = its path) only
  // with a project context; analysis components don't pass projectUid, so default
  // it to the active project. Also scopes the persistent kernel per project.
  const projectUid = opts?.projectUid ?? useAppStore.getState().activeProjectUid ?? null
  return apiRequest<RuntimeOutput>('/execute', {
    method: 'POST',
    body: JSON.stringify({
      language,
      code,
      projectUid,
      envId: opts?.envId ?? 'default',
      datasetFileId: opts?.datasetFileId ?? null,
      connectionId: opts?.connectionId ?? null,
      datasetFilters: opts?.datasetFilters ?? null,
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
