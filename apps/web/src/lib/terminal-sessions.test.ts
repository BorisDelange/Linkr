import { describe, expect, it, vi } from 'vitest'
import { disposeAllLiveTerminals, getLiveTerminal, registerLiveTerminal, type LiveTerminal } from './terminal-sessions'

describe('disposeAllLiveTerminals', () => {
  it('ends every kept terminal so nothing can re-attach to it', () => {
    const entries = ['a', 'b'].map((key) => {
      const entry = { signature: key, dispose: vi.fn() } as unknown as LiveTerminal
      registerLiveTerminal(key, entry)
      return entry
    })
    disposeAllLiveTerminals()
    for (const e of entries) expect(e.dispose).toHaveBeenCalledOnce()
    expect(getLiveTerminal('a')).toBeUndefined()
    expect(getLiveTerminal('b')).toBeUndefined()
  })
})
