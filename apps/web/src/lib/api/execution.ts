import { apiRequest } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { useSessionStore } from '@/stores/session-store'
import { TerminalSocket } from '@/lib/api/terminal-ws'
import type { RuntimeLanguage, RuntimeOutput, RuntimeFigure, RuntimeTable } from '@/lib/runtimes/types'
import type { SessionLanguage } from '@/lib/api/execution-sessions'
import type { Job } from '@/lib/api/environments'

/** The active session for (project, language) — but only R/Python carry sessions;
 *  anything else (sql) always runs in the implicit 'default' namespace. */
function activeSessionFor(projectUid: string | null, language: RuntimeLanguage): string {
  if (!projectUid || (language !== 'python' && language !== 'r')) return 'default'
  return useSessionStore.getState().getActiveSessionId(projectUid, language as SessionLanguage)
}

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
    sessionId?: string
    datasetFileId?: string
    connectionId?: string
    datasetFilters?: unknown[]
    /** Which permission the run needs. 'dashboards'|'datasets'|'patient-data' =
     *  code-backed widget/analysis (needs the resource :execute); 'ide' (default) =
     *  ide:execute. Built-in component renders use renderOnServer(), not this. */
    purpose?: 'ide' | 'dashboards' | 'datasets' | 'patient-data'
    /** Run in a FRESH, isolated ephemeral process (warm pool) instead of the
     *  project's persistent session kernel — so dashboard widgets run in parallel
     *  without sharing a namespace or serialising on one lock. */
    ephemeral?: boolean
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
  // user selected in the Session dropdown (unless a caller pins an explicit one).
  const sessionId = opts?.sessionId ?? activeSessionFor(projectUid, language)
  return apiRequest<RuntimeOutput>('/execute', {
    method: 'POST',
    body: JSON.stringify({
      language,
      code,
      projectUid,
      sessionId,
      datasetFileId: opts?.datasetFileId ?? null,
      connectionId: opts?.connectionId ?? null,
      datasetFilters: opts?.datasetFilters ?? null,
      purpose: opts?.purpose ?? 'ide',
      ephemeral: opts?.ephemeral ?? false,
    }),
  })
}

/**
 * Pre-start the warm pool for a project's language so the first ephemeral widget
 * run is import-free. Fire-and-forget: failures are swallowed (a cold run still
 * works, just slower). Call on dashboard open.
 */
export function prewarmPool(
  language: 'python' | 'r',
  projectUid: string,
  opts?: { count?: number; appEnv?: boolean },
): void {
  void apiRequest<void>('/execute/prewarm', {
    method: 'POST',
    body: JSON.stringify({
      language,
      projectUid,
      count: opts?.count ?? null,
      appEnv: opts?.appEnv ?? false,
    }),
  }).catch(() => { /* best-effort */ })
}

/**
 * Run a script server-side as a background job (batch — a fresh process, not the
 * session namespace). Returns the queued Job immediately; poll listJobs for
 * progress, and read its `result` (figures/table) once done. Cancellable + visible
 * in the jobs panel.
 */
export function runFileAsJob(
  language: RuntimeLanguage,
  code: string,
  opts?: { projectUid?: string; datasetFileId?: string; label?: string },
): Promise<Job> {
  const projectUid = opts?.projectUid ?? useAppStore.getState().activeProjectUid ?? null
  if (!projectUid) throw new Error('Cannot run code without an active project')
  return apiRequest<Job>('/execute/run-as-job', {
    method: 'POST',
    body: JSON.stringify({
      language,
      code,
      projectUid,
      datasetFileId: opts?.datasetFileId ?? null,
      label: opts?.label ?? null,
      purpose: 'ide',
    }),
  })
}

/**
 * Like executeOnServer, but STREAMS: opens the kernel WebSocket, sends the code,
 * and calls `onChunk` for each stdout/stderr fragment as it's produced (so a long
 * run shows output incrementally instead of all at once). Resolves with the final
 * RuntimeOutput (figures/table/html) when the run completes. Python/R only.
 */
