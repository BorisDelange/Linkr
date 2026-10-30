import { useEffect, useRef, useState } from 'react'
import type { Job } from '@/lib/api/environments'
import { watchJob } from '@/lib/api/suggestion-engines'

// The last state seen of each job followed, so a row that mounts again — the
// dialog reopened, a tab switched back — shows its job at once instead of its
// idle buttons until the first poll answers.
const lastSeen = new Map<string, Job>()

/**
 * Follow a job until it ends. `onEnd` fires once, with the final state, so the
 * caller can reload what the job changed.
 */
export function useJob(jobId: string | null, onEnd: (job: Job) => void): Job | null {
  const [job, setJob] = useState<Job | null>(() => (jobId ? lastSeen.get(jobId) ?? null : null))
  const onEndRef = useRef(onEnd)
  useEffect(() => {
    onEndRef.current = onEnd
  })
  useEffect(() => {
    if (!jobId) return
    const controller = new AbortController()
    watchJob(jobId, (j) => {
      lastSeen.set(j.id, j)
      if (!controller.signal.aborted) setJob(j)
    }, controller.signal)
      .then((j) => {
        lastSeen.delete(j.id)
        if (!controller.signal.aborted) onEndRef.current(j)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [jobId])
  if (!jobId) return null
  return job?.id === jobId ? job : lastSeen.get(jobId) ?? null
}

/** The error a finished job ended on, if it failed. */
export function jobError(job: Job | null): string | null {
  if (!job || job.status !== 'error') return null
  return job.logTail?.split('\n').filter((l) => l.trim()).slice(-3).join('\n') || 'Error'
}
