import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { extractZipEntry, listZipEntries } from './zip-entries'

const CONCEPT = 'concept_id\tconcept_name\n1\tHeart rate\n2\tPulse "radial\n'.repeat(500)

async function zipOf(files: Record<string, string>, compression: 'DEFLATE' | 'STORE'): Promise<Blob> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return new Blob([await zip.generateAsync({ type: 'arraybuffer', compression })])
}

describe('zip entries', () => {
  it.each(['DEFLATE', 'STORE'] as const)('lists and extracts %s entries', async (compression) => {
    const blob = await zipOf({ 'CONCEPT.csv': CONCEPT, 'vocab/VOCABULARY.csv': 'vocabulary_id\nLOINC\n', 'readme.txt': 'x' }, compression)
    const entries = await listZipEntries(blob)
    expect(entries.map((e) => e.name).filter((n) => !n.endsWith('/')).sort())
      .toEqual(['CONCEPT.csv', 'readme.txt', 'vocab/VOCABULARY.csv'])

    const concept = await extractZipEntry(blob, entries.find((e) => e.name === 'CONCEPT.csv')!)
    expect(concept.name).toBe('CONCEPT.csv')
    expect(await concept.text()).toBe(CONCEPT)

    const vocabulary = await extractZipEntry(blob, entries.find((e) => e.name === 'vocab/VOCABULARY.csv')!)
    expect(vocabulary.name).toBe('VOCABULARY.csv')
    expect(await vocabulary.text()).toBe('vocabulary_id\nLOINC\n')
  })

  it('reads an archive with a trailing comment', async () => {
    const zip = new JSZip()
    zip.file('CONCEPT.csv', CONCEPT)
    const blob = new Blob([await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', comment: 'ATHENA download' })])
    const [entry] = await listZipEntries(blob)
    expect(await (await extractZipEntry(blob, entry)).text()).toBe(CONCEPT)
  })

  it('reads zip64 sizes, offsets and end record', async () => {
    // A stored entry written the way an archive past 4 GB is: every 32-bit
    // field saturated, the real values in zip64 extra fields and end record.
    const name = new TextEncoder().encode('CONCEPT.csv')
    const data = new TextEncoder().encode(CONCEPT)
    const bytes: number[] = []
    const u16 = (v: number) => bytes.push(v & 0xff, (v >> 8) & 0xff)
    const u32 = (v: number) => { u16(v & 0xffff); u16(Math.floor(v / 0x10000)) }
    const u64 = (v: number) => { u32(v % 0x100000000); u32(Math.floor(v / 0x100000000)) }
    const zip64Extra = (offset?: number) => {
      u16(0x0001); u16(offset === undefined ? 16 : 24)
      u64(data.length); u64(data.length)
      if (offset !== undefined) u64(offset)
    }

    u32(0x04034b50); u16(45); u16(0); u16(0); u32(0); u32(0)
    u32(0xffffffff); u32(0xffffffff); u16(name.length); u16(20)
    bytes.push(...name); zip64Extra(); bytes.push(...data)

    const cdOffset = bytes.length
    u32(0x02014b50); u16(45); u16(45); u16(0); u16(0); u32(0); u32(0)
    u32(0xffffffff); u32(0xffffffff); u16(name.length); u16(28); u16(0)
    u16(0); u16(0); u32(0); u32(0xffffffff)
    bytes.push(...name); zip64Extra(0)
    const cdSize = bytes.length - cdOffset

    const zip64Eocd = bytes.length
    u32(0x06064b50); u64(44); u16(45); u16(45); u32(0); u32(0)
    u64(1); u64(1); u64(cdSize); u64(cdOffset)
    u32(0x07064b50); u32(0); u64(zip64Eocd); u32(1)
    u32(0x06054b50); u16(0); u16(0); u16(0xffff); u16(0xffff)
    u32(0xffffffff); u32(0xffffffff); u16(0)

    const blob = new Blob([new Uint8Array(bytes)])
    const [entry] = await listZipEntries(blob)
    expect(entry).toMatchObject({ name: 'CONCEPT.csv', method: 0, compressedSize: data.length, uncompressedSize: data.length, localHeaderOffset: 0 })
    expect(await (await extractZipEntry(blob, entry)).text()).toBe(CONCEPT)
  })

  it('rejects a file that is not a zip', async () => {
    await expect(listZipEntries(new Blob(['concept_id\n1\n']))).rejects.toThrow('Not a zip archive.')
  })
})
