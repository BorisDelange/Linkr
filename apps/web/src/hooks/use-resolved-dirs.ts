import { useEffect, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { fsResolvedDirs, type FsResolvedDirs } from '@/lib/api/fs-browser'

/** The absolute server dirs a project's IDE working dir / datasets bind to. Server
 * mode only (front-only has no server filesystem → null). Used for the IDE root
 * hover and the Datasets "Copy path". Refetches when the project changes; callers
 * that mutate the binding pass a `deps` token to force a refresh. */
export function useResolvedDirs(projectUid: string | null, refreshKey?: unknown): FsResolvedDirs | null {
  const [dirs, setDirs] = useState<FsResolvedDirs | null>(null)

  useEffect(() => {
    if (!projectUid || !isServerMode()) {
      setDirs((prev) => (prev === null ? prev : null))
      return
    }
    let cancelled = false
    fsResolvedDirs(projectUid)
      .then((d) => !cancelled && setDirs(d))
      .catch(() => !cancelled && setDirs(null))
    return () => {
      cancelled = true
    }
  }, [projectUid, refreshKey])

  return dirs
}
