import { useCallback, useEffect, useState } from 'react'

/** How long a re-render (new filters, new config) may run before the result on
 *  screen gives way to the loading state again. Under it, swapping would only
 *  flash; over it, the outdated figures must not pass for the current ones. */
export const RENDER_REFRESH_DELAY_MS = 800

interface RenderFailure {
  key: string | null
  message: string
}

/**
 * Tracks a server render that replaces a result already on screen.
 *
 * `requestKey` identifies what is being asked for (spec + filters), null when
 * nothing is. Call `settle(key)` with the key a response answered — and the
 * error message when it failed; `refreshing` turns true once the current key
 * has gone unanswered for RENDER_REFRESH_DELAY_MS. `failure` is the message of
 * the current key's last answer, cleared as soon as the key changes: going back
 * to a key that failed earlier must not show that old error while it re-renders.
 */
export function useRenderRefresh(requestKey: string | null) {
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const [slowKey, setSlowKey] = useState<string | null>(null)
  const [stored, setStored] = useState<RenderFailure | null>(null)
  const [failureKey, setFailureKey] = useState(requestKey)
  const pending = requestKey != null && settledKey !== requestKey

  if (failureKey !== requestKey) {
    setFailureKey(requestKey)
    setStored(null)
  }

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setSlowKey(requestKey), RENDER_REFRESH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [pending, requestKey])

  const settle = useCallback((key: string | null, error?: string) => {
    setSettledKey(key)
    setStored(error == null ? null : { key, message: error })
  }, [])

  return {
    refreshing: pending && slowKey === requestKey,
    settle,
    failure: stored?.key === requestKey ? stored.message : null,
  }
}
