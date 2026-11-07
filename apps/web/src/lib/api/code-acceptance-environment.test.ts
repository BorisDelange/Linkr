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
import { acceptCode, withCodeAcceptance, withEnvironmentAcceptance } from './code-acceptance'

const OK: RuntimeOutput = { stdout: 'ran', stderr: '', figures: [], table: null, html: null }
const SPEC = '# Python environment of project p\n\n# --- pyproject.toml ---\n[project]\n'

/** A server that builds the environment only once `accepted` holds its spec. */
function server(accepted: Set<string>) {
  apiRequest.mockImplementation(async (path: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    if (path === '/code-acceptances') { for (const c of body.codes) accepted.add(c); return undefined }
    throw new Error(`unexpected ${path}`)
  })
  return vi.fn(async () => {
    if (!accepted.has(SPEC)) {
      throw new ApiError(428, JSON.stringify({
        detail: { code: 'environment_acceptance_required', message: 'no', language: 'python', spec: SPEC },
      }))
    }
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

describe('environment acceptance', () => {
  it('shows the environment spec, even for code the person is writing, and runs once it is accepted', async () => {
    const accepted = new Set<string>()
    const send = server(accepted)
    const run = withCodeAcceptance('1 + 1', 'python', { authored: true }, send)
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    expect(pending()[0]).toMatchObject({ code: SPEC, language: 'python' })
    expect(accepted.size).toBe(0)

    await acceptCode([SPEC])
    settle(true)
    await expect(run).resolves.toBe(OK)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('runs nothing when the person declines the environment', async () => {
    const send = server(new Set())
    const run = withCodeAcceptance('1 + 1', 'python', { authored: true }, send)
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    settle(false)
    await expect(run).resolves.toMatchObject({ notAccepted: true })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('hands a declined refusal back to a caller that is not a run', async () => {
    const send = server(new Set())
    const start = withEnvironmentAcceptance(send)
    await vi.waitFor(() => expect(pending()).toHaveLength(1))
    settle(false)
    await expect(start).rejects.toMatchObject({ status: 428 })
  })
})
