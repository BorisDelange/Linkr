/**
 * Read the entries of a zip File without loading it into memory.
 *
 * JSZip reads the whole archive into one buffer, which an ATHENA download — a
 * gigabyte zip of multi-gigabyte CSVs — does not survive. Here only the central
 * directory (at the end of the file) is read up front; an entry is then
 * inflated as a stream through the browser's native `DecompressionStream`, and
 * its bytes gathered into a Blob the browser may keep on disk. Zip64 (archives
 * or entries past 4 GB) is supported; encryption and methods other than stored
 * and deflate are not.
 */

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  encrypted: boolean
}

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const U32_MAX = 0xffffffff
/** End-of-central-directory record (22) + the longest comment (65535). */
const EOCD_SEARCH = 22 + 0xffff
/** Fold gathered chunks into the Blob at this size, so they can be released. */
const FOLD_BYTES = 32 * 1024 * 1024

async function view(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer())
}

function u64(v: DataView, at: number): number {
  return Number(v.getBigUint64(at, true))
}

export function isZipName(name: string): boolean {
  return name.toLowerCase().endsWith('.zip')
}

export async function listZipEntries(file: Blob): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, file.size - EOCD_SEARCH)
  const tail = await view(file, tailStart, file.size)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not a zip archive.')

  let count = tail.getUint16(eocd + 10, true)
  let cdSize = tail.getUint32(eocd + 12, true)
  let cdOffset = tail.getUint32(eocd + 16, true)
  const locator = eocd - 20
  if (locator >= 0 && tail.getUint32(locator, true) === ZIP64_LOCATOR_SIG) {
    const at = u64(tail, locator + 8)
    const z = await view(file, at, at + 56)
    if (z.getUint32(0, true) !== ZIP64_EOCD_SIG) throw new Error('Corrupt zip64 archive.')
    count = u64(z, 32)
    cdSize = u64(z, 40)
    cdOffset = u64(z, 48)
  }

  const cd = await view(file, cdOffset, cdOffset + cdSize)
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let p = 0
  for (let n = 0; n < count; n++) {
    if (cd.getUint32(p, true) !== CENTRAL_SIG) throw new Error('Corrupt zip central directory.')
    const flags = cd.getUint16(p + 8, true)
    const method = cd.getUint16(p + 10, true)
    let compressedSize = cd.getUint32(p + 20, true)
    let uncompressedSize = cd.getUint32(p + 24, true)
    const nameLen = cd.getUint16(p + 28, true)
    const extraLen = cd.getUint16(p + 30, true)
    const commentLen = cd.getUint16(p + 32, true)
    let localHeaderOffset = cd.getUint32(p + 42, true)
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen))

    // The zip64 extra field holds, in this order, only the values whose 32-bit
    // slot is saturated.
    let e = p + 46 + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true)
      const size = cd.getUint16(e + 2, true)
      if (id === 0x0001) {
        let q = e + 4
        if (uncompressedSize === U32_MAX) { uncompressedSize = u64(cd, q); q += 8 }
        if (compressedSize === U32_MAX) { compressedSize = u64(cd, q); q += 8 }
        if (localHeaderOffset === U32_MAX) { localHeaderOffset = u64(cd, q) }
      }
      e += 4 + size
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, encrypted: (flags & 1) !== 0 })
    p = extraEnd + commentLen
  }
  return entries
}

/** One entry's content, inflated, as a File named after the entry's basename. */
export async function extractZipEntry(file: Blob, entry: ZipEntry): Promise<File> {
  if (entry.encrypted) throw new Error(`${entry.name} is encrypted.`)
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: unsupported compression.`)
  const local = await view(file, entry.localHeaderOffset, entry.localHeaderOffset + 30)
  if (local.getUint32(0, true) !== LOCAL_SIG) throw new Error('Corrupt zip local header.')
  const start = entry.localHeaderOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true)
  const raw = file.slice(start, start + entry.compressedSize).stream()
  const stream = entry.method === 8 ? raw.pipeThrough(new DecompressionStream('deflate-raw')) : raw

  let blob = new Blob([])
  let pending: Uint8Array<ArrayBuffer>[] = []
  let pendingBytes = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending.push(value as Uint8Array<ArrayBuffer>)
    pendingBytes += value.byteLength
    if (pendingBytes >= FOLD_BYTES) {
      blob = new Blob([blob, ...pending])
      pending = []
      pendingBytes = 0
    }
  }
  return new File([blob, ...pending], entry.name.split('/').pop() ?? entry.name)
}
