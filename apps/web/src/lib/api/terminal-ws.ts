/**
 * WebSocket client for the interactive server terminal (storage plan §07d).
 *
 * Two protocols share one endpoint, keyed by language:
 * - python / r: send { code } to run on the project's persistent kernel; receive
 *   { type: 'stdout' | 'stderr', data } chunks live, then a { type: 'done' }.
 *   Send { interrupt: true } for Ctrl+C (SIGINT).
 * - bash: a raw PTY — send { input } keystrokes / { resize }, receive
 *   { type: 'output', data } raw terminal bytes, then { type: 'exit' } on close.
 *
 * The browser cannot set an Authorization header on a WS handshake, so the JWT
 * travels as ?token=, and the server re-checks that token while the socket lives.
 * When it expires under a working session (code 4401 after open), a socket made
 * with `renewOnExpiry` renews the token and reopens once per expiry; any other
 * auth close surfaces an error and does NOT reconnect.
 */
import { apiFetch, getApiBaseUrl } from '@/lib/api-client'
import i18n from '@/lib/i18n'

export type TerminalLanguage = 'python' | 'r' | 'bash'

/** Close code the backend uses for an auth failure (ws_auth.WS_AUTH_FAILED). */
export const WS_AUTH_FAILED = 4401
/** Close code for a user who may not open one (ws_auth.WS_FORBIDDEN): code
 *  execution is off, or no `ide:execute` on the project. */
export const WS_FORBIDDEN = 4403

export interface TerminalMessage {
  type: 'stdout' | 'stderr' | 'output' | 'done' | 'exit' | 'error'
  data?: string
  message?: string
  figures?: unknown[]
  table?: unknown
  html?: string | null
  /** On 'done': the code raised. Distinct from having written to stderr, which R
   *  does for warnings and messages too. */
  failed?: boolean
}

/** How long the handshake may stay pending before we give up on it. */
export const WS_OPEN_TIMEOUT_MS = 15_000

export interface TerminalCloseInfo {
  /** Code 4401. */
  authFailed: boolean
  /** Code 4403. */
  forbidden: boolean
  clean: boolean
  /** The handshake never completed: the socket closed before `open`. */
  neverOpened: boolean
  /** The handshake hung for WS_OPEN_TIMEOUT_MS and we closed it ourselves. */
  timedOut: boolean
}

export interface TerminalSocketHandlers {
  onMessage: (msg: TerminalMessage) => void
  onOpen?: () => void
  /** The socket reopened with a renewed token (`renewOnExpiry`); `onOpen` is not
   *  called again. */
  onRenewed?: () => void
  /** Called once when the socket closes. */
  onClose?: (info: TerminalCloseInfo) => void
}

export function wsBaseUrl(): string {
  // Derive the WS origin from VITE_API_URL (http→ws, https→wss). Empty base
  // (dev proxy) falls back to the current page origin.
  const base = getApiBaseUrl() || window.location.origin
  return base.replace(/^http/, 'ws')
}

/**
 * Why a socket that closed before doing its job failed, worded for the person
 * who has to fix it — or null for an ordinary close after a working session.
 */
export function terminalFailureMessage(info: TerminalCloseInfo): string | null {
  const url = `${wsBaseUrl()}/api/v1/execute/terminal`
  if (info.authFailed) return i18n.t('terminal.authFailed')
  if (info.forbidden) return i18n.t('terminal.forbidden')
  if (info.timedOut) return i18n.t('terminal.wsTimeout', { url, seconds: WS_OPEN_TIMEOUT_MS / 1000 })
  if (info.neverOpened) return i18n.t('terminal.wsRefused', { url })
  return null
}

export interface TerminalSocketOptions {
  projectUid: string
  language: TerminalLanguage
  sessionId?: string
  connectionId?: string
  /** Reopen with a renewed token when the server ends a working session because
   *  its token expired. Only for a socket that may restart its session: Bash gets
   *  a new shell, python/r the same kernel. */
  renewOnExpiry?: boolean
}

export class TerminalSocket {
  private ws: WebSocket | null = null
  private closed = false
  private readonly opts: TerminalSocketOptions
  private readonly handlers: TerminalSocketHandlers

  constructor(opts: TerminalSocketOptions, handlers: TerminalSocketHandlers) {
    this.opts = opts
    this.handlers = handlers
  }

  connect(renewal = false): void {
    const token = localStorage.getItem('linkr-access-token') ?? ''
    const params = new URLSearchParams({
      token,
      projectUid: this.opts.projectUid,
      language: this.opts.language,
    })
    if (this.opts.sessionId) params.set('sessionId', this.opts.sessionId)
    if (this.opts.connectionId) params.set('connectionId', this.opts.connectionId)

    const ws = new WebSocket(`${wsBaseUrl()}/api/v1/execute/terminal?${params}`)
    this.ws = ws

    // A reverse proxy that does not forward WebSocket upgrades can hold the
    // handshake open indefinitely: no open, no close, no console error, and the
    // request never reaches the API. Without a deadline the caller waits forever.
    let opened = false
    let timedOut = false
    const openTimer = setTimeout(() => {
      timedOut = true
      ws.close()
    }, WS_OPEN_TIMEOUT_MS)

    ws.onopen = () => {
      opened = true
      clearTimeout(openTimer)
      if (renewal) this.handlers.onRenewed?.()
      else this.handlers.onOpen?.()
    }
    ws.onmessage = (ev) => {
      try {
        this.handlers.onMessage(JSON.parse(ev.data) as TerminalMessage)
      } catch {
        // Ignore non-JSON frames.
      }
    }
    ws.onclose = (ev) => {
      clearTimeout(openTimer)
      const info: TerminalCloseInfo = {
        authFailed: ev.code === WS_AUTH_FAILED,
        forbidden: ev.code === WS_FORBIDDEN,
        clean: ev.wasClean,
        neverOpened: !opened,
        timedOut,
      }
      if (info.authFailed && opened && this.opts.renewOnExpiry && !this.closed) {
        void this.renew(token, info)
      } else {
        this.handlers.onClose?.(info)
      }
    }
  }

  /** Any authenticated request refreshes an expired token; reopen only if that
   *  produced a different one, so a revoked session ends instead of looping. */
  private async renew(expired: string, info: TerminalCloseInfo): Promise<void> {
    const res = await apiFetch('/api/v1/auth/me', {}, { promptLogin: false }).catch(() => null)
    const token = localStorage.getItem('linkr-access-token')
    if (this.closed) return
    if (res?.ok && token && token !== expired) this.connect(true)
    else this.handlers.onClose?.(info)
  }

  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private send(payload: unknown): void {
    if (this.ready) this.ws!.send(JSON.stringify(payload))
  }

  /** Run a line of code (python / r kernel). */
  runCode(code: string): void {
    this.send({ code })
  }

  /** Send SIGINT to the running kernel (Ctrl+C). */
  interrupt(): void {
    this.send({ interrupt: true })
  }

  /** Feed raw keystrokes to the bash PTY. */
  sendInput(input: string): void {
    this.send({ input })
  }

  /** Match the PTY window size to the browser terminal. */
  resize(rows: number, cols: number): void {
    this.send({ resize: { rows, cols } })
  }

  close(): void {
    this.closed = true
    this.ws?.close()
    this.ws = null
  }
}
