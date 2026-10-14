const utf8 = new TextDecoder('utf-8', { fatal: true })
const utf16le = new TextDecoder('utf-16le')
const utf16be = new TextDecoder('utf-16be')
const cp1252 = new TextDecoder('windows-1252')

function utf16Bom(bytes: Uint8Array): 'le' | 'be' | null {
  if (bytes.length < 2) return null
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'be'
  return null
}

/**
 * The bytes as text, or null when they cannot be held as text without loss.
 *
 * A NUL byte is the one reliable binary marker (every PNG, ZIP, Parquet, JPEG
 * carries one early) — except in UTF-16, where every ASCII character has one, so
 * a BOM'd UTF-16 file is decoded as such before the NUL check. Bytes that are
 * not valid UTF-8 are not binary either: a cp1252 or Latin-1 script (`é` as a
 * lone 0xE9) is text an editor must show, so it falls back to windows-1252, which
 * maps every byte. Decoding such a file with `File.text()` would instead turn
 * each bad byte into U+FFFD.
 */
export function decodeTextUnlessBinary(bytes: Uint8Array): string | null {
  const bom = utf16Bom(bytes)
  if (bom) return (bom === 'le' ? utf16le : utf16be).decode(bytes)
  if (bytes.includes(0)) return null
  try {
    return utf8.decode(bytes)
  } catch {
    return cp1252.decode(bytes)
  }
}

export function isBinaryBytes(bytes: Uint8Array): boolean {
  return decodeTextUnlessBinary(bytes) === null
}

/** The file's text, or null when it is binary (see decodeTextUnlessBinary). Reads it once. */
export async function readTextUnlessBinary(file: Blob): Promise<string | null> {
  return decodeTextUnlessBinary(new Uint8Array(await file.arrayBuffer()))
}
