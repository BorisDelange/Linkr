import { beforeEach, describe, expect, it } from 'vitest'
import { forgetDeclinedCode, requestCodeAcceptance, useCodeAcceptancePrompt } from './code-acceptance-prompt'

const settle = (accepted: boolean) => useCodeAcceptancePrompt.getState().settle(accepted)

describe('code acceptance prompt', () => {
  beforeEach(() => {
    settle(false)
    forgetDeclinedCode()
  })

  it('gathers every request made while the prompt is open under one answer', async () => {
    const a = requestCodeAcceptance({ code: 'a()', language: 'python' })
    const again = requestCodeAcceptance({ code: 'a()', language: 'python' })
    const b = requestCodeAcceptance({ code: 'b()', language: 'r' })
    expect(useCodeAcceptancePrompt.getState().pending.map((p) => p.code)).toEqual(['a()', 'b()'])
    settle(true)
    expect(await Promise.all([a, again, b])).toEqual([true, true, true])
    expect(useCodeAcceptancePrompt.getState().pending).toEqual([])
  })

  it('keeps declined code declined, without asking, until the person asks for a run', async () => {
    const first = requestCodeAcceptance({ code: 'x()', language: 'python' })
    settle(false)
    expect(await first).toBe(false)
    expect(await requestCodeAcceptance({ code: 'x()', language: 'python' })).toBe(false)
    expect(useCodeAcceptancePrompt.getState().pending).toEqual([])

    forgetDeclinedCode()
    const asked = requestCodeAcceptance({ code: 'x()', language: 'python' })
    expect(useCodeAcceptancePrompt.getState().pending.map((p) => p.code)).toEqual(['x()'])
    settle(true)
    expect(await asked).toBe(true)
  })

  it('opens a new prompt for code asked after the previous answer', async () => {
    const first = requestCodeAcceptance({ code: 'one()', language: 'python' })
    settle(true)
    await first
    const second = requestCodeAcceptance({ code: 'two()', language: 'python' })
    expect(useCodeAcceptancePrompt.getState().pending.map((p) => p.code)).toEqual(['two()'])
    settle(false)
    expect(await second).toBe(false)
  })
})
