import { useEffect } from 'react'
import { useShortcutStore } from '@/stores/shortcut-store'
import type { ShortcutActionId, KeyCombo } from '@/types/shortcuts'

/** The physical `event.code` a single-character combo key maps to, or null for
 * special keys (Enter, F8, `\``…) that we still match on `event.key`. Using the
 * physical code makes Alt combos work: ⌥N yields event.key "~" but code "KeyN". */
function physicalCode(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return null
}

/** Check if a keyboard event matches a KeyCombo */
export function matchesCombo(event: KeyboardEvent, combo: KeyCombo): boolean {
  const modKey = event.metaKey || event.ctrlKey
  const code = physicalCode(combo.key)
  const keyMatches = code
    ? event.code === code
    : event.key.toLowerCase() === combo.key.toLowerCase()
  return (
    keyMatches &&
    modKey === combo.ctrlOrMeta &&
    event.shiftKey === combo.shift &&
    event.altKey === combo.alt
  )
}

/** Map of action IDs to handler callbacks */
export type ShortcutHandlers = Partial<Record<ShortcutActionId, () => void>>

/**
 * Registers global keyboard shortcuts (scope: 'global').
 * Handlers must be stabilized with useMemo or useCallback.
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  const shortcuts = useShortcutStore((s) => s.shortcuts)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable

      for (const [id, handler] of Object.entries(handlers)) {
        const actionId = id as ShortcutActionId
        const def = shortcuts[actionId]
        if (!def || def.scope !== 'global') continue
        if (matchesCombo(event, def.binding)) {
          // When typing in an input/textarea/editor (Monaco uses a hidden
          // textarea), only skip bare shortcuts — a Cmd/Ctrl combo is never
          // text entry, so global actions (new file, toggle sidebar…) still fire.
          if (inInput && !def.binding.ctrlOrMeta) return
          event.preventDefault()
          handler()
          return
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcuts, handlers])
}
