import { useEffect, useRef, useState } from 'react'
import type { Job } from '@/lib/api/environments'
import { watchJob } from '@/lib/api/suggestion-engines'

// The last state seen of each job followed, so a row that mounts again — the
// dialog reopened, a tab switched back — shows its job at once instead of its
// idle buttons until the first poll answers.
const lastSeen = new Map<string, Job>()

/** A followed job; `unreachable` while the server cannot be reached to poll it. */
export type WatchedJob = Job & { unreachable?: boolean }

const RETRY_MS = 5000

/**
 * Follow a job until it ends. `onEnd` fires once, with the final state, so the
 * caller can reload what the job changed. A failed poll marks the job
 * `unreachable` and is retried until the server answers again.
 */
export function useJob(jobId: string | null, onEnd: (job: Job) => void): WatchedJob | null {
  const [job, setJob] = useState<Job | null>(() => (jobId ? lastSeen.get(jobId) ?? null : null))
  const [unreachableId, setUnreachableId] = useState<string | null>(null)
  const onEndRef = useRef(onEnd)
  useEffect(() => {
    onEndRef.current = onEnd
  })
  useEffect(() => {
    if (!jobId) return
    const controller = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    const follow = () => {
      watchJob(jobId, (j) => {
        lastSeen.set(j.id, j)
        if (controller.signal.aborted) return
        setJob(j)
        setUnreachableId(null)
      }, controller.signal)
        .then((j) => {
          lastSeen.delete(j.id)
          if (!controller.signal.aborted) onEndRef.current(j)
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          console.error('Following job failed', err)
          setUnreachableId(jobId)
          retry = setTimeout(follow, RETRY_MS)
        })
    }
    follow()
    return () => {
      controller.abort()
      clearTimeout(retry)
    }
  }, [jobId])
  if (!jobId) return null
  const current = job?.id === jobId ? job : lastSeen.get(jobId) ?? null
  if (unreachableId !== jobId) return current
  return { ...(current ?? unknownJob(jobId)), unreachable: true }
}

/** A job not seen yet, the server unreachable: shown running, as it most likely is. */
function unknownJob(id: string): Job {
  return {
    id, projectUid: null, workspaceId: null, kind: '', label: '', status: 'running', progress: 0, logTail: '',
    createdAt: '',
  }
}

/** The error a finished job ended on, if it failed. */
export function jobError(job: Job | null): string | null {
  if (!job || job.status !== 'error') return null
  return job.logTail?.split('\n').filter((l) => l.trim()).slice(-3).join('\n') || 'Error'
}
