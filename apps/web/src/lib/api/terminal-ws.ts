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
 * travels as ?token=. There is no WS equivalent of the fetch token-refresh; on
 * an auth close (code 4401) we surface an error and do NOT reconnect.
 */
import { getApiBaseUrl } from '@/lib/api-client'

export type TerminalLanguage = 'python' | 'r' | 'bash'

/** Close code the backend uses for an auth failure (ws_auth.WS_AUTH_FAILED). */
export const WS_AUTH_FAILED = 4401

export interface TerminalMessage {
  type: 'stdout' | 'stderr' | 'output' | 'done' | 'exit' | 'error'
  data?: string
  message?: string
  figures?: unknown[]
  table?: unknown
  html?: string | null
}

export interface TerminalSocketHandlers {
  onMessage: (msg: TerminalMessage) => void
  onOpen?: () => void
  /** Called once when the socket closes. `authFailed` is true on code 4401. */
  onClose?: (info: { authFailed: boolean; clean: boolean }) => void
}

function wsBaseUrl(): string {
  // Derive the WS origin from VITE_API_URL (http→ws, https→wss). Empty base
  // (dev proxy) falls back to the current page origin.
  const base = getApiBaseUrl() || window.location.origin
  return base.replace(/^http/, 'ws')
}

export interface TerminalSocketOptions {
  projectUid: string
  language: TerminalLanguage
  sessionId?: string
  connectionId?: string
}

export class TerminalSocket {
  private ws: WebSocket | null = null
  private readonly opts: TerminalSocketOptions
  private readonly handlers: TerminalSocketHandlers

  constructor(opts: TerminalSocketOptions, handlers: TerminalSocketHandlers) {
    this.opts = opts
    this.handlers = handlers
  }

  connect(): void {
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

    ws.onopen = () => this.handlers.onOpen?.()
    ws.onmessage = (ev) => {
      try {
        this.handlers.onMessage(JSON.parse(ev.data) as TerminalMessage)
      } catch {
        // Ignore non-JSON frames.
      }
    }
    ws.onclose = (ev) => {
      this.handlers.onClose?.({ authFailed: ev.code === WS_AUTH_FAILED, clean: ev.wasClean })
    }
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
    this.ws?.close()
    this.ws = null
  }
}
