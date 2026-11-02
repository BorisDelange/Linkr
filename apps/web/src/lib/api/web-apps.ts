import { apiRequest, getApiBaseUrl } from '@/lib/api-client'
import { notifyJobsChanged } from '@/lib/api/environments'

/**
 * Web apps started from the IDE (Shiny, Streamlit, Dash…), server mode only.
 * The app listens on a port of the server that the browser never sees: it is
 * served by the API itself under `…/api/v1/apps/<id>/proxy/`, so it works behind
 * an SPE gateway that publishes one path and no other port.
 */

export type WebAppStatus = 'starting' | 'ready' | 'failed' | 'stopped'

export interface WebApp {
  appId: string
  projectUid: string
  label: string
  /** Relative to the project's scripts/ folder. */
  path: string
  /** A preset key, or 'custom'. */
  framework: string
  command: string
  status: WebAppStatus
  error: string | null
  /** The public path the app is served at, gateway prefix included. */
  url: string
  jobId: string
  startedAt: number
  /** The last lines the app printed; only on `getWebApp`. */
  log?: string[]
}

export interface WebAppPreset {
  key: string
  label: string
  language: 'python' | 'r'
  /** File names that make a file this framework's entry point. */
  names: string[]
  /** A regular expression (multiline) on the file's content. */
  content: string | null
}

let presets: Promise<WebAppPreset[]> | null = null

export function listWebAppPresets(): Promise<WebAppPreset[]> {
  presets ??= apiRequest<WebAppPreset[]>('/apps/presets').catch((e) => {
    presets = null
    throw e
  })
  return presets
}

const LANGUAGE: Record<string, WebAppPreset['language']> = { r: 'r', py: 'python' }

/** The framework a file is the entry point of, by the server's own rules: by
 *  name first, then by content. */
export function detectWebAppPreset(
  fileName: string,
  content: string,
  all: WebAppPreset[],
): WebAppPreset | null {
  const language = LANGUAGE[fileName.split('.').pop()?.toLowerCase() ?? '']
  const candidates = all.filter((p) => p.language === language)
  const base = fileName.split('/').pop() ?? fileName
  return (
    candidates.find((p) => p.names.includes(base))
    ?? candidates.find((p) => p.content && new RegExp(p.content, 'm').test(content))
    ?? null
  )
}

/** Where the browser reaches the API, as a path: `''` at the root, the gateway's
 *  prefix (`/docker-8743`) behind one. Only the browser knows it. */
function publicPrefix(): string {
  return new URL(getApiBaseUrl() || '/', window.location.href).pathname.replace(/\/+$/, '')
}

/** The URL to load an app at — absolute, since in development the API is on
 *  another origin than the page. */
export function webAppFrameUrl(url: string): string {
  return new URL(url, new URL(getApiBaseUrl() || '/', window.location.href)).href
}

/** Whether a WebSocket gets through to the API: a gateway that drops the
 *  Upgrade header leaves Shiny and Streamlit frozen on their first page. */
export function webSocketsGetThrough(app: WebApp, timeoutMs = 8000): Promise<boolean> {
  const url = webAppFrameUrl(app.url.replace(/[^/]+\/proxy\/$/, 'ws-check')).replace(/^http/, 'ws')
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const done = (ok: boolean) => {
      clearTimeout(timer)
      ws.onopen = ws.onerror = null
      ws.close()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    ws.onopen = () => done(true)
    ws.onerror = () => done(false)
  })
}

export async function startWebApp(opts: {
  projectUid: string
  path: string
  framework?: string
  command?: string
}): Promise<WebApp> {
  const app = await apiRequest<WebApp>('/apps', {
    method: 'POST',
    body: JSON.stringify({ ...opts, publicPrefix: publicPrefix() }),
  })
  notifyJobsChanged()
  return app
}

/** Stop an app and start it again as it was started: the code changes since then
 *  are picked up (Shiny, Dash… read the file once, at start). */
export async function restartWebApp(app: WebApp): Promise<WebApp> {
  if (app.status === 'starting' || app.status === 'ready') await stopWebApp(app.appId)
  return startWebApp({
    projectUid: app.projectUid,
    path: app.path,
    ...(app.framework === 'custom' ? { command: app.command } : { framework: app.framework }),
  })
}

export function getWebApp(appId: string): Promise<WebApp> {
  return apiRequest<WebApp>(`/apps/${encodeURIComponent(appId)}`)
}

export function listWebApps(projectUid: string): Promise<WebApp[]> {
  return apiRequest<WebApp[]>(`/apps?projectUid=${encodeURIComponent(projectUid)}`)
}

export async function stopWebApp(appId: string): Promise<void> {
  await apiRequest<void>(`/apps/${encodeURIComponent(appId)}`, { method: 'DELETE' })
  notifyJobsChanged()
}
