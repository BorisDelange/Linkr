import { useCallback, useEffect, useState } from 'react'
import { apiRequest, isServerMode } from '@/lib/api-client'

export interface ServerKernel {
  language: 'python' | 'r'
  sessionId: string
  alive: boolean
  busy: boolean
  pid: number | null
  rssKb: number | null
  idleSeconds: number
}

/** Shared empty result, so the disabled case keeps a stable identity. */
const EMPTY: ServerKernel[] = []

function fetchKernels(projectUid: string): Promise<ServerKernel[]> {
  return apiRequest<ServerKernel[]>(
    `/execute/kernels?projectUid=${encodeURIComponent(projectUid)}`,
  )
}

/** Keep the previous array when the poll returned nothing the footer would draw
 *  differently, so an unchanged tick doesn't re-render it — and with it every dialog
 *  mounted there (the environments manager lives in the StatusBar tree).
 *
 *  Compared at DISPLAY granularity, not byte equality: `rssKb` is rendered rounded to
 *  MB and `idleSeconds` is not rendered at all, so both drift on every tick for a live
 *  kernel and comparing them raw would never match. */
function sameKernels(a: ServerKernel[], b: ServerKernel[]): boolean {
  if (a.length !== b.length) return false
  const mb = (kb: number | null) => (kb == null ? null : Math.round(kb / 1024))
  return a.every((k, i) => {
    const o = b[i]
    return (
      k.language === o.language &&
      k.sessionId === o.sessionId &&
      k.alive === o.alive &&
      k.busy === o.busy &&
      k.pid === o.pid &&
      mb(k.rssKb) === mb(o.rssKb)
    )
  })
}

/**
 * Poll the live server-side kernels for a project (server mode only). Feeds the
 * IDE footer so it reflects real server environments instead of the browser's
 * WASM runtimes. Returns an empty list in front-only mode or without a project.
 */
export function useServerKernels(projectUid: string | null | undefined, intervalMs = 4000) {
  const [kernels, setKernels] = useState<ServerKernel[]>([])
  const enabled = isServerMode() && !!projectUid

  const apply = useCallback((next: ServerKernel[]) => {
    setKernels((prev) => (sameKernels(prev, next) ? prev : next))
  }, [])

  useEffect(() => {
    if (!enabled || !projectUid) return
    let cancelled = false
    const tick = () => {
      fetchKernels(projectUid)
        .then((k) => { if (!cancelled) apply(k) })
        .catch(() => { if (!cancelled) apply([]) })
    }
    tick()
    const id = setInterval(tick, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [enabled, projectUid, intervalMs, apply])

  // Manual refresh (e.g. after a restart) — no-op when disabled.
  const refresh = useCallback(() => {
    if (!enabled || !projectUid) return
    fetchKernels(projectUid).then(apply).catch(() => apply([]))
  }, [enabled, projectUid, apply])

  // Disabled (off a project, or front-only): report no kernels, but as the SAME empty
  // array every render — a fresh [] here would re-render the footer, and everything
  // mounted in it, on every single render.
  return { kernels: enabled ? kernels : EMPTY, refresh }
}
