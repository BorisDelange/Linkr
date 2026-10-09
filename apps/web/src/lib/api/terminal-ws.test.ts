import { describe, expect, it, vi } from 'vitest'
import { terminalFailureMessage } from './terminal-ws'

vi.mock('@/lib/i18n', () => ({ default: { t: (key: string) => key } }))
vi.stubGlobal('window', { location: { origin: 'http://linkr.test' } })

const closed = { authFailed: false, forbidden: false, clean: true, neverOpened: false, timedOut: false }

describe('terminalFailureMessage', () => {
  it('names a refusal for lack of rights, not a blocked WebSocket', () => {
    expect(terminalFailureMessage({ ...closed, forbidden: true })).toBe('terminal.forbidden')
    expect(terminalFailureMessage({ ...closed, authFailed: true })).toBe('terminal.authFailed')
  })

  it('reads a close before the handshake as a proxy problem', () => {
    expect(terminalFailureMessage({ ...closed, neverOpened: true, clean: false })).toBe('terminal.wsRefused')
  })

  it('says nothing for an ordinary close', () => {
    expect(terminalFailureMessage(closed)).toBeNull()
  })
})
