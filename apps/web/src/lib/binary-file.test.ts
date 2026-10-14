import { describe, expect, it } from 'vitest'
import { decodeTextUnlessBinary, isBinaryBytes, readTextUnlessBinary } from './binary-file'

const enc = new TextEncoder()

describe('decodeTextUnlessBinary', () => {
  it('decodes valid UTF-8 text, accents and emoji included', () => {
    expect(decodeTextUnlessBinary(enc.encode('SELECT 1; -- éàü 🎉\n'))).toBe('SELECT 1; -- éàü 🎉\n')
  })

  it('treats an empty file as empty text', () => {
    expect(decodeTextUnlessBinary(new Uint8Array())).toBe('')
    expect(isBinaryBytes(new Uint8Array())).toBe(false)
  })

  it('decodes a Latin-1 / cp1252 file (lone 0xE9) as text instead of refusing it', () => {
    expect(decodeTextUnlessBinary(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('café')
    expect(isBinaryBytes(new Uint8Array([0x61, 0xc3]))).toBe(false)
  })

  it('decodes a UTF-16LE file with BOM despite its NUL bytes', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0xe9, 0x00, 0x0a, 0x00])
    expect(decodeTextUnlessBinary(bytes)).toBe('aé\n')
    expect(isBinaryBytes(bytes)).toBe(false)
  })

  it('decodes a UTF-16BE file with BOM', () => {
    expect(decodeTextUnlessBinary(new Uint8Array([0xfe, 0xff, 0x00, 0x61, 0x00, 0xe9]))).toBe('aé')
  })

  it('flags a PNG (NUL in the IHDR chunk length) as binary', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    expect(decodeTextUnlessBinary(png)).toBeNull()
    expect(isBinaryBytes(png)).toBe(true)
  })

  it('flags a NUL byte even when the rest decodes', () => {
    expect(isBinaryBytes(new Uint8Array([0x50, 0x4b, 0x00, 0x03]))).toBe(true)
  })
})

describe('readTextUnlessBinary', () => {
  it('returns the decoded text for a text file', async () => {
    expect(await readTextUnlessBinary(new Blob(['x <- 1 # é']))).toBe('x <- 1 # é')
  })

  it('returns null for a binary file', async () => {
    expect(await readTextUnlessBinary(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])]))).toBeNull()
  })
})
