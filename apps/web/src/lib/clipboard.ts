/**
 * Copies `text` to the clipboard and resolves to whether it worked. Never throws:
 * `navigator.clipboard` is undefined outside a secure context (a server reached
 * over plain HTTP) and its promise rejects when permission is refused, so both
 * fall back to a hidden textarea + `execCommand('copy')`.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Refused or unavailable: try the legacy path below.
    }
  }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const previousFocus = document.activeElement as HTMLElement | null
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  try {
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    previousFocus?.focus?.()
  }
}
