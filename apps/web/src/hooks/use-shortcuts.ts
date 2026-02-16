import { useEffect } from 'react'
import { useShortcutStore } from '@/stores/shortcut-store'
import type { ShortcutActionId, KeyCombo } from '@/types/shortcuts'

/** Check if a keyboard event matches a KeyCombo */
export function matchesCombo(event: KeyboardEvent, combo: KeyCombo): boolean {
  const modKey = event.metaKey || event.ctrlKey
  return (
    event.key.toLowerCase() === combo.key.toLowerCase() &&
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
      // Skip if typing in an input/textarea (but not Monaco)
      const target = event.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      for (const [id, handler] of Object.entries(handlers)) {
        const actionId = id as ShortcutActionId
        const def = shortcuts[actionId]
        if (!def || def.scope !== 'global') continue
        if (matchesCombo(event, def.binding)) {
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
