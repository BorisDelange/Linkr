import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256, sha256Hex } from './sha256'

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const node = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('sha256, without Web Crypto', () => {
  it('gives the standard digests', () => {
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hex(sha256(new Uint8Array()))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('agrees with a reference at every length around the block and padding boundaries', () => {
    for (let length = 0; length <= 200; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 0xff)
      expect(hex(sha256(bytes))).toBe(node(bytes))
    }
  })

  it('agrees with Web Crypto', async () => {
    const bytes = new TextEncoder().encode('SELECT 1 -- é 🩺')
    expect(await sha256Hex(bytes)).toBe(hex(sha256(bytes)))
  })
})
