import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

function fakeDocument(execResult: boolean | 'throw') {
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  }
  const doc = {
    body: { appendChild: vi.fn() },
    activeElement: { focus: vi.fn() },
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => {
      if (execResult === 'throw') throw new Error('unsupported')
      return execResult
    }),
  }
  return { doc, textarea }
}

describe('copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the async clipboard API when it works', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const { doc } = fakeDocument(true)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('document', doc)

    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(doc.execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when the clipboard API is missing (plain HTTP)', async () => {
    const { doc, textarea } = fakeDocument(true)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)

    await expect(copyText('abc')).resolves.toBe(true)
    expect(textarea.value).toBe('abc')
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
    expect(textarea.remove).toHaveBeenCalled()
    expect(doc.activeElement.focus).toHaveBeenCalled()
  })

  it('falls back to execCommand when the clipboard API rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    const { doc } = fakeDocument(true)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('document', doc)

    await expect(copyText('x')).resolves.toBe(true)
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
  })

  it('resolves false when every path fails, without throwing', async () => {
    const { doc, textarea } = fakeDocument('throw')
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)

    await expect(copyText('x')).resolves.toBe(false)
    expect(textarea.remove).toHaveBeenCalled()
  })

  it('resolves false when execCommand reports failure', async () => {
    const { doc } = fakeDocument(false)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)

    await expect(copyText('x')).resolves.toBe(false)
  })
})
