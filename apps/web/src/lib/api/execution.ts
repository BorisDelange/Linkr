import { apiRequest } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { useSessionStore } from '@/stores/session-store'
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
    /** Which execute permission the run needs: a render purpose ('dashboards' |
     *  'datasets' | 'patient-data') is held by viewers; 'ide' (default) needs
     *  ide:execute. */
    purpose?: 'ide' | 'dashboards' | 'datasets' | 'patient-data'
  },
): Promise<RuntimeOutput> {
  // The backend resolves a disk-source dataset (datasetFileId = its path) only
  // with a project context; analysis components don't pass projectUid, so default
  // it to the active project. Also scopes the persistent kernel per project.
  const projectUid = opts?.projectUid ?? useAppStore.getState().activeProjectUid ?? null
  // The server refuses context-less runs (no workspace/project scope). Fail here
  // with a clear message rather than sending a request that can only 400.
  if (!projectUid) throw new Error('Cannot run code without an active project')
  // Default to the project's active session so runs land in the namespace the
  // user selected in the Session dropdown (unless a caller pins an explicit env).
  const envId =
    opts?.envId ??
    (projectUid ? useSessionStore.getState().getActiveSessionId(projectUid) : 'default')
  return apiRequest<RuntimeOutput>('/execute', {
    method: 'POST',
    body: JSON.stringify({
      language,
      code,
      projectUid,
      envId,
      datasetFileId: opts?.datasetFileId ?? null,
      connectionId: opts?.connectionId ?? null,
      datasetFilters: opts?.datasetFilters ?? null,
      purpose: opts?.purpose ?? 'ide',
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
