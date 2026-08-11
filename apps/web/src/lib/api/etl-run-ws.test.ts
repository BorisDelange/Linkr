import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { runEtlStream, EtlStreamClosedError } from './etl-run-ws'

/**
 * A script's statements must reach the server as ONE message, so they run on one
 * connection and session state (`SET VARIABLE`, temp tables) survives between
 * them. Sending them separately is the bug this transport exists to fix.
 */
class FakeSocket {
  static last: FakeSocket
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.last = this
  }

  send(data: string) { this.sent.push(data) }

  close() {
    this.closed = true
    this.onclose?.()
  }

  open() { this.onopen?.() }
  emit(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  emitRaw(data: string) { this.onmessage?.({ data }) }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('localStorage', { getItem: () => 'tok' })
})
afterEach(() => vi.unstubAllGlobals())

describe('runEtlStream', () => {
  it('sends the whole script in one message', async () => {
    const p = runEtlStream('ds-1', 'SET VARIABLE v = 1; SELECT getvariable(\'v\');', {})
    const ws = FakeSocket.last
    ws.open()
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0]).sql).toBe('SET VARIABLE v = 1; SELECT getvariable(\'v\');')
    ws.emit({ type: 'done', rows: [] })
    await expect(p).resolves.toEqual([])
  })

  it('reports each statement as the server announces it', async () => {
    const seen: Array<[number, number]> = []
    const p = runEtlStream('ds-1', 'A; B;', {}, {}, {
      onStatement: (i, total) => seen.push([i, total]),
    })
    const ws = FakeSocket.last
    ws.open()
    ws.emit({ type: 'statement', index: 0, total: 2, sql: 'A' })
    ws.emit({ type: 'statement', index: 1, total: 2, sql: 'B' })
    ws.emit({ type: 'done', rows: [{ a: 1 }] })
    await expect(p).resolves.toEqual([{ a: 1 }])
    expect(seen).toEqual([[0, 2], [1, 2]])
  })

  it('rejects with the server message on a SQL error', async () => {
    const p = runEtlStream('ds-1', 'BOOM;', {})
    const ws = FakeSocket.last
    ws.open()
    ws.emit({ type: 'error', message: 'Parser Error: syntax error' })
    await expect(p).rejects.toThrow('Parser Error: syntax error')
  })

  it('treats a close without done as a lost run, not an empty result', async () => {
    // Resolving [] here would post "0 rows" as the script's output and make a
    // half-run script look successful.
    const p = runEtlStream('ds-1', 'SELECT 1;', {})
    const ws = FakeSocket.last
    ws.open()
    ws.close()
    await expect(p).rejects.toBeInstanceOf(EtlStreamClosedError)
  })

  it('ignores a frame it cannot parse rather than failing the run', async () => {
    const p = runEtlStream('ds-1', 'SELECT 1;', {})
    const ws = FakeSocket.last
    ws.open()
    ws.emitRaw('not json')
    ws.emit({ type: 'done', rows: [{ ok: true }] })
    await expect(p).resolves.toEqual([{ ok: true }])
  })

  it('closes the socket when the run is aborted', async () => {
    const ctrl = new AbortController()
    const p = runEtlStream('ds-1', 'SELECT 1;', {}, {}, { signal: ctrl.signal })
    const ws = FakeSocket.last
    ws.open()
    ctrl.abort()
    expect(ws.closed).toBe(true)
    await expect(p).rejects.toBeInstanceOf(EtlStreamClosedError)
  })

  it('refuses a signal that is already aborted, without opening a socket', async () => {
    // The caller awaits the role lookup between its own aborted-check and this
    // call, so a Stop can land in that window. Sending the script anyway ran it
    // server-side, and nothing settled the promise until the server closed.
    const ctrl = new AbortController()
    ctrl.abort()
    const before = FakeSocket.last
    const p = runEtlStream('ds-1', 'SELECT 1;', {}, {}, { signal: ctrl.signal })
    await expect(p).rejects.toBeInstanceOf(EtlStreamClosedError)
    expect(FakeSocket.last).toBe(before)
  })

  it('does not resolve twice when done is followed by close', async () => {
    const p = runEtlStream('ds-1', 'SELECT 1;', {})
    const ws = FakeSocket.last
    ws.open()
    ws.emit({ type: 'done', rows: [{ a: 1 }] })
    ws.close()
    await expect(p).resolves.toEqual([{ a: 1 }])
  })
})
