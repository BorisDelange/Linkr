import { useCallback, useEffect, useState } from 'react'

/**
 * `useState` that survives navigation and reload, backed by localStorage.
 *
 * For layout preferences — which panels are open, how wide they are — where the
 * user's arrangement should still be there when they come back, but which are not
 * worth a round-trip to the server and mean nothing on another machine.
 *
 * Every access is wrapped: a private window or blocked site data makes localStorage
 * throw, and a panel that cannot remember its width should still open.
 */
export function useStickyState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* not persisted */ }
  }, [key, value])

  return [value, setValue] as const
}

/** `useStickyState` for a boolean, with a setter that also accepts a plain value. */
export function useStickyFlag(key: string, initial: boolean) {
  const [value, setValue] = useStickyState(key, initial)
  const set = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => setValue(next),
    [setValue],
  )
  return [value, set] as const
}
