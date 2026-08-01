import type { KeyCombo } from '@/types/shortcuts'

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')

/** A key combo as display parts, e.g. ['⌘', 'Shift', 'J'] (Mac) / ['Ctrl', …]. */
export function comboToDisplay(combo: KeyCombo): string[] {
  const parts: string[] = []
  if (combo.ctrlOrMeta) parts.push(isMac ? '⌘' : 'Ctrl')
  if (combo.shift) parts.push('Shift')
  if (combo.alt) parts.push(isMac ? '⌥' : 'Alt')
  const key =
    combo.key === 'Enter'
      ? '↵'
      : combo.key === '`'
        ? '`'
        : combo.key.length === 1
          ? combo.key.toUpperCase()
          : combo.key
  parts.push(key)
  return parts
}

/** A key combo as a compact string, e.g. "⌘⇧J" (Mac) / "Ctrl+Shift+J". Empty when
 *  the combo is unbound. */
export function comboToString(combo: KeyCombo): string {
  if (!combo.key) return ''
  return isMac ? comboToDisplay(combo).join('') : comboToDisplay(combo).join('+')
}
