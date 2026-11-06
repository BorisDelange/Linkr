import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeOutput } from '@/lib/runtimes/types'

const apiRequest = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-client', () => ({
  apiRequest,
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

import { ApiError } from '@/lib/api-client'
import { forgetDeclinedCode, useCodeAcceptancePrompt } from '@/stores/code-acceptance-prompt'
import { withCodeAcceptance } from './code-acceptance'

const OK: RuntimeOutput = { stdout: 'ran', stderr: '', figures: [], table: null, html: null }
const REQUIRED = new ApiError(428, JSON.stringify({ detail: { code: 'code_acceptance_required', message: 'no' } }))

/** A run the server refuses until `accepted` holds what the run sends. */
function server(accepted: Set<string>) {
  apiRequest.mockImplementation(async (path: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    if (path === '/code-acceptances') { for (const c of body.codes) accepted.add(c); return undefined }
    if (path === '/code-acceptances/check') return { accepted: accepted.has(body.code) }
    throw new Error(`unexpected ${path}`)
  })
  return (code: string) => vi.fn(async () => {
    if (!accepted.has(code)) throw REQUIRED
    return OK
  })
}

const settle = (accepted: boolean) => useCodeAcceptancePrompt.getState().settle(accepted)
const pending = () => useCodeAcceptancePrompt.getState().pending

beforeEach(() => {
  apiRequest.mockReset()
  forgetDeclinedCode()
  useCodeAcceptancePrompt.setState({ pending: [] })
})

describe('withCodeAcceptance', () => {
  it('runs accepted code without asking anything', async () => {
    const send = server(new Set(['x']))('x')
    await expect(withCodeAcceptance('x', 'python', undefined, send)).resolves.toBe(OK)
    expect(pending()).toEqual([])
  })

  it('never runs stored code before the person accepted it, and shows them that code', async () => {
    const accepted = new Set<string>()
    const send = server(accepted)('x = 1')
    const run = withCodeAcceptance('x = 1', 'python', { label: 'Widget' }, send)
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    expect(pending()[0]).toMatchObject({ code: 'x = 1', language: 'python', label: 'Widget' })
    expect(accepted.size).toBe(0)

    accepted.add('x = 1')
    settle(true)
    await expect(run).resolves.toBe(OK)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not run declined code, and does not ask again until the person retries', async () => {
    const send = server(new Set())('y')
    const run = withCodeAcceptance('y', 'r', undefined, send)
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    settle(false)
    await expect(run).resolves.toMatchObject({ notAccepted: true })
    expect(send).toHaveBeenCalledTimes(1)

    await expect(withCodeAcceptance('y', 'r', undefined, send)).resolves.toMatchObject({ notAccepted: true })
    expect(pending()).toEqual([])

    forgetDeclinedCode()
    void withCodeAcceptance('y', 'r', undefined, send)
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    settle(false)
  })

  it('asks once for widgets holding the same code', async () => {
    const accepted = new Set<string>()
    const send = server(accepted)('z')
    const both = [
      withCodeAcceptance('z', 'python', undefined, send),
      withCodeAcceptance('z', 'python', undefined, send),
    ]
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    accepted.add('z')
    settle(true)
    await expect(Promise.all(both)).resolves.toEqual([OK, OK])
  })

  it('takes code the person is writing without a dialog', async () => {
    const accepted = new Set<string>()
    const send = server(accepted)('mine')
    await expect(withCodeAcceptance('mine', 'python', { authored: true }, send)).resolves.toBe(OK)
    expect(accepted.has('mine')).toBe(true)
    expect(pending()).toEqual([])
  })

  it('covers every configuration of a plugin template the person accepted', async () => {
    const accepted = new Set(['print({{x}})'])
    const send = server(accepted)('print(1)')
    await expect(withCodeAcceptance('print(1)', 'python', { source: 'print({{x}})' }, send)).resolves.toBe(OK)
    expect(pending()).toEqual([])
  })

  it('shows the resolved code of a template nobody accepted', async () => {
    const send = server(new Set())('print(2)')
    void withCodeAcceptance('print(2)', 'python', { source: 'print({{x}})' }, send)
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    expect(pending()[0]).toMatchObject({ code: 'print(2)', source: 'print({{x}})' })
    settle(false)
  })

  it('leaves any other refusal to the caller', async () => {
    const send = vi.fn(async () => { throw new ApiError(403, 'no') })
    await expect(withCodeAcceptance('x', 'python', undefined, send)).rejects.toThrow('no')
    expect(pending()).toEqual([])
  })
})
