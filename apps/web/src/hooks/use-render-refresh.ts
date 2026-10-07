import { useEffect, useState } from 'react'

/** How long a re-render (new filters, new config) may run before the result on
 *  screen gives way to the loading state again. Under it, swapping would only
 *  flash; over it, the outdated figures must not pass for the current ones. */
export const RENDER_REFRESH_DELAY_MS = 800

/**
 * Tracks a server render that replaces a result already on screen.
 *
 * `requestKey` identifies what is being asked for (spec + filters), null when
 * nothing is. Call `settle(key)` with the key a response answered; `refreshing`
 * turns true once the current key has gone unanswered for RENDER_REFRESH_DELAY_MS.
 */
export function useRenderRefresh(requestKey: string | null) {
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const [slowKey, setSlowKey] = useState<string | null>(null)
  const pending = requestKey != null && settledKey !== requestKey

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setSlowKey(requestKey), RENDER_REFRESH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [pending, requestKey])

  return { refreshing: pending && slowKey === requestKey, settle: setSettledKey }
}
