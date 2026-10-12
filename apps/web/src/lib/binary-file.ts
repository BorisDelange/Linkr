const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Whether these bytes cannot be held as text without loss: a NUL byte, or a
 *  sequence that is not valid UTF-8. Decoding such a file with `File.text()`
 *  silently turns each bad byte into U+FFFD, which is how a PNG gets corrupted. */
export function isBinaryBytes(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true
  try {
    utf8.decode(bytes)
    return false
  } catch {
    return true
  }
}

/** The file's text, or null when it is binary (see isBinaryBytes). Reads it once. */
export async function readTextUnlessBinary(file: Blob): Promise<string | null> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return isBinaryBytes(bytes) ? null : utf8.decode(bytes)
}