export function streamOnServer(
  language: 'python' | 'r',
  code: string,
  opts: {
    projectUid?: string
    sessionId?: string
    connectionId?: string
    onChunk: (text: string, kind: 'stdout' | 'stderr') => void
    // Stop: abort closes the socket and rejects the promise promptly. The kernel
    // is separately SIGINT'd (interruptServerKernel); this ends the client wait so
    // the run doesn't stay "streaming" until the server's done/timeout.
    signal?: AbortSignal
  },
): Promise<RuntimeOutput> {
  const projectUid = opts.projectUid ?? useAppStore.getState().activeProjectUid ?? null
  if (!projectUid) throw new Error('Cannot run code without an active project')
  const sessionId = opts.sessionId ?? activeSessionFor(projectUid, language)

  return new Promise<RuntimeOutput>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (!settled) { settled = true; fn() }
      opts.signal?.removeEventListener('abort', onAbort)
      socket.close()
    }
    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    if (opts.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    opts.signal?.addEventListener('abort', onAbort)
    const socket = new TerminalSocket(
      { projectUid, language, sessionId, connectionId: opts.connectionId },
      {
        onOpen: () => socket.runCode(code),
        onMessage: (msg) => {
          if ((msg.type === 'stdout' || msg.type === 'stderr') && msg.data) {
            opts.onChunk(msg.data, msg.type)
          } else if (msg.type === 'error') {
            finish(() => reject(new Error(msg.message ?? 'Execution failed')))
          } else if (msg.type === 'done') {
            finish(() => resolve({
              // Chunks already delivered the text via onChunk; the final payload
              // carries only the rendered artefacts.
              stdout: '', stderr: '',
              figures: (msg.figures ?? []) as RuntimeFigure[],
              table: (msg.table ?? null) as RuntimeTable | null,
              html: msg.html ?? null,
            }))
          }
        },
        onClose: ({ authFailed }) => {
          if (!settled) finish(() => reject(new Error(authFailed ? 'Authentication failed' : 'Connection closed')))
        },
      },
    )
    socket.connect()
  })
}

/**
 * Run a built-in component render server-side from a structured spec. Unlike
 * executeOnServer this sends no code — the backend owns the analysis program per
 * `kind` and injects only the (validated) spec, so a viewer can trigger it safely
 * (project read). Returns the same RuntimeOutput; callers parse out.stdout as before.
 */
export function renderOnServer(
  kind: string,
  spec: unknown,
  opts?: { projectUid?: string; sessionId?: string; datasetFileId?: string; datasetFilters?: unknown[] },
): Promise<RuntimeOutput> {
  const projectUid = opts?.projectUid ?? useAppStore.getState().activeProjectUid ?? null
  if (!projectUid) throw new Error('Cannot render without an active project')
  // Render kernels are language-agnostic here; default namespace.
  const sessionId = opts?.sessionId ?? (projectUid ? activeSessionFor(projectUid, 'python') : 'default')
  return apiRequest<RuntimeOutput>('/execute/render', {
    method: 'POST',
    body: JSON.stringify({
      kind,
      spec,
      projectUid,
      sessionId,
      datasetFileId: opts?.datasetFileId ?? null,
      datasetFilters: opts?.datasetFilters ?? null,
    }),
  })
}

/** Kill the persistent kernel for (project, language, session) — next run starts fresh. */
export function restartServerKernel(
  language: RuntimeLanguage,
  projectUid: string,
  sessionId = 'default',
): Promise<void> {
  return apiRequest<void>('/execute/restart', {
    method: 'POST',
    body: JSON.stringify({ language, projectUid, sessionId }),
  })
}

/** SIGINT the running kernel for (project, language, session) — the Stop button. Keeps
 *  the namespace; just interrupts the current run. No-op if nothing is running. */
export function interruptServerKernel(
  language: RuntimeLanguage,
  projectUid: string,
  sessionId = 'default',
): Promise<void> {
  return apiRequest<void>('/execute/interrupt', {
    method: 'POST',
    body: JSON.stringify({ language, projectUid, sessionId }),
  })
}
