import { describe, expect, it } from 'vitest'
import { isBinaryBytes, readTextUnlessBinary } from './binary-file'

const enc = new TextEncoder()

describe('isBinaryBytes', () => {
  it('treats valid UTF-8 text as text, accents and emoji included', () => {
    expect(isBinaryBytes(enc.encode('SELECT 1; -- éàü 🎉\n'))).toBe(false)
    expect(isBinaryBytes(new Uint8Array())).toBe(false)
  })

  it('flags a PNG header (0x89 is not a valid UTF-8 lead byte)', () => {
    expect(isBinaryBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
  })

  it('flags a NUL byte even when the rest decodes', () => {
    expect(isBinaryBytes(new Uint8Array([0x50, 0x4b, 0x00, 0x03]))).toBe(true)
  })

  it('flags a truncated multi-byte sequence', () => {
    expect(isBinaryBytes(new Uint8Array([0x61, 0xc3]))).toBe(true)
  })
})

describe('readTextUnlessBinary', () => {
  it('returns the decoded text for a text file', async () => {
    expect(await readTextUnlessBinary(new Blob(['x <- 1 # é']))).toBe('x <- 1 # é')
  })

  it('returns null for a binary file', async () => {
    expect(await readTextUnlessBinary(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]))).toBeNull()
  })
})
