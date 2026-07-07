import { useCallback, useEffect, useState } from 'react'
import { apiRequest, isServerMode } from '@/lib/api-client'

export interface ServerKernel {
  language: 'python' | 'r'
  envId: string
  alive: boolean
  busy: boolean
}

function fetchKernels(projectUid: string): Promise<ServerKernel[]> {
  return apiRequest<ServerKernel[]>(
    `/execute/kernels?projectUid=${encodeURIComponent(projectUid)}`,
  )
}

/**
 * Poll the live server-side kernels for a project (server mode only). Feeds the
 * IDE footer so it reflects real server environments instead of the browser's
 * WASM runtimes. Returns an empty list in front-only mode or without a project.
 */
export function useServerKernels(projectUid: string | null | undefined, intervalMs = 4000) {
  const [kernels, setKernels] = useState<ServerKernel[]>([])
  const enabled = isServerMode() && !!projectUid

  useEffect(() => {
    if (!enabled || !projectUid) return
    let cancelled = false
    const tick = () => {
      fetchKernels(projectUid)
        .then((k) => { if (!cancelled) setKernels(k) })
        .catch(() => { if (!cancelled) setKernels([]) })
    }
    tick()
    const id = setInterval(tick, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [enabled, projectUid, intervalMs])

  // Manual refresh (e.g. after a restart) — no-op when disabled.
  const refresh = useCallback(() => {
    if (!enabled || !projectUid) return
    fetchKernels(projectUid).then(setKernels).catch(() => setKernels([]))
  }, [enabled, projectUid])

  return { kernels: enabled ? kernels : [], refresh }
}
