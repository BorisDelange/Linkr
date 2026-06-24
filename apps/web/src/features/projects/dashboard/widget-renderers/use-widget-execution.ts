import { useState, useEffect, useCallback, useRef } from 'react'
import type { RuntimeOutput } from '@/lib/runtimes/types'

/**
 * Module-level cache of widget execution results, keyed by widget id + a signature of its
 * inputs. It outlives component mount/unmount, so switching dashboard tabs (which unmounts the
 * inactive tab's widgets) doesn't re-run R/Python: on remount the widget reads its last result
 * instead of executing again. A new signature (config, code, dataset, or filters changed) misses
 * the cache and re-runs. Forcing a manual rerun bumps a nonce so the same signature re-executes.
 */
const resultCache = new Map<string, RuntimeOutput>()

export function invalidateWidgetResult(widgetId: string) {
  for (const key of resultCache.keys()) {
    if (key.startsWith(`${widgetId}::`)) resultCache.delete(key)
  }
}

interface UseWidgetExecutionArgs {
  widgetId: string
  /** Stable signature of everything that determines the output (config/code/dataset/filters). */
  signature: string
  /** Whether inputs are ready (e.g. dataset columns loaded). When false, nothing runs. */
  ready: boolean
  /** Skip the cache and always re-run when the widget remounts. */
  alwaysReload?: boolean
  run: () => Promise<RuntimeOutput>
}

export function useWidgetExecution({ widgetId, signature, ready, alwaysReload, run }: UseWidgetExecutionArgs) {
  const cacheKey = `${widgetId}::${signature}`
  const cached = alwaysReload ? undefined : resultCache.get(cacheKey)
  const [result, setResult] = useState<RuntimeOutput | null>(cached ?? null)
  const [loading, setLoading] = useState(false)
  const [rerunNonce, setRerunNonce] = useState(0)

  // Keep the latest run() without making it a dependency (it closes over fresh data each render).
  const runRef = useRef(run)
  runRef.current = run

  const execute = useCallback(async () => {
    setLoading(true)
    setResult(null)
    try {
      const output = await runRef.current()
      resultCache.set(cacheKey, output)
      setResult(output)
    } finally {
      setLoading(false)
    }
  }, [cacheKey])

  useEffect(() => {
    if (!ready) return
    // Cache hit (same signature, not a manual rerun): reuse without re-executing.
    const hit = alwaysReload ? undefined : resultCache.get(cacheKey)
    if (hit && rerunNonce === 0) {
      setResult(hit)
      return
    }
    execute()
  }, [ready, cacheKey, alwaysReload, rerunNonce, execute])

  return {
    result,
    loading,
    rerun: () => {
      invalidateWidgetResult(widgetId)
      setRerunNonce((n) => n + 1)
    },
  }
}
